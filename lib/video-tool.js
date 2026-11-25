// `agnes_video_generate`：文生视频 / 首尾帧控制 / 图片与音频参考。
//
// 视频是异步任务：创建拿到 video_id，然后轮询到 completed 才拿得到 mp4。
// 两个实测坑写在这里，别照文档抄：
//   1) 文档说 1–2 秒轮询一次，实际 3 秒就会间歇 429。这里起步 5 秒，遇 429 再退让。
//   2) 校验错误体是 { code, message, data:{param,...} }，不是文档里的 { detail }。

import { AgnesError, isBillableFailure, messageOf } from './errors.js'
import { AGNES_BASE_URL, AGNES_VIDEO_MODEL, downloadBytes, getJson, postJson } from './client.js'
import { readSettings } from './settings.js'
import {
  classifyMediaRef,
  hexPrefix,
  localFileToDataUri,
  mediaMimeTypeOf,
  saveMedia,
  videoPixelSizeOf,
} from './media.js'

export const AGNES_VIDEO_TOOL_NAME = 'agnes_video_generate'

// 实测一条 4 秒视频约 2 分钟出片；队列繁忙时会久得多，所以给足 10 分钟。
const VIDEO_TOOL_TIMEOUT_MS = 6e5
const FAILURE_COOLDOWN_MS = 3e4
const VIDEO_DIR = 'agnes-videos'

const MODES = ['text', 'keyframe', 'reference']
const ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
// 六档全部实测过（scripts/live-aspect-audit.mjs，读 mp4 里 tkhd 的真实宽高）：
//   21:9 1470x630 · 16:9 1280x720 · 4:3 1112x834 · 1:1 960x960 · 3:4 834x1112 · 9:16 720x1280
// 这套值和 Agnes Video 2.5 主文档的 720P 表完全一致。Agnes Video 2.5 Flash 那一页另有一张表
// （21:9 1680x720 / 16:9 1280x704 / 4:3 960x720 / 1:1 720x720 / 3:4 720x960），六行里五行是错的，
// 不要照它写。反正最终尺寸以 mp4 里的 tkhd 为准，这张表只是读不出宽高时的兜底。
const ASPECT_PIXELS = {
  '21:9': '1470x630',
  '16:9': '1280x720',
  '4:3': '1112x834',
  '1:1': '960x960',
  '3:4': '834x1112',
  '9:16': '720x1280',
}

const MIN_SECONDS = 4
const MAX_SECONDS = 12
const MAX_IMAGES = 5
const MAX_AUDIOS = 3

const FIRST_POLL_DELAY_MS = 5e3
const POLL_INTERVAL_MS = 5e3
const POLL_BACKOFF_MS = 1e4
const MAX_POLL_INTERVAL_MS = 2e4

