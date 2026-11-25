// `agnes_image_generate`：文生图 / 图生图 / 多图合成。
//
// 形状照抄 dsh-connect-trae 的 image-tool：一个返回普通对象的工厂，
// 对象自带 name / description / parameters / output / timeoutMs / execute。
// 不 import 任何宿主类型 —— 工具定义是纯 JSON Schema，宿主只认这个。

import { AgnesError, isBillableFailure, messageOf } from './errors.js'
import { AGNES_IMAGE_MODEL, downloadBytes, postJson } from './client.js'
import { readSettings } from './settings.js'
import {
  classifyMediaRef,
  hexPrefix,
  localFileToDataUri,
  mediaMimeTypeOf,
  saveMedia,
} from './media.js'

export const AGNES_IMAGE_TOOL_NAME = 'agnes_image_generate'

const IMAGE_TOOL_TIMEOUT_MS = 18e4
const FAILURE_COOLDOWN_MS = 3e4
const IMAGE_DIR = 'agnes-images'

const SIZES = ['1K', '2K', '3K', '4K']
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']

// 上游只认这几个档位配这几个比例。写出来是为了让报错能说清「你给的是哪个」，
// 而不是把 400 原样抛给用户。
const SIZE_TABLE = {
  '1K': { '1:1': '1024x1024', '3:4': '864x1152', '4:3': '1152x864', '16:9': '1312x736', '9:16': '736x1312', '2:3': '832x1248', '3:2': '1248x832', '21:9': '1568x672' },
  '2K': { '1:1': '2048x2048', '3:4': '1728x2304', '4:3': '2304x1728', '16:9': '2624x1472', '9:16': '1472x2624', '2:3': '1664x2496', '3:2': '2496x1664', '21:9': '3136x1344' },
  '3K': { '1:1': '3072x3072', '3:4': '2592x3456', '4:3': '3456x2592', '16:9': '3936x2208', '9:16': '2208x3936', '2:3': '2496x3744', '3:2': '3744x2496', '21:9': '4704x2016' },
  '4K': { '1:1': '4096x4096', '3:4': '3456x4608', '4:3': '4608x3456', '16:9': '5248x2944', '9:16': '2944x5248', '2:3': '3328x4992', '3:2': '4992x3328', '21:9': '6272x2688' },
}

/** 会话工作目录：优先 agent 上的，再退到 session 字段，最后用进程 cwd。 */
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

function pickOne(value, allowed, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim()
  const hit = allowed.find((item) => item.toLowerCase() === text.toLowerCase())
  if (hit === undefined) {
    throw new AgnesError(
      field + ' 只能是 ' + allowed.join('、') + '，收到的是 "' + text + '"',
      'INVALID_ARGS',
    )
  }
  return hit
}

/** 把参考图列表转成上游能直接取的形式：URL / Data URI 原样留，本地路径读成 Data URI。 */
async function resolveReferences(list, cwd) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    throw new AgnesError('image 必须是字符串数组', 'INVALID_ARGS')
  }
  const resolved = []
  for (const item of list) {
    const classified = classifyMediaRef(item)
    if (classified.kind === 'url' || classified.kind === 'data-uri') {
      resolved.push(classified.value)
      continue
    }
    if (classified.kind === 'path') {
      resolved.push(await localFileToDataUri(classified.value, cwd, 'image'))
      continue
    }
    throw new AgnesError('image 里有一项既不是 URL、也不是 Data URI、也不是文件路径：' + String(item).slice(0, 120), 'INVALID_ARGS')
  }
  return resolved
}

