// 与 Agnes 对话的全部 HTTP 细节集中在这里：找 key、拼 URL、发请求、收字节。
//
// 两个端点（图片 / 视频）共用一个 API Key，所以 key 解析只写一次。
// 每次调用都重新解析，不在模块里缓存 —— 用户可能随时在设置里换 key，
// 缓存会让「刚改完 key 还是 401」变成一个假故障。

import { AgnesError } from './errors.js'
import { mapHttpError } from './errors-body.js'

export const AGNES_BASE_URL = 'https://api.agnes-ai.cn'
export const AGNES_IMAGE_MODEL = 'agnes-image-2.5-flash'
export const AGNES_VIDEO_MODEL = 'agnes-video-2.5-flash'

/** 环境变量优先，其次读 DSH 凭据库里的 AGENS_API_KEY（注意上游自己的拼写就是 AGENS）。 */
const API_KEY_ENV = 'AGNES_API_KEY'
const API_KEY_CREDENTIAL = 'AGENS_API_KEY'

/**
 * 取 API Key。找不到就抛 NOT_LOGGED_IN —— 这个码不计费、不进冷却，
 * 用户补上 key 之后可以立刻重试。
 */
export async function resolveApiKey(ctx) {
  const fromEnv = process.env[API_KEY_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const credentials = ctx?.get?.('credentials')
  if (credentials === undefined || credentials === null) {
    throw new AgnesError(
      '没有可用的 Agnes API Key：环境变量 ' + API_KEY_ENV + ' 为空，凭据服务也不可用。' +
      '请在设置里为 ' + API_KEY_CREDENTIAL + ' 填入 key。',
      'NOT_LOGGED_IN',
    )
  }
  let resolved
  try {
    resolved = await credentials.resolve(API_KEY_CREDENTIAL)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AgnesError('读取凭据 ' + API_KEY_CREDENTIAL + ' 失败：' + detail, 'NOT_LOGGED_IN')
  }
  const value = typeof resolved === 'string' ? resolved : resolved?.value
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgnesError(
      '没有可用的 Agnes API Key：环境变量 ' + API_KEY_ENV + ' 为空，凭据库里也没有 ' +
      API_KEY_CREDENTIAL + '。请先填入 key 再重试。',
      'NOT_LOGGED_IN',
    )
  }
  return value.trim()
}

function authHeaders(apiKey) {
  return { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
}

async function readText(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * POST 一个 JSON 请求体，返回解析后的 JSON。
 *
 * 非 2xx 一律交给 mapHttpError 定 code：400 是上游在排队/计费前挡下的参数错误，
 * 不该进冷却；401/429/5xx 才算「可能已经花钱」。
 */
export async function postJson(ctx, path, body, signal, label) {
  const apiKey = await resolveApiKey(ctx)
  const url = AGNES_BASE_URL + path
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw networkError(error, label)
  }
  if (!response.ok) {
    throw mapHttpError(response.status, await readText(response), label)
  }
  const text = await readText(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new AgnesError(label + ': 上游返回的不是 JSON：' + text.slice(0, 300), 'UPSTREAM')
  }
}

/**
 * GET 一个 JSON。返回 { status, json }，因为轮询要把 429 和「任务还没好」
 * 当成正常中间状态处理，而不是异常。
 */
export async function getJson(ctx, url, signal, label) {
  const apiKey = await resolveApiKey(ctx)
  let response
  try {
    response = await fetch(url, { headers: { Authorization: 'Bearer ' + apiKey }, signal })
  } catch (error) {
    throw networkError(error, label)
  }
  const text = await readText(response)
  if (response.status === 429) return { status: 429, json: undefined, text }
  if (!response.ok) throw mapHttpError(response.status, text, label)
  try {
    return { status: response.status, json: JSON.parse(text), text }
  } catch {
    throw new AgnesError(label + ': 上游返回的不是 JSON：' + text.slice(0, 300), 'UPSTREAM')
  }
}

/**
 * 取回结果字节。签名地址不需要 Authorization，多带一个头反而可能被 CDN 拒。
 *
 * 这里不判断内容是不是媒体 —— 交给调用方用魔数认，认不出就报 MEDIA_UNAVAILABLE。
 */
export async function downloadBytes(url, signal, label) {
  let response
  try {
    response = await fetch(url, { signal })
  } catch (error) {
    throw networkError(error, label)
  }
  if (!response.ok) {
    throw new AgnesError(label + ': 结果地址取不回来（HTTP ' + response.status + '）', 'MEDIA_UNAVAILABLE')
  }
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

function networkError(error, label) {
  if (error instanceof AgnesError) return error
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new AgnesError(label + ': 请求超时或被取消', 'TASK_TIMEOUT')
  }
  const detail = error instanceof Error ? error.message : String(error)
  const cause = error?.cause instanceof Error ? error.cause.message : undefined
  return new AgnesError(label + ': 连不上 Agnes（' + detail + (cause === undefined ? '' : ' / ' + cause) + '）', 'NO_ROUTE')
}