function sessionCwdOf(exec) {
  const session = exec?.agent?.session
  return (
    session?.workingDirectory ??
    session?.header?.cwd ??
    session?.cwd ??
    exec?.cwd ??
    process.cwd()
  )
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new AgnesError('调用被取消', 'TASK_TIMEOUT'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new AgnesError('调用被取消', 'TASK_TIMEOUT'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 单张媒体引用 → 上游能取的形式。本地文件读成 Data URI（实测 first_frame 接受）。 */
async function resolveOne(reference, cwd, kind) {
  const classified = classifyMediaRef(reference)
  if (classified.kind === 'url' || classified.kind === 'data-uri') return classified.value
  if (classified.kind === 'path') return await localFileToDataUri(classified.value, cwd, kind)
  throw new AgnesError(
    (kind === 'audio' ? '音频' : '图片') + '引用既不是 URL、也不是 Data URI、也不是文件路径：' + String(reference).slice(0, 120),
    'INVALID_ARGS',
  )
}

async function resolveMany(list, cwd, kind, field, max) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new AgnesError(field + ' 必须是字符串数组', 'INVALID_ARGS')
  if (list.length > max) {
    throw new AgnesError(field + ' 最多 ' + max + ' 个，收到 ' + list.length + ' 个', 'INVALID_ARGS')
  }
  const resolved = []
  for (const item of list) resolved.push(await resolveOne(item, cwd, kind))
  return resolved
}

function hasItems(list) {
  return Array.isArray(list) && list.length > 0
}

/** 首尾帧是单个字符串（模型偶尔会塞成单元素数组），这里统一问「给没给」。 */
function hasFrame(value) {
  if (Array.isArray(value)) return value.length > 0 && String(value[0] ?? '').trim() !== ''
  return typeof value === 'string' && value.trim() !== ''
}

/** 没给 mode 时按素材推断：有帧就用 keyframe，有图/音就用 reference，否则 text。 */
function inferMode(args) {
  if (hasFrame(args?.first_frame) || hasFrame(args?.last_frame)) return 'keyframe'
  if (hasItems(args?.images) || hasItems(args?.audios)) return 'reference'
  return 'text'
}

function normalizeFrame(value, field) {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    if (value.length > 1) throw new AgnesError(field + ' 只能给一个地址', 'INVALID_ARGS')
    return value[0]
  }
  const text = String(value).trim()
  return text === '' ? undefined : text
}

function normalizeSeconds(value, fallback) {
  if (value === undefined || value === null || value === '') return String(fallback)
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new AgnesError('seconds 必须是数字，收到 "' + String(value) + '"', 'INVALID_ARGS')
  }
  const rounded = Math.round(numeric)
  if (rounded < MIN_SECONDS || rounded > MAX_SECONDS) {
    throw new AgnesError(
      'seconds 只能在 ' + MIN_SECONDS + '–' + MAX_SECONDS + ' 秒之间，收到 ' + String(value),
      'INVALID_ARGS',
    )
  }
  return String(rounded)
}

