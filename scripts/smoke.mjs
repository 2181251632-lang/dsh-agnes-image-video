// 离线冒烟测试：用假的 ctx / 假 fetch 跑一遍两个工具的 execute，
// 把参数校验、错误映射、落盘、render 都走通，不真的花钱。
//
// 每个用例都新建工具实例：冷却状态挂在实例上（跟 trae 的 image-tool 一样），
// 复用实例会让上一个用例的失败把下一个用例挡成 COOLDOWN。
//
// 用法：node scripts/smoke.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { createAgnesImageTool } from '../lib/image-tool.js'
import { createAgnesVideoTool } from '../lib/video-tool.js'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// 最小可用的 MP4 头（ftyp + 一点数据），够魔数识别。没有 moov，所以读不出尺寸，
// 会退回按 aspect_ratio 查表 —— 这也正是「读不出就查表」这条兜底的用例。
const MP4_HEAD = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2', 'ascii'),
  Buffer.alloc(64, 0x11),
])

// 造一个带 moov/trak/tkhd 的 MP4，用来验「像素尺寸从 tkhd 读」。
// tkhd v0 的宽高在 body + 76 / + 80，是 16.16 定点数。
// box 的 size 字段必须等于整个 box 的字节数，否则遍历会走歪，所以统一用 box() 算。
function box(type, body) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + body.length, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, body])
}

function mp4WithSize(width, height) {
  const ftypBody = Buffer.concat([
    Buffer.from('isom', 'ascii'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isomiso2mp41', 'ascii'),
  ])
  const tkhdBody = Buffer.alloc(84, 0)
  tkhdBody.writeUInt32BE(width * 65536, 76)
  tkhdBody.writeUInt32BE(height * 65536, 80)
  return Buffer.concat([
    box('ftyp', ftypBody),
    box('moov', box('trak', box('tkhd', tkhdBody))),
  ])
}

const calls = []
let respond = () => {
  throw new Error('respond 未设置')
}

globalThis.fetch = async (url, init = {}) => {
  const body = typeof init.body === 'string' ? init.body : undefined
  calls.push({ url: String(url), method: init.method ?? 'GET', body })
  return respond(String(url), init, body)
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

function bytesResponse(bytes, status = 200) {
  return new Response(bytes, { status, headers: { 'Content-Type': 'application/octet-stream' } })
}

const cwd = await mkdtemp(join(tmpdir(), 'agnes-smoke-'))
process.env.AGNES_API_KEY = 'sk-smoke-test'
// 设置页的默认值存在 %DSH_HOME%\agnes-media\settings.json。指向临时目录，
// 这样本机改过的默认值不会把「不传参数就是 1K + 1:1」这条断言弄红。
process.env.DSH_HOME = cwd

const logger = { warn() {}, info() {}, error() {} }
const ctx = { get: () => undefined, logger }
const exec = { signal: new AbortController().signal, cwd }

/** 每个用例都要新的实例，冷却状态才不会串味。 */
const newImageTool = (overrideCtx) => createAgnesImageTool({ ctx: overrideCtx ?? ctx, logger })
const newVideoTool = () => createAgnesVideoTool({ ctx, logger })

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log('OK   ' + label)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + label + ' → ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)))
  }
}

async function expectCode(label, fn, code) {
  try {
    await fn()
  } catch (error) {
    assert.equal(error.code, code, label + ' 期望 ' + code + '，实际 ' + error.code + '（' + error.message + '）')
    return error
  }
  throw new Error(label + ' 期望抛 ' + code + '，但没有抛')
}

