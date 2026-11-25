// 统一错误类型与「是否该进冷却」的判据。
//
// 判据只看 code：请求已经发到上游（甚至已经排上队、已经扣费）的失败，
// 连续重试只会把它们再花一遍，所以进冷却；参数校验类的失败一分钱没花，
// 不冷却。

/** 工具抛出的唯一错误类型。code 决定文案与冷却行为。 */
export class AgnesError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AgnesError'
    this.code = code
  }
}

/**
 * 这些失败码都发生在「请求已经发出去」之后——上游可能已经扣了费或排了队，
 * 连续重试只会把它们再花一遍，所以进冷却。
 */
export const BILLABLE_FAILURE_CODES = new Set([
  'AUTH',
  'RATE_LIMIT',
  'NO_ROUTE',
  'UPSTREAM',
  'EMPTY_RESULT',
  'MEDIA_UNAVAILABLE',
  'TASK_FAILED',
  'TASK_TIMEOUT',
])

/**
 * 这些失败码一定没花钱：要么请求根本没发出去（INVALID_ARGS 在本地就挡下了），
 * 要么是冷却本身，要么是上游连任务都没建就让你重排（QUEUE_FULL）。
 * 改完参数或者等一会儿应该能立刻重试，不该被上一次的失败拖住。
 */
export const NON_BILLABLE_CODES = new Set(['INVALID_ARGS', 'NOT_LOGGED_IN', 'COOLDOWN', 'QUEUE_FULL'])

/**
 * 这次失败要不要进冷却。
 *
 * 不只看 AgnesError：`media.js` 里落盘失败会抛带 code 的普通 Error，
 * 那同样发生在「结果已经生成、费用已经产生」之后，必须算进去。
 * 认不出 code 的一律按「可能已经花钱」处理——保守方向是少花一次钱。
 */
export function isBillableFailure(error) {
  const code = error?.code
  if (typeof code !== 'string') return true
  if (NON_BILLABLE_CODES.has(code)) return false
  if (BILLABLE_FAILURE_CODES.has(code)) return true
  return true
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
