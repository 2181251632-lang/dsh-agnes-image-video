// 字节层面的小工具：认图片/视频类型、定后缀、造文件名、落盘。
//
// 为什么不信 content-type：签名地址过期或被劫持时，CDN 常拿 200 回一页 HTML。
// 那样写下去的文件扩展名是 .jpg 却打不开，用户只看到碎图标，而费用已经产生。
// 认不出就返回 undefined，由调用方如实报 MEDIA_UNAVAILABLE。

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'

/** 从字节魔数判断媒体类型（JPEG / PNG / GIF / WebP / BMP / MP4 / WebM / QuickTime）。 */
export function mediaMimeTypeOf(bytes) {
  const at = (index) => bytes[index] ?? -1
  if (at(0) === 255 && at(1) === 216 && at(2) === 255) return 'image/jpeg'
  if (at(0) === 137 && at(1) === 80 && at(2) === 78 && at(3) === 71) return 'image/png'
  if (at(0) === 71 && at(1) === 73 && at(2) === 70) return 'image/gif'
  if (
    at(0) === 82 && at(1) === 73 && at(2) === 70 && at(3) === 70 &&
    at(8) === 87 && at(9) === 69 && at(10) === 66 && at(11) === 80
  ) return 'image/webp'
  if (at(0) === 66 && at(1) === 77) return 'image/bmp'
  // ISO BMFF（MP4 / MOV）：第 4..7 字节是 'ftyp'。
  if (at(4) === 102 && at(5) === 116 && at(6) === 121 && at(7) === 112) {
    const brand = String.fromCharCode(at(8), at(9), at(10), at(11))
    if (brand.startsWith('qt')) return 'video/quicktime'
    return 'video/mp4'
  }
  // Matroska / WebM：1A 45 DF A3。
  if (at(0) === 26 && at(1) === 69 && at(2) === 223 && at(3) === 163) return 'video/webm'
  return undefined
}

/** 前若干字节的十六进制，只用于排障文案。 */
export function hexPrefix(bytes) {
  return [...bytes.slice(0, 4)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/**
 * 从 MP4 字节里读出视频轨的像素尺寸，返回 `WxH`；读不出返回 undefined。
 *
 * 为什么要读而不是查表：实测 keyframe 模式传 `aspect_ratio: 16:9` 但首帧是方图时，
 * 上游照样出 720x720 —— 画幅跟着首帧走，`aspect_ratio` 不生效。查表会把尺寸报错。
 *
 * 做法是走 box 树找 `moov/trak/tkhd`，tkhd 末尾两对 16.16 定点数就是宽高。
 */
export function videoPixelSizeOf(bytes) {
  const readU32 = (offset) => {
    if (offset + 4 > bytes.length) return undefined
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]
  }
  const typeAt = (offset) => {
    if (offset + 4 > bytes.length) return ''
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
  }

  // 在 [start, end) 里找第一个指定类型的 box，返回它的内容起止位置。
  const findBox = (start, end, wanted) => {
    let cursor = start
    while (cursor + 8 <= end) {
      const size = readU32(cursor)
      const type = typeAt(cursor + 4)
      if (size === undefined || size < 8) return undefined
      const body = cursor + 8
      const next = cursor + size
      if (type === wanted) return { body, end: Math.min(next, end) }
      cursor = next
    }
    return undefined
  }

  const moov = findBox(0, bytes.length, 'moov')
  if (moov === undefined) return undefined

  // 逐个 trak 找 tkhd；取第一个宽高都非零的（音轨的 tkhd 宽高是 0）。
  let cursor = moov.body
  while (cursor + 8 <= moov.end) {
    const size = readU32(cursor)
    if (size === undefined || size < 8) return undefined
    if (typeAt(cursor + 4) === 'trak') {
      const trakEnd = Math.min(cursor + size, moov.end)
      const tkhd = findBox(cursor + 8, trakEnd, 'tkhd')
      if (tkhd !== undefined) {
        const version = bytes[tkhd.body]
        const base = tkhd.body + (version === 1 ? 88 : 76)
        const width = readU32(base)
        const height = readU32(base + 4)
        if (width !== undefined && height !== undefined) {
          const w = Math.round(width / 65536)
          const h = Math.round(height / 65536)
          if (w > 0 && h > 0) return w + 'x' + h
        }
      }
    }
    cursor += size
  }
  return undefined
}

/** mime → 文件后缀。 */
export function extensionFor(mimeType) {
  const type = String(mimeType).toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('bmp')) return 'bmp'
  if (type.includes('quicktime')) return 'mov'
  if (type.includes('webm')) return 'webm'
  if (type.includes('mp4')) return 'mp4'
  return 'jpg'
}