// ── 工具定义形状 ───────────────────────────────────────────────
await check('image tool 定义完整', () => {
  const tool = newImageTool()
  assert.equal(tool.name, 'agnes_image_generate')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['prompt'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(tool.timeoutMs > 0)
  for (const key of ['prompt', 'size', 'ratio', 'image']) {
    assert.ok(tool.parameters.properties[key], '缺参数 ' + key)
  }
})

await check('video tool 定义完整', () => {
  const tool = newVideoTool()
  assert.equal(tool.name, 'agnes_video_generate')
  assert.deepEqual(tool.parameters.required, ['prompt'])
  for (const key of ['prompt', 'mode', 'seconds', 'aspect_ratio', 'first_frame', 'last_frame', 'images', 'audios', 'seed']) {
    assert.ok(tool.parameters.properties[key], '缺参数 ' + key)
  }
  assert.ok(!tool.parameters.properties.videos, 'Flash 不支持 videos，不该暴露')
})

// ── 文生图 ────────────────────────────────────────────────────
await check('文生图：请求体与落盘', async () => {
  const tool = newImageTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/images/generations')) {
      return jsonResponse({ created: 1, data: [{ url: 'https://cdn.example/a.png', b64_json: '', revised_prompt: '' }], task_id: 'task_x' })
    }
    return bytesResponse(PNG_1PX)
  }
  const value = await tool.execute({ prompt: '一只玻璃立方体', size: '2K', ratio: '16:9' }, exec)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.model, 'agnes-image-2.5-flash')
  assert.equal(sent.size, '2K')
  assert.equal(sent.ratio, '16:9')
  assert.equal(sent.response_format, undefined, 'response_format 不能出现在顶层')
  assert.equal(sent.extra_body.response_format, 'url')
  assert.equal(sent.extra_body.image, undefined)
  assert.equal(value.pixels, '2624x1472')
  assert.equal(value.mimeType, 'image/png')
  assert.equal(value.taskId, 'task_x')
  assert.ok(value.path.startsWith('agnes-images/'))
  const bytes = await readFile(value.absolutePath)
  assert.equal(bytes.length, PNG_1PX.length)
  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('![') && blocks[0].text.includes(value.path))
})

await check('默认档位：不传 size/ratio 就是 1K + 1:1', async () => {
  const tool = newImageTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/z.png' }] })
    return bytesResponse(PNG_1PX)
  }
  const value = await tool.execute({ prompt: 'x' }, exec)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.size, '1K')
  assert.equal(sent.ratio, '1:1')
  assert.equal(value.pixels, '1024x1024')
})

await check('图生图：参考图进 extra_body.image，且不带 tags', async () => {
  const tool = newImageTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/b.png' }], task_id: 'task_y' })
    return bytesResponse(PNG_1PX)
  }
  const value = await tool.execute(
    { prompt: '改成赛博朋克夜景', image: ['https://example.com/in.png', 'data:image/png;base64,AAAA'] },
    exec,
  )
  const sent = JSON.parse(calls[0].body)
  assert.deepEqual(sent.extra_body.image, ['https://example.com/in.png', 'data:image/png;base64,AAAA'])
  assert.equal(sent.tags, undefined, '图生图不该传 tags')
  assert.equal(value.referenceCount, 2)
})

await check('图生图：本地路径转成 Data URI', async () => {
  const tool = newImageTool()
  calls.length = 0
  await writeFile(join(cwd, 'local.png'), PNG_1PX)
  respond = (url) => {
    if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/c.png' }] })
    return bytesResponse(PNG_1PX)
  }
  await tool.execute({ prompt: '改一下', image: ['local.png'] }, exec)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.extra_body.image.length, 1)
  assert.ok(sent.extra_body.image[0].startsWith('data:image/png;base64,'))
})

// ── 图片端错误 ────────────────────────────────────────────────
await check('参数错误：非法 size 在本地就被挡下', async () => {
  await expectCode('bad size', () => newImageTool().execute({ prompt: 'x', size: 'banana' }, exec), 'INVALID_ARGS')
})

await check('参数错误：非法 ratio 在本地就被挡下', async () => {
  await expectCode('bad ratio', () => newImageTool().execute({ prompt: 'x', ratio: '5:7' }, exec), 'INVALID_ARGS')
})

