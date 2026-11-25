// 插件自己的 HTTP 面：给设置页读写 key 和生成参数用。
//
// 为什么走 HTTP 而不是 ctx.remote.commands：本插件要能在「宿主没有暴露那个入口」
// 的版本上也能用，而 webServer 是宿主一直有的服务。路由挂在
// `/plugins/<包名>/<动作>`，与 trae / workbuddy 的既有约定一致。
//
// 三条硬规则：
//   1. 方法不对先 405，再做别的判断；
//   2. 非本机来源一律 403 —— 这些路由能读 key 的元信息、能写 key；
//   3. 错误一律转成 `{error, code}`，不把堆栈丢给浏览器。

import { AgnesError, messageOf } from './errors.js'
import { AGNES_BASE_URL, AGNES_IMAGE_MODEL, AGNES_VIDEO_MODEL } from './client.js'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings.js'

/** key 的凭据名：上游自己的拼写就是 AGENS（少一个 I），环境变量则是 AGNES_API_KEY。 */
export const CREDENTIAL_REF = 'AGENS_API_KEY'
export const ENV_REF = 'AGNES_API_KEY'

const ROUTE_PREFIX = '/plugins/dsh-agnes-image-video'
const BODY_LIMIT = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function bareHostname(value) {
  if (typeof value !== 'string' || value === '') return ''
  let text = value.trim().toLowerCase()
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end > 0) return text.slice(1, end)
  }
  const colon = text.indexOf(':')
  if (colon >= 0 && text.indexOf(':', colon + 1) < 0) text = text.slice(0, colon)
  return text
}

/** 只接受本机页面发来的请求：同源比较 + 回环地址白名单。 */
function loopbackOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  let hostname
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (!local) return false
  const requestHost = bareHostname(req.headers.host)
  const socketHost = bareHostname(req.socket?.localAddress)
  return hostname === requestHost || hostname === socketHost || hostname === 'localhost'
}

async function readJsonBody(req) {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new AgnesError('请求体不是合法 JSON', 'INVALID_ARGS')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgnesError('请求体必须是一个 JSON 对象', 'INVALID_ARGS')
  }
  return parsed
}

/** key 的现状：只回元信息，永远不回明文。 */
async function describeKey(ctx) {
  const credentials = ctx.get?.('credentials')
  const envValue = process.env[ENV_REF]
  const envConfigured = typeof envValue === 'string' && envValue.trim() !== ''
  if (credentials === undefined || credentials === null) {
    return {
      configured: envConfigured,
      source: envConfigured ? 'env' : undefined,
      writable: false,
      masked: envConfigured ? maskKey(envValue) : undefined,
      envRef: ENV_REF,
      credentialRef: CREDENTIAL_REF,
      credentialService: false,
    }
  }
  let info
  try {
    info = await credentials.describe(CREDENTIAL_REF)
  } catch {
    info = undefined
  }
  const storedConfigured = info?.configured === true
  const configured = envConfigured || storedConfigured
  return {
    configured,
    // 环境变量优先级高于凭据库（工具就是这么解析的），所以来源也要照这个顺序报。
    source: envConfigured ? 'env' : storedConfigured ? (info?.source ?? 'store') : undefined,
    writable: info?.writable !== false,
    masked: info?.masked,
    envRef: ENV_REF,
    credentialRef: CREDENTIAL_REF,
    credentialService: true,
  }
}

function maskKey(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  if (text.length <= 8) return '•'.repeat(text.length)
  return text.slice(0, 4) + '…' + text.slice(-4)
}

/**
 * 注册全部路由。返回一个注销函数（宿主 webServer.register 的 dispose）。
 *
 * 每个 handler 都自带 try/catch：一条路由抛错不该让同一个 effect 里的
 * 其它路由失效，也不该把 500 的堆栈泄漏给页面。
 */