export function createAgnesVideoTool(deps) {
  let cooldownUntil = 0

  return {
    name: AGNES_VIDEO_TOOL_NAME,
    description: [
      '用 Agnes Video 2.5 Flash 生成视频，输出固定 720P，结果保存到会话工作目录的 agnes-videos/ 下。',
      '三种模式：mode=text 纯文字生成；mode=keyframe 用 first_frame / last_frame 控制首尾帧（至少给一个）；mode=reference 用 images（最多 5 张）或 audios（最多 3 段）当参考，prompt 里可以用 <Picture 1>、<Audio 1> 指代它们。',
      'mode 可以不填：给了 first_frame 或 last_frame 就当 keyframe，给了 images 或 audios 就当 reference，都没给就是 text。填了就要和素材对得上——text 不能带素材，keyframe 不能带 images/audios，reference 不能带首尾帧。',
      '所有图片和音频引用都可以是公网 https 地址、data:...;base64，或会话目录下的本地文件路径（本地文件会读成 Data URI 发给上游）；上游不支持视频参考，videos 参数没有暴露。',
      'seconds 是 4–12 的整数，不传就用设置页里存的默认值（出厂 5）；画幅用 aspect_ratio，同样有设置页默认值（出厂 16:9）。出片是异步任务，实测一条 4 秒视频约 2 分钟，工具会自己轮询到完成再返回，所以调用会比较久。',
      '这不是免费操作：刊例 ¥0.15/秒（当前天使用户体验价 ¥0），重跑同一个 prompt 就是再计一次费。',
      '需要 API Key：环境变量 AGNES_API_KEY，或 DSH 凭据库里的 AGENS_API_KEY，与图片工具共用同一把。',
      '失败码：NOT_LOGGED_IN / INVALID_ARGS 没有发到上游，改完可以直接重试；AUTH、RATE_LIMIT、UPSTREAM、TASK_FAILED、TASK_TIMEOUT、MEDIA_UNAVAILABLE 之后 30 秒内再调用会被 COOLDOWN 挡下。队列已满（QUEUE_FULL）也可以立刻重试——那种情况上游没有建任务，也没有计费。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '画面里发生什么：主体、动作、镜头运动、环境、光线、氛围。reference 模式可以用 <Picture 1>、<Audio 1> 指代第几张参考图、第几段参考音频。',
        },
        mode: {
          type: 'string',
          enum: MODES,
          description:
            'text 纯文字生成；keyframe 首尾帧控制；reference 图片/音频参考。不填会按给了哪些素材自动推断，设置页里的默认 mode 只在素材能对上时生效。',
        },
        seconds: {
          type: 'number',
          description: '时长，4–12 的整数秒，不传就用设置页里的默认值（出厂 5）。越长越贵。',
        },
        aspect_ratio: {
          type: 'string',
          enum: ASPECT_RATIOS,
          description:
            '画幅，不传就用设置页里的默认值（出厂 16:9）。720P 档的实际输出像素（六档全实测）：21:9→1470x630、16:9→1280x720、4:3→1112x834、1:1→960x960、3:4→834x1112、9:16→720x1280。keyframe 模式下画幅跟首帧走，可能和这里给的不一样，返回值里的 pixels 读的是 mp4 里的真实宽高。',
        },
        first_frame: {
          type: 'string',
          description: '首帧图片（仅 keyframe）。公网 https 地址、data:image/...;base64，或会话目录下的本地图片路径。',
        },
        last_frame: {
          type: 'string',
          description: '尾帧图片（仅 keyframe）。首帧和尾帧至少给一个。',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图片（仅 reference），最多 5 张。地址形式同 first_frame。',
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: '参考音频（仅 reference），最多 3 段，支持 mp3/wav/m4a/aac/ogg/flac。',
        },
        seed: {
          type: 'number',
          description: '随机种子，想让两次结果接近时固定它；不填就是随机的。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对会话工作目录的视频路径' },
          absolutePath: { type: 'string' },
          prompt: { type: 'string' },
          mode: { type: 'string' },
          seconds: { type: 'string' },
          aspectRatio: { type: 'string' },
          pixels: { type: 'string' },
          mimeType: { type: 'string' },
          bytes: { type: 'number' },
          model: { type: 'string' },
          videoId: { type: 'string' },
          waitSeconds: { type: 'number', description: '从创建到出片实际等待的秒数' },
        },
        required: ['path', 'absolutePath', 'prompt', 'mode', 'seconds', 'aspectRatio', 'pixels', 'mimeType', 'bytes', 'model', 'videoId'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [
          {
            type: 'text',
            text:
              '已生成视频（' + value.mode + ' / ' + value.seconds + ' 秒 / ' + value.aspectRatio + ' → ' + value.pixels +
              '，' + formatBytes(value.bytes) + '，等待 ' + value.waitSeconds + ' 秒）：' + value.path +
              '\n[播放或下载视频](' + value.path + ')',
          },
        ]
      },
    },
    timeoutMs: VIDEO_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const now = Date.now()
      if (now < cooldownUntil) {
        const seconds = Math.ceil((cooldownUntil - now) / 1000)
        throw new AgnesError(
          '上一次调用失败了，' + seconds + ' 秒后才能再试。重试会再计一次费，先确认参数再重发。',
          'COOLDOWN',
        )
      }

      try {
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new AgnesError('prompt 不能为空', 'INVALID_ARGS')

        // 设置页里存的默认值：每次都重新读文件，改完立刻生效，不做模块级缓存。
        const defaults = await readSettings()

        const mode = (() => {
          if (args?.mode !== undefined && args?.mode !== null && args?.mode !== '') {
            return String(args.mode).trim().toLowerCase()
          }
          const preferred = defaults.video.mode
          if (preferred !== '') {
            // 设置页里的默认 mode 只当「用户没给线索时」的偏好：
            // 一旦这次调用带了只有别的模式才认的素材，就以素材为准，
            // 否则用户会莫名其妙被自己的默认值挡住。
            const fits =
              (preferred === 'keyframe' && (hasFrame(args?.first_frame) || hasFrame(args?.last_frame))) ||
              (preferred === 'reference' && (hasItems(args?.images) || hasItems(args?.audios))) ||
              (preferred === 'text' &&
                !hasFrame(args?.first_frame) &&
                !hasFrame(args?.last_frame) &&
                !hasItems(args?.images) &&
                !hasItems(args?.audios))
            if (fits) return preferred
          }
          return inferMode(args)
        })()
        if (!MODES.includes(mode)) {
          throw new AgnesError('mode 只能是 ' + MODES.join('、') + '，收到 "' + String(args?.mode) + '"', 'INVALID_ARGS')
        }

        const aspectRatio = (() => {
          const raw = args?.aspect_ratio
          if (raw === undefined || raw === null || raw === '') return defaults.video.aspectRatio
          const text = String(raw).trim()
          const hit = ASPECT_RATIOS.find((item) => item === text)
          if (hit === undefined) {
            throw new AgnesError('aspect_ratio 只能是 ' + ASPECT_RATIOS.join('、') + '，收到 "' + text + '"', 'INVALID_ARGS')
          }
          return hit
        })()

        const seconds = normalizeSeconds(args?.seconds, defaults.video.seconds)
        const cwd = sessionCwdOf(exec)

        const firstFrame = normalizeFrame(args?.first_frame, 'first_frame')
        const lastFrame = normalizeFrame(args?.last_frame, 'last_frame')
        const rawImages = args?.images
        const rawAudios = args?.audios

        // 模式与素材的一致性在本地先判一遍：这样错误在计费之前就返回，
        // 用户看到的也是人话，而不是上游那句「xxx 模式不能包含素材字段」。
        if (mode === 'text') {
          if (firstFrame !== undefined || lastFrame !== undefined || hasItems(rawImages) || hasItems(rawAudios)) {
            throw new AgnesError('mode=text 不能带 first_frame / last_frame / images / audios，要去掉素材或改用 keyframe / reference', 'INVALID_ARGS')
          }
        }
        if (mode === 'keyframe') {
          if (firstFrame === undefined && lastFrame === undefined) {
            throw new AgnesError('mode=keyframe 需要 first_frame 或 last_frame 至少一个', 'INVALID_ARGS')
          }
          if (hasItems(rawImages) || hasItems(rawAudios)) {
            throw new AgnesError('mode=keyframe 不能带 images / audios，参考素材请改用 mode=reference', 'INVALID_ARGS')
          }
        }
        if (mode === 'reference') {
          if (firstFrame !== undefined || lastFrame !== undefined) {
            throw new AgnesError('mode=reference 不能带 first_frame / last_frame，首尾帧请改用 mode=keyframe', 'INVALID_ARGS')
          }
          if (!hasItems(rawImages) && !hasItems(rawAudios)) {
            throw new AgnesError('mode=reference 需要 images 或 audios 至少一类非空', 'INVALID_ARGS')
          }
        }

        const images = mode === 'reference' ? await resolveMany(rawImages, cwd, 'image', 'images', MAX_IMAGES) : []
        const audios = mode === 'reference' ? await resolveMany(rawAudios, cwd, 'audio', 'audios', MAX_AUDIOS) : []
        const resolvedFirst = firstFrame === undefined ? undefined : await resolveOne(firstFrame, cwd, 'image')
        const resolvedLast = lastFrame === undefined ? undefined : await resolveOne(lastFrame, cwd, 'image')

        const body = {
          model: AGNES_VIDEO_MODEL,
          prompt,
          mode,
          seconds,
          // Flash 只认这一个值，写别的直接 400。
          size: '720P',
          aspect_ratio: aspectRatio,
          n: 1,
        }
        if (resolvedFirst !== undefined) body.first_frame = resolvedFirst
        if (resolvedLast !== undefined) body.last_frame = resolvedLast
        if (images.length > 0) body.images = images
        if (audios.length > 0) body.audios = audios
        if (typeof args?.seed === 'number' && Number.isFinite(args.seed)) body.seed = Math.trunc(args.seed)

        const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(VIDEO_TOOL_TIMEOUT_MS)])
        const startedAt = Date.now()
        const created = await postJson(deps.ctx, '/v1/videos', body, signal, 'Agnes 视频创建')

        const videoId =
          (typeof created?.video_id === 'string' && created.video_id) ||
          (typeof created?.id === 'string' && created.id) ||
          (typeof created?.task_id === 'string' && created.task_id) ||
          ''
        if (videoId === '') {
          throw new AgnesError('Agnes 视频创建: 响应里没有 video_id，任务可能已经创建但无法查询', 'EMPTY_RESULT')
        }

        // model_name 对 keyframe / reference 是必需的，对 text 也可带，所以一律带上。
        const pollUrl =
          AGNES_BASE_URL + '/agnesapi?video_id=' + encodeURIComponent(videoId) +
          '&model_name=' + encodeURIComponent(AGNES_VIDEO_MODEL)

        let interval = POLL_INTERVAL_MS
        await sleep(FIRST_POLL_DELAY_MS, signal)
        let lastStatus = 'queued'
        let lastProgress = 0
        let url = ''

        for (;;) {
          const { status: httpStatus, json } = await getJson(deps.ctx, pollUrl, signal, 'Agnes 视频查询')
          if (httpStatus === 429) {
            // 查询太频繁：退让一次，不算失败，也不重复创建任务。
            interval = Math.min(interval + POLL_BACKOFF_MS, MAX_POLL_INTERVAL_MS)
            await sleep(interval, signal)
            continue
          }
          const status = typeof json?.status === 'string' ? json.status : ''
          if (typeof json?.progress === 'number') lastProgress = json.progress
          if (status !== '') lastStatus = status

          if (status === 'completed') {
            url = typeof json?.url === 'string' ? json.url : ''
            if (url === '') {
              throw new AgnesError('Agnes 视频查询: 任务已完成但响应里没有 url（video_id ' + videoId + '）', 'EMPTY_RESULT')
            }
            break
          }
          if (status === 'failed' || status === 'cancelled') {
            const reason =
              (typeof json?.error?.message === 'string' && json.error.message) ||
              (typeof json?.error === 'string' && json.error) ||
              '上游没有给原因'
            throw new AgnesError(
              'Agnes 视频任务' + (status === 'failed' ? '失败' : '被取消') + '（video_id ' + videoId + '）：' + reason,
              'TASK_FAILED',
            )
          }
          await sleep(interval, signal)
        }

        const bytes = await downloadBytes(url, signal, 'Agnes 视频下载')
        const mimeType = mediaMimeTypeOf(bytes)
        if (mimeType === undefined || !mimeType.startsWith('video/')) {
          throw new AgnesError(
            'Agnes 视频下载: 取回的不是视频（前 4 字节 ' + hexPrefix(bytes) + '，' + bytes.length + ' 字节）。' +
            '费用已经产生，结果地址在 ' + url,
            'MEDIA_UNAVAILABLE',
          )
        }

        const saved = await saveMedia(cwd, VIDEO_DIR, 'agnes', bytes, mimeType, 'Agnes 视频保存')
        return {
          path: saved.relativePath,
          absolutePath: saved.absolutePath,
          prompt,
          mode,
          seconds,
          aspectRatio,
          // 先读 mp4 自己的 tkhd 尺寸；读不出才退回按 aspect_ratio 查表。
          // keyframe 模式画幅跟首帧走，查表会把尺寸报错。
          pixels: videoPixelSizeOf(bytes) ?? ASPECT_PIXELS[aspectRatio],
          mimeType,
          bytes: bytes.length,
          model: AGNES_VIDEO_MODEL,
          videoId,
          waitSeconds: Math.round((Date.now() - startedAt) / 1000),
        }
      } catch (error) {
        if (isBillableFailure(error)) cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        deps.logger?.warn?.('agnes_video_generate 失败：' + messageOf(error))
        throw error
      }
    },
  }
}

function formatBytes(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}