await check('参数错误：prompt 为空', async () => {
  await expectCode('empty prompt', () => newImageTool().execute({ prompt: '   ' }, exec), 'INVALID_ARGS')
})

await check('参数错误不进冷却：改完能立刻重试', async () => {
  const tool = newImageTool()
  await expectCode('bad size', () => tool.execute({ prompt: 'x', size: 'banana' }, exec), 'INVALID_ARGS')
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/ok.png' }] })
    return bytesResponse(PNG_1PX)
  }
  const value = await tool.execute({ prompt: 'x' }, exec)
  assert.ok(value.path.startsWith('agnes-images/'))
})

await check('401 → AUTH，且错误体按图片形状解析', async () => {
  calls.length = 0
  respond = () => jsonResponse({ error: { code: '', message: '无效的令牌 (request id: abc)', type: 'AgnesAI_error' } }, 401)
  const error = await expectCode('401', () => newImageTool().execute({ prompt: 'x' }, exec), 'AUTH')
  assert.ok(error.message.includes('无效的令牌'), '丢了上游消息：' + error.message)
})

await check('400 → INVALID_ARGS，错误体按图片形状解析出中文', async () => {
  calls.length = 0
  respond = () =>
    jsonResponse(
      { error: { message: 'size 的值 "banana" 无效，必须是 1K、2K、3K、4K 或 WIDTHxHEIGHT (request id: r1)', type: 'invalid_request', param: '', code: 'invalid_request' } },
      400,
    )
  const error = await expectCode('400', () => newImageTool().execute({ prompt: 'x' }, exec), 'INVALID_ARGS')
  assert.ok(error.message.includes('无效'), '错误文案丢了上游消息：' + error.message)
})

await check('取回的不是图片 → MEDIA_UNAVAILABLE', async () => {
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/expired' }] })
    return bytesResponse(Buffer.from('<html>AccessDenied</html>'))
  }
  const error = await expectCode('html', () => newImageTool().execute({ prompt: 'x' }, exec), 'MEDIA_UNAVAILABLE')
  assert.ok(error.message.includes('费用已经产生'), '这类失败必须说清钱已经花了：' + error.message)
})

await check('响应里没有 url → EMPTY_RESULT', async () => {
  calls.length = 0
  respond = () => jsonResponse({ data: [{}], task_id: 'task_e' })
  await expectCode('no url', () => newImageTool().execute({ prompt: 'x' }, exec), 'EMPTY_RESULT')
})

// ── 冷却 ──────────────────────────────────────────────────────
await check('计费类失败之后立刻重试会被 COOLDOWN 挡下', async () => {
  const tool = newImageTool()
  calls.length = 0
  respond = () => jsonResponse({ error: { message: '无效的令牌', code: '', type: 'AgnesAI_error' } }, 401)
  await expectCode('401', () => tool.execute({ prompt: 'x' }, exec), 'AUTH')
  const error = await expectCode('cooldown', () => tool.execute({ prompt: 'x' }, exec), 'COOLDOWN')
  assert.ok(/秒后才能再试/.test(error.message), error.message)
})