export function createAgnesImageTool(deps) {
  let cooldownUntil = 0

  return {
    name: AGNES_IMAGE_TOOL_NAME,
    description: [
      '用 Agnes Image 2.5 Flash 生成或编辑图片，结果保存到会话工作目录的 agnes-images/ 下并直接显示。',
      '不传 image 就是文生图；传一张是图生图（按 prompt 改写这张图）；传多张是多图合成。',
      'image 的每一项可以是公网 https 图片地址、data:image/...;base64 数据，或会话目录下的本地图片路径（本地文件会读成 Data URI 发给上游）。',
      'size 用 1K/2K/3K/4K 档位，ratio 用 1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9；两个一起决定输出像素，例如 size=2K + ratio=16:9 得到 2624x1472。',
      '这不是免费操作：按输出档位计费（刊例 1K ¥0.07、2K ¥0.12、3K ¥0.14、4K ¥0.16 一张，当前天使用户体验价 ¥0），同一个 prompt 重跑一次就是再计一次费，所以别为了「换一张」反复调。',
      '需要 API Key：环境变量 AGNES_API_KEY，或 DSH 凭据库里的 AGENS_API_KEY，两者共用同一把 key（视频工具也用这把）。',
      '失败码：NOT_LOGGED_IN / INVALID_ARGS 没有发到上游，改完可以直接重试；AUTH、RATE_LIMIT、UPSTREAM、EMPTY_RESULT、MEDIA_UNAVAILABLE 之后 30 秒内再次调用会被 COOLDOWN 挡下，避免连续重试把同一笔费用再花一遍。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '要生成或要改成什么样。写清主体、场景、风格、光照、构图。图生图时写「要改什么 + 要保留什么」，多图合成时写清每张参考图各自扮演什么角色。',
        },
        size: {
          type: 'string',
          enum: SIZES,
          description:
            '输出档位，不传就用设置页里存的默认值（出厂 1K）。1K/2K/3K/4K 只是「多大」，具体宽高由 ratio 决定（1K+1:1=1024x1024，2K+16:9=2624x1472）。档位越高越贵、越慢。',
        },
        ratio: {
          type: 'string',
          enum: RATIOS,
          description:
            '宽高比，不传就用设置页里存的默认值（出厂 1:1）。要桌面壁纸用 16:9，手机壁纸用 9:16，竖版海报 3:4 或 2:3，横版 4:3 或 3:2，超宽 21:9。不要传 1920x1080 这类精确尺寸，上游会自己归到最近的档位。',
        },
        image: {
          type: 'array',
          items: { type: 'string' },
          description:
            '参考图，最多给几张由上游决定（前 3 张不计费，第 4 张起按张计费）。每一项是公网 https 图片地址、data:image/...;base64，或会话目录下的本地图片路径。留空就是纯文生图。',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对会话工作目录的图片路径' },
          absolutePath: { type: 'string' },
          prompt: { type: 'string' },
          size: { type: 'string' },
          ratio: { type: 'string' },
          pixels: { type: 'string', description: '这一档这一比例对应的输出像素' },
          mimeType: { type: 'string' },
          bytes: { type: 'number' },
          model: { type: 'string' },
          taskId: { type: 'string' },
          referenceCount: { type: 'number' },
        },
        required: ['path', 'absolutePath', 'prompt', 'size', 'ratio', 'pixels', 'mimeType', 'bytes', 'model'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [
          '已生成图片（' + value.size + ' / ' + value.ratio + ' → ' + value.pixels + '，' + formatBytes(value.bytes) + '）：' + value.path,
        ]
        if (value.referenceCount > 0) lines.push('参考图 ' + value.referenceCount + ' 张。')
        lines.push('![生成的图片](' + value.path + ')')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const now = Date.now()
      if (now < cooldownUntil) {
        const seconds = Math.ceil((cooldownUntil - now) / 1000)
        throw new AgnesError(
          '上一次调用失败了，' + seconds + ' 秒后才能再试。同一个 prompt 重试会再计一次费，先确认参数再重发。',
          'COOLDOWN',
        )
      }

      try {
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new AgnesError('prompt 不能为空', 'INVALID_ARGS')
        // 没传 size/ratio 时用设置页里存的默认值；设置页改完立刻生效，
        // 因为这里每次都重新读文件，不做模块级缓存。
        const defaults = await readSettings()
        const size = pickOne(args?.size, SIZES, defaults.image.size, 'size')
        const ratio = pickOne(args?.ratio, RATIOS, defaults.image.ratio, 'ratio')
        const cwd = sessionCwdOf(exec)
        const references = await resolveReferences(args?.image, cwd)

        const body = {
          model: AGNES_IMAGE_MODEL,
          prompt,
          size,
          ratio,
          // 关键：response_format 只能放在 extra_body 里，放顶层上游不认。
          extra_body: { response_format: 'url' },
        }
        // 参考图也只能放 extra_body.image；另外图生图不需要 tags:["img2img"]。
        if (references.length > 0) body.extra_body.image = references

        const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(IMAGE_TOOL_TIMEOUT_MS)])
        const payload = await postJson(
          deps.ctx,
          '/v1/images/generations',
          body,
          signal,
          'Agnes 图片生成',
        )

        const first = Array.isArray(payload?.data) ? payload.data[0] : undefined
        const url = typeof first?.url === 'string' ? first.url : ''
        if (url === '') {
          const reason = payload?.error?.message ?? '响应里没有 data[0].url'
          throw new AgnesError('Agnes 图片生成: 没拿到结果地址（' + reason + '）', 'EMPTY_RESULT')
        }

        const bytes = await downloadBytes(url, signal, 'Agnes 图片下载')
        const mimeType = mediaMimeTypeOf(bytes)
        if (mimeType === undefined || !mimeType.startsWith('image/')) {
          throw new AgnesError(
            'Agnes 图片下载: 取回的不是图片（前 4 字节 ' + hexPrefix(bytes) + '，' + bytes.length + ' 字节）。' +
            '费用已经产生，结果地址在 ' + url,
            'MEDIA_UNAVAILABLE',
          )
        }

        const saved = await saveMedia(cwd, IMAGE_DIR, 'agnes', bytes, mimeType, 'Agnes 图片保存')
        return {
          path: saved.relativePath,
          absolutePath: saved.absolutePath,
          prompt,
          size,
          ratio,
          pixels: SIZE_TABLE[size][ratio],
          mimeType,
          bytes: bytes.length,
          model: AGNES_IMAGE_MODEL,
          taskId: typeof payload?.task_id === 'string' ? payload.task_id : '',
          referenceCount: references.length,
        }
      } catch (error) {
        if (isBillableFailure(error)) cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
        deps.logger?.warn?.('agnes_image_generate 失败：' + messageOf(error))
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