export function registerAgnesRoutes(ctx, logger) {
  const routes = []

  const mount = (action, handler) => {
    const path = ROUTE_PREFIX + '/' + action
    try {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST' && req.method !== 'GET') {
              return json(res, 405, { error: 'method not allowed' })
            }
            if (!loopbackOrigin(req)) {
              return json(res, 403, { error: 'origin-not-trusted' })
            }
            await handler(req, res)
          } catch (error) {
            const code = error instanceof AgnesError ? error.code : 'INTERNAL'
            logger?.warn?.('agnes-media 路由 ' + action + ' 失败：' + messageOf(error))
            json(res, code === 'INVALID_ARGS' ? 400 : 500, { error: messageOf(error), code })
          }
        },
      })
      routes.push(dispose)
      return true
    } catch (error) {
      logger?.warn?.('agnes-media 路由 ' + action + ' 挂载失败：' + messageOf(error))
      return false
    }
  }

  // 页面首屏：key 现状 + 生成参数默认值 + 模型名。一次拿全，少一次往返。
  mount('state', async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    const settings = await readSettings()
    json(res, 200, {
      key: await describeKey(ctx),
      settings,
      defaults: DEFAULT_SETTINGS,
      models: { image: AGNES_IMAGE_MODEL, video: AGNES_VIDEO_MODEL },
      baseUrl: AGNES_BASE_URL,
    })
  })

  // 写入 key。空字符串视为「清空」，走 unset，让环境变量重新生效。
  mount('key', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readJsonBody(req)
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined || credentials === null) {
      throw new AgnesError('这个 profile 没有凭据服务，key 只能放在环境变量 ' + ENV_REF + ' 里', 'NOT_LOGGED_IN')
    }
    const raw = typeof body.value === 'string' ? body.value.trim() : ''
    if (raw === '') {
      await credentials.unset(CREDENTIAL_REF)
      return json(res, 200, { key: await describeKey(ctx) })
    }
    // 明显不像 key 的输入直接挡下来：省得用户以为存上了、实际每次调用都 401。
    if (/\s/.test(raw)) {
      throw new AgnesError('key 里不能有空格或换行，检查是不是复制时带上了多余字符', 'INVALID_ARGS')
    }
    await credentials.set(CREDENTIAL_REF, raw)
    json(res, 200, { key: await describeKey(ctx) })
  })

  // 生成参数：只接受已知字段，未知字段忽略（旧版页面调新版宿主不该炸）。
  mount('settings', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const body = await readJsonBody(req)
    if (body.reset === true) {
      const settings = await writeSettings(DEFAULT_SETTINGS)
      return json(res, 200, { settings })
    }
    const patch = {}
    if (body.image !== null && typeof body.image === 'object') {
      patch.image = {}
      if ('size' in body.image) patch.image.size = body.image.size
      if ('ratio' in body.image) patch.image.ratio = body.image.ratio
    }
    if (body.video !== null && typeof body.video === 'object') {
      patch.video = {}
      if ('mode' in body.video) patch.video.mode = body.video.mode
      if ('seconds' in body.video) patch.video.seconds = body.video.seconds
      if ('aspectRatio' in body.video) patch.video.aspectRatio = body.video.aspectRatio
    }
    const settings = await writeSettings(patch)
    json(res, 200, { settings })
  })

  // 连通性测试：拿当前 key 打一次最便宜的上游请求（列模型，不计费）。
  mount('verify', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    const apiKey = await resolveKeyForProbe(ctx)
    let response
    try {
      response = await fetch(AGNES_BASE_URL + '/v1/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      return json(res, 200, {
        ok: false,
        status: 0,
        message: '连不上 ' + AGNES_BASE_URL + '：' + messageOf(error),
      })
    }
    if (response.ok) {
      return json(res, 200, { ok: true, status: response.status, message: 'key 可用' })
    }
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, 300)
    } catch {
      detail = ''
    }
    json(res, 200, {
      ok: false,
      status: response.status,
      message:
        response.status === 401 || response.status === 403
          ? '上游拒绝了这把 key（HTTP ' + response.status + '）'
          : '上游返回 HTTP ' + response.status + (detail === '' ? '' : '：' + detail),
    })
  })

  return () => {
    while (routes.length > 0) {
      const dispose = routes.pop()
      try {
        dispose?.()
      } catch {
        // 注销路径上的失败没有可做的事。
      }
    }
  }
}

/** 测试连通性时用的 key：与工具同一套解析顺序（环境变量 → 凭据库）。 */
async function resolveKeyForProbe(ctx) {
  const fromEnv = process.env[ENV_REF]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const credentials = ctx.get?.('credentials')
  if (credentials !== undefined && credentials !== null) {
    try {
      const resolved = await credentials.resolve(CREDENTIAL_REF)
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      // 落到下面的统一报错。
    }
  }
  throw new AgnesError('还没有可用的 key，先在上面填一把再测试', 'NOT_LOGGED_IN')
}