// ── 视频 ──────────────────────────────────────────────────────
await check('视频 text 模式：创建 + 轮询到 completed + 落盘', async () => {
  const tool = newVideoTool()
  calls.length = 0
  let polls = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) {
      return jsonResponse({
        id: 'task_v1', video_id: 'task_v1', task_id: 'task_v1',
        object: 'video', model: 'agnes-video-2.5-flash',
        status: 'queued', progress: 0, seconds: '4', size: '720P', quality: 'standard',
      })
    }
    if (url.includes('/agnesapi')) {
      polls += 1
      if (polls < 2) {
        return jsonResponse({ id: 'task_v1', status: 'in_progress', progress: 40, internal_status: 'pending', internal_progress: 0 })
      }
      return jsonResponse({
        id: 'task_v1', status: 'completed', progress: 100,
        url: 'https://cdn.example/v.mp4', seconds: '4', size: '720P',
        internal_status: 'pending', internal_progress: 0, error: null,
      })
    }
    return bytesResponse(MP4_HEAD)
  }
  const value = await tool.execute({ prompt: '雨后的街道', mode: 'text', seconds: 4 }, exec)
  const created = JSON.parse(calls[0].body)
  assert.equal(created.model, 'agnes-video-2.5-flash')
  assert.equal(created.mode, 'text')
  assert.equal(created.size, '720P', 'size 必须是 720P')
  assert.equal(created.seconds, '4', 'seconds 要发字符串')
  assert.equal(created.n, 1)
  assert.equal(created.aspect_ratio, '16:9')
  assert.ok(calls.some((call) => call.url.includes('model_name=agnes-video-2.5-flash')), '轮询要带 model_name')
  assert.equal(value.mimeType, 'video/mp4')
  assert.equal(value.videoId, 'task_v1')
  assert.equal(value.pixels, '1280x720')
  assert.ok(value.path.startsWith('agnes-videos/'))
  assert.ok(tool.output.render({}, value)[0].text.includes(value.path))
})

// 实测坑：keyframe 模式传 aspect_ratio 16:9、首帧是方图时，上游出的是 720x720。
// 所以 pixels 必须读 mp4 的 tkhd，不能查 aspect_ratio 表 —— 否则会谎报尺寸。
await check('视频 pixels 读 mp4 真实尺寸，不照 aspect_ratio 表报', async () => {
  const tool = newVideoTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_sq', status: 'queued', progress: 0 })
    if (url.includes('/agnesapi')) return jsonResponse({ id: 'task_sq', status: 'completed', progress: 100, url: 'https://cdn.example/sq.mp4' })
    return bytesResponse(mp4WithSize(720, 720))
  }
  const value = await tool.execute({ prompt: 'x', mode: 'text', aspect_ratio: '16:9' }, exec)
  assert.equal(value.aspectRatio, '16:9')
  assert.equal(value.pixels, '720x720', '真实尺寸压过 aspect_ratio 查表')
})

await check('视频读不出 tkhd 尺寸时退回 aspect_ratio 查表', async () => {
  const tool = newVideoTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_nf', status: 'queued', progress: 0 })
    if (url.includes('/agnesapi')) return jsonResponse({ id: 'task_nf', status: 'completed', progress: 100, url: 'https://cdn.example/nf.mp4' })
    return bytesResponse(MP4_HEAD) // 没有 moov，读不出尺寸
  }
  const value = await tool.execute({ prompt: 'x', mode: 'text', aspect_ratio: '9:16' }, exec)
  assert.equal(value.pixels, '720x1280')
})

await check('视频轮询遇 429 会退让而不是失败', async () => {
  const tool = newVideoTool()
  calls.length = 0
  let polls = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_v2', status: 'queued', progress: 0 })
    if (url.includes('/agnesapi')) {
      polls += 1
      if (polls === 1) return jsonResponse({ error: { code: 429, message: '查询过于频繁，请稍后重试 (request id: r2)' } }, 429)
      return jsonResponse({ id: 'task_v2', status: 'completed', progress: 100, url: 'https://cdn.example/v2.mp4' })
    }
    return bytesResponse(MP4_HEAD)
  }
  const value = await tool.execute({ prompt: 'x', mode: 'text' }, exec)
  assert.equal(value.videoId, 'task_v2')
})

await check('视频 text 模式带素材：本地先挡下', async () => {
  await expectCode('text+images', () => newVideoTool().execute({ prompt: 'x', mode: 'text', images: ['https://e/1.png'] }, exec), 'INVALID_ARGS')
})

await check('视频 keyframe 无帧：本地先挡下', async () => {
  await expectCode('keyframe none', () => newVideoTool().execute({ prompt: 'x', mode: 'keyframe' }, exec), 'INVALID_ARGS')
})

await check('视频 keyframe 带 images：本地先挡下', async () => {
  await expectCode(
    'keyframe+images',
    () => newVideoTool().execute({ prompt: 'x', mode: 'keyframe', first_frame: 'https://e/f.png', images: ['https://e/1.png'] }, exec),
    'INVALID_ARGS',
  )
})