/**
 * 文件名：本地时间的可排序时间戳 + 随机后缀，同一秒两个结果也不会互相覆盖。
 * 形如 agnes-20261125-004100-a1b2c3.png。
 */
export function mediaFileName(prefix, mimeType, now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  const stamp =
    String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
  const rand = Math.random().toString(16).slice(2, 8)
  return prefix + '-' + stamp + '-' + rand + '.' + extensionFor(mimeType)
}

/**
 * 把字节写成 <cwd>/<directory>/<name>，返回绝对路径与相对路径。
 *
 * 相对路径给 render 用：DSH 的聊天按 session cwd 解析 markdown 资源地址，
 * 再过 api/file 鉴权路由取字节，所以相对路径就能显示。
 */
export async function saveMedia(cwd, directoryName, prefix, bytes, mimeType, label) {
  const directory = join(cwd, directoryName)
  const name = mediaFileName(prefix, mimeType, Date.now())
  const absolutePath = join(directory, name)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(absolutePath, bytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(label + ': 结果已经生成、费用已经产生，但写入本地文件失败（目录 ' + directory + '）：' + detail)
    wrapped.code = 'MEDIA_UNAVAILABLE'
    throw wrapped
  }
  return { absolutePath, relativePath: directoryName + '/' + name }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm'])

/**
 * 判断一个媒体引用是什么：远程 URL、Data URI、还是本地文件路径。
 * 上游只收前两种，所以本地路径要由调用方转成 Data URI。
 */
export function classifyMediaRef(value) {
  if (typeof value !== 'string') return { kind: 'invalid' }
  const trimmed = value.trim()
  if (trimmed === '') return { kind: 'invalid' }
  if (/^data:[^,]+,/i.test(trimmed)) return { kind: 'data-uri', value: trimmed }
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', value: trimmed }
  return { kind: 'path', value: trimmed }
}

function mimeForExtension(extension) {
  switch (extension) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.ogg': return 'audio/ogg'
    case '.flac': return 'audio/flac'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    default: return undefined
  }
}

/** 本地文件的单张上限。上游对 Data URI 的容忍度有限，超过就明确报错而不是干等超时。 */
const MAX_LOCAL_MEDIA_BYTES = 24 * 1024 * 1024

/**
 * 把一个本地文件读成 Data URI。目录按会话工作目录解析相对路径。
 *
 * 用 Data URI 而不是让上游来取：`api.agnes-ai.cn` 拿不到用户本机的文件，
 * 也没有预签名上传通道。图片端点实测接受 Data URI，视频的 first_frame /
 * images 同样接受。
 */
export async function localFileToDataUri(reference, cwd, kind) {
  const absolute = isAbsolute(reference) ? reference : resolve(cwd, reference)
  const extension = extname(absolute).toLowerCase()
  const allowed = kind === 'audio' ? AUDIO_EXTENSIONS : kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS
  if (!allowed.has(extension)) {
    throw invalidArgs(
      '本地' + mediaWord(kind) + '的后缀 ' + (extension === '' ? '（没有后缀）' : extension) +
      ' 不在支持范围：' + [...allowed].join(' '),
    )
  }
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw invalidArgs('找不到本地' + mediaWord(kind) + '：' + absolute)
  }
  if (!info.isFile()) throw invalidArgs('这不是一个文件：' + absolute)
  if (info.size === 0) throw invalidArgs('本地' + mediaWord(kind) + '是空文件：' + absolute)
  if (info.size > MAX_LOCAL_MEDIA_BYTES) {
    throw invalidArgs(
      '本地' + mediaWord(kind) + '有 ' + (info.size / 1048576).toFixed(1) + ' MB，超过 ' +
      (MAX_LOCAL_MEDIA_BYTES / 1048576) + ' MB 上限：' + absolute,
    )
  }
  const bytes = await readFile(absolute)
  const mime = mediaMimeTypeOf(new Uint8Array(bytes)) ?? mimeForExtension(extension)
  if (mime === undefined) throw invalidArgs('认不出这个文件的媒体类型：' + absolute)
  return 'data:' + mime + ';base64,' + bytes.toString('base64')
}

function mediaWord(kind) {
  if (kind === 'audio') return '音频'
  if (kind === 'video') return '视频'
  return '图片'
}

function invalidArgs(message) {
  const error = new Error(message)
  error.code = 'INVALID_ARGS'
  return error
}
