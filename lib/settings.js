// 生成参数的默认值：存在 DSH home 下的一个小 JSON 里，不走 Config。
//
// 为什么不走 Config：插件包装在 `D:\项目文件\dsh-agnes-media`（软链进 profile），
// 裸 import `@deepseek-ai/schemastery` 会从真实路径往上找 node_modules，
// 找不到宿主那份 —— 所以本插件刻意不依赖任何宿主 npm 包，只吃 ctx 上的服务。
// 参数默认值本身也不需要宿主参与：一个 JSON 文件足够，而且改完立刻生效
// （工具每次调用都重新读，不做模块级缓存）。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const IMAGE_SIZES = ['1K', '2K', '3K', '4K']
export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
export const VIDEO_MODES = ['text', 'keyframe', 'reference']
export const VIDEO_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
export const VIDEO_SECONDS_MIN = 4
export const VIDEO_SECONDS_MAX = 12

/** 出厂默认值。UI 上「恢复默认」就是这个对象。 */
export const DEFAULT_SETTINGS = {
  image: { size: '1K', ratio: '1:1' },
  video: { mode: '', seconds: 5, aspectRatio: '16:9' },
}

const SETTINGS_DIR = 'agnes-media'
const SETTINGS_FILE = 'settings.json'

/** DSH home：环境变量优先，退回 ~/.dsh（与宿主自己的解析顺序一致）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(dshHome(), SETTINGS_DIR, SETTINGS_FILE)
}

function pick(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (text === '') return fallback
  const hit = allowed.find((item) => item.toLowerCase() === text.toLowerCase())
  return hit === undefined ? fallback : hit
}

function clampSeconds(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < VIDEO_SECONDS_MIN) return VIDEO_SECONDS_MIN
  if (rounded > VIDEO_SECONDS_MAX) return VIDEO_SECONDS_MAX
  return rounded
}

/**
 * 把任意输入收敛成一份合法设置。
 *
 * 手改过的文件、半截写入、旧版本字段都可能出现在这里，所以每个字段都单独
 * 兜底：坏掉的那一项退回默认，其余照常生效 —— 一个字段写错不该让整份设置失效。
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const image = source.image !== null && typeof source.image === 'object' ? source.image : {}
  const video = source.video !== null && typeof source.video === 'object' ? source.video : {}
  return {
    image: {
      size: pick(image.size, IMAGE_SIZES, DEFAULT_SETTINGS.image.size),
      ratio: pick(image.ratio, IMAGE_RATIOS, DEFAULT_SETTINGS.image.ratio),
    },
    video: {
      // 空字符串 = 不指定，让工具自己按素材推断模式。
      mode: pick(video.mode, VIDEO_MODES, DEFAULT_SETTINGS.video.mode),
      seconds: clampSeconds(video.seconds, DEFAULT_SETTINGS.video.seconds),
      aspectRatio: pick(video.aspectRatio, VIDEO_ASPECT_RATIOS, DEFAULT_SETTINGS.video.aspectRatio),
    },
  }
}

/** 读设置。文件不存在、读不动、JSON 坏了都退回默认值，绝不抛。 */
export async function readSettings() {
  let text
  try {
    text = await readFile(settingsPath(), 'utf8')
  } catch {
    return normalizeSettings(undefined)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return normalizeSettings(undefined)
  }
  return normalizeSettings(parsed)
}

/** 合并写入：只覆盖传进来的字段，其余保持原样。返回归一化后的完整设置。 */
export async function writeSettings(patch) {
  const current = await readSettings()
  const merged = {
    image: { ...current.image, ...(patch?.image ?? {}) },
    video: { ...current.video, ...(patch?.video ?? {}) },
  }
  const next = normalizeSettings(merged)
  const target = settingsPath()
  await mkdir(join(dshHome(), SETTINGS_DIR), { recursive: true })
  const temp = target + '.tmp'
  await writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(temp, target)
  return next
}