await check('视频 reference 无素材：本地先挡下', async () => {
  await expectCode('reference none', () => newVideoTool().execute({ prompt: 'x', mode: 'reference' }, exec), 'INVALID_ARGS')
})

await check('视频 reference 带首帧：本地先挡下', async () => {
  await expectCode(
    'reference+frame',
    () => newVideoTool().execute({ prompt: 'x', mode: 'reference', first_frame: 'https://e/f.png', images: ['https://e/1.png'] }, exec),
    'INVALID_ARGS',
  )
})

await check('视频 images 超过 5 张：本地先挡下', async () => {
  await expectCode(
    'images 6',
    () => newVideoTool().execute({ prompt: 'x', mode: 'reference', images: Array.from({ length: 6 }, (_, i) => 'https://e/' + i + '.png') }, exec),
    'INVALID_ARGS',
  )
})

await check('视频 audios 超过 3 段：本地先挡下', async () => {
  await expectCode(
    'audios 4',
    () => newVideoTool().execute({ prompt: 'x', mode: 'reference', audios: Array.from({ length: 4 }, (_, i) => 'https://e/' + i + '.mp3') }, exec),
    'INVALID_ARGS',
  )
})

await check('视频 seconds 越界：本地先挡下', async () => {
  await expectCode('seconds 13', () => newVideoTool().execute({ prompt: 'x', mode: 'text', seconds: 13 }, exec), 'INVALID_ARGS')
})

await check('视频 aspect_ratio 非法：本地先挡下', async () => {
  await expectCode('ratio', () => newVideoTool().execute({ prompt: 'x', mode: 'text', aspect_ratio: '5:7' }, exec), 'INVALID_ARGS')
})

await check('视频 mode 自动推断：给 first_frame → keyframe', async () => {
  const tool = newVideoTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_v3', status: 'queued' })
    if (url.includes('/agnesapi')) return jsonResponse({ id: 'task_v3', status: 'completed', progress: 100, url: 'https://cdn.example/v3.mp4' })
    return bytesResponse(MP4_HEAD)
  }
  await tool.execute({ prompt: 'x', first_frame: 'https://e/f.png' }, exec)
  const created = JSON.parse(calls[0].body)
  assert.equal(created.mode, 'keyframe')
  assert.equal(created.first_frame, 'https://e/f.png')
})

await check('视频 mode 自动推断：给 images → reference', async () => {
  const tool = newVideoTool()
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_v5', status: 'queued' })
    if (url.includes('/agnesapi')) return jsonResponse({ id: 'task_v5', status: 'completed', progress: 100, url: 'https://cdn.example/v5.mp4' })
    return bytesResponse(MP4_HEAD)
  }
  await tool.execute({ prompt: 'x', images: ['https://e/1.png'] }, exec)
  const created = JSON.parse(calls[0].body)
  assert.equal(created.mode, 'reference')
  assert.deepEqual(created.images, ['https://e/1.png'])
})

await check('视频任务 failed → TASK_FAILED 且带上游原因', async () => {
  calls.length = 0
  respond = (url) => {
    if (url.includes('/v1/videos')) return jsonResponse({ video_id: 'task_v4', status: 'queued' })
    return jsonResponse({ id: 'task_v4', status: 'failed', progress: 100, error: { message: '内容审核未通过' } })
  }
  const error = await expectCode('failed', () => newVideoTool().execute({ prompt: 'x', mode: 'text' }, exec), 'TASK_FAILED')
  assert.ok(error.message.includes('内容审核未通过'), error.message)
})

await check('队列已满（video_queue_full）→ QUEUE_FULL', async () => {
  calls.length = 0
  respond = () => jsonResponse({ code: 'video_queue_full', message: '视频队列已满，请稍后重试 (request id: r3)', data: null }, 400)
  await expectCode('queue full', () => newVideoTool().execute({ prompt: 'x', mode: 'text' }, exec), 'QUEUE_FULL')
})

