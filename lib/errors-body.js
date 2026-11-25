// 把上游的两种错误体归一成 AgnesError。
//
// 两个端点回的错误体长得不一样：
//   图片：{ "error": { "message": "...", "type": "invalid_request", "param": "", "code": "invalid_request" } }
//   视频：{ "code": "invalid_request", "message": "...", "data": { "param": "size", "valid_sizes": [...] } }
// 所以这里同时认两种形状，只取「人话 + 出错参数」这两件事。

import { AgnesError } from './errors.js'

/** 从错误体里抽出一条人话。抽不到就返回原始文本的前 300 字。 */
export function describeErrorBody(text) {
  const raw = typeof text === 'string' ? text : ''
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  let json
  try {
    json = JSON.parse(trimmed)
  } catch {
    return trimmed.slice(0, 300)
  }
  if (json === null || typeof json !== 'object') return trimmed.slice(0, 300)
  const nested = typeof json.error === 'object' && json.error !== null ? json.error : undefined
  const message = firstString(json.message, nested?.message)
  const param = firstString(json.data?.param, nested?.param, json.param)
  const code = firstString(json.code, nested?.code, json.type)
  const parts = []
  if (message !== undefined) parts.push(message)
  else parts.push(trimmed.slice(0, 300))
  if (param !== undefined) parts.push('（参数 ' + param + '）')
  if (code !== undefined && code !== 'invalid_request') parts.push('[' + code + ']')
  return parts.join(' ')
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** 从错误体里读上游的机器码（`invalid_request` / `video_queue_full` / ...）。 */
export function errorCodeOf(text) {
  try {
    const json = JSON.parse(text)
    if (json === null || typeof json !== 'object') return undefined
    const code = firstString(json.code, json.error?.code, json.error?.type)
    return code
  } catch {
    return undefined
  }
}

/**
 * HTTP 状态码 + 错误体 → AgnesError。
 *
 * `billable` 说的是「这一次会不会已经花钱」：任务创建成功之后的失败一定算，
 * 而 4xx 参数校验是上游在排队/计费之前就挡下来的，不算。冷却判据在
 * errors.js，这里只负责把 code 选对。
 */
export function mapHttpError(status, body, label) {
  const detail = describeErrorBody(body)
  const tail = detail === '' ? '' : '：' + detail
  const upstreamCode = errorCodeOf(body)
  // 队列满要先判，因为上游是用 HTTP 503 报这件事的（实测），不是 400。
  // 它意味着任务根本没进队列、没建任务、没扣费，所以给它单独的 code：
  // 既不能混进 UPSTREAM，也不能混进 RATE_LIMIT（那个是真限流，可能已经排上队），
  // 否则一次没花钱的调用会被白白冷却 30 秒。
  if (upstreamCode === 'video_queue_full') {
    return new AgnesError(label + ': 视频队列已满，上游让你稍后再试' + tail, 'QUEUE_FULL')
  }
  if (status === 401 || status === 403) {
    return new AgnesError(label + ': 上游拒绝了凭据（HTTP ' + status + '）' + tail, 'AUTH')
  }
  if (status === 429) {
    return new AgnesError(label + ': 上游限流（HTTP 429）' + tail, 'RATE_LIMIT')
  }
  if (status === 400 || status === 422) {
    // 参数被挡下：上游在创建任务之前就拒绝了，没有排队、没有扣费。
    return new AgnesError(label + ': 上游拒绝了这组参数（HTTP ' + status + '）' + tail, 'INVALID_ARGS')
  }
  return new AgnesError(label + ': 上游 HTTP ' + status + tail, 'UPSTREAM')
}