// 实测上游是用 503 报队列满的，不是 400。这条单独钉住，否则回归会悄悄把它
// 变回 UPSTREAM，让一次本来没花钱的调用被冷却 30 秒。
await check('队列已满用 HTTP 503 报 → 仍然是 QUEUE_FULL，不是 UPSTREAM', async () => {
  calls.length = 0
  respond = () => jsonResponse({ code: 'video_queue_full', message: '视频队列已满，请稍后重试 (request id: r3b)', data: null }, 503)
  const error = await expectCode(
    'queue full 503',
    () => newVideoTool().execute({ prompt: 'x', mode: 'text' }, exec),
    'QUEUE_FULL',
  )
  assert.ok(error.message.includes('视频队列已满'), error.message)
})

await check('队列满之后立刻重试不会被冷却挡住（没建任务、没扣费）', async () => {
  const tool = newVideoTool()
  calls.length = 0
  respond = () => jsonResponse({ code: 'video_queue_full', message: '视频队列已满 (request id: r3c)', data: null }, 503)
  await expectCode('queue full', () => tool.execute({ prompt: 'x', mode: 'text' }, exec), 'QUEUE_FULL')
  // 同一个实例立刻再调一次：如果队列满被误判成可计费失败，这里会抛 COOLDOWN。
  // 第二次让它建任务成功但一直排队，然后用 abort 掐断，避免真的等 10 分钟。
  respond = () => jsonResponse({ id: 'task_retry', video_id: 'task_retry', status: 'queued', progress: 0 }, 200)
  const controller = new AbortController()
  const abortedExec = { signal: controller.signal, cwd }
  setTimeout(() => controller.abort(), 120)
  const error = await expectCode('retry after queue full', () => tool.execute({ prompt: 'x', mode: 'text' }, abortedExec), 'TASK_TIMEOUT')
  assert.ok(!error.message.includes('COOLDOWN'), error.message)
})

await check('视频创建 400 参数错误 → INVALID_ARGS，中文消息与参数名都保留', async () => {
  calls.length = 0
  respond = () =>
    jsonResponse({ code: 'invalid_request', message: 'size 必须是 720P 之一 (request id: r4)', data: { param: 'size', valid_sizes: ['720P'] } }, 400)
  const error = await expectCode('400', () => newVideoTool().execute({ prompt: 'x', mode: 'text' }, exec), 'INVALID_ARGS')
  assert.ok(error.message.includes('720P'), error.message)
  assert.ok(error.message.includes('参数 size'), '没带上出错参数：' + error.message)
})

// ── key ──────────────────────────────────────────────────────
await check('没有 key → NOT_LOGGED_IN', async () => {
  const saved = process.env.AGNES_API_KEY
  delete process.env.AGNES_API_KEY
  try {
    await expectCode('no key', () => newImageTool().execute({ prompt: 'x' }, exec), 'NOT_LOGGED_IN')
  } finally {
    process.env.AGNES_API_KEY = saved
  }
})

await check('凭据服务能提供 key 时正常发请求', async () => {
  const saved = process.env.AGNES_API_KEY
  delete process.env.AGNES_API_KEY
  try {
    const credCtx = {
      get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-from-store', source: 'record' }) } : undefined),
      logger,
    }
    const tool = newImageTool(credCtx)
    calls.length = 0
    respond = (url) => {
      if (url.includes('/v1/images/generations')) return jsonResponse({ data: [{ url: 'https://cdn.example/d.png' }] })
      return bytesResponse(PNG_1PX)
    }
    await tool.execute({ prompt: 'x' }, exec)
    assert.equal(calls[0].method, 'POST')
  } finally {
    process.env.AGNES_API_KEY = saved
  }
})

await rm(cwd, { recursive: true, force: true })

if (failures > 0) {
  console.log('\n' + failures + ' 项失败')
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}
