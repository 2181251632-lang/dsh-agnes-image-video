// 半真实联调：视频队列满的时候，创建这一步过不去，但「轮询 → 下载 → 落盘」
// 这段同样要验。做法是把创建请求换成一条已经存在的 video_id，其余请求
// （/agnesapi 轮询、CDN 下载）全部走真实网络。
//
// 用法：node scripts/live-video-poll.mjs <VIDEO_ID>
// 需要 .credentials.yaml 里已经有 AGENS_API_KEY，或者环境变量里有 AGNES_API_KEY。
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { createAgnesVideoTool } from '../lib/video-tool.js'

const videoId = process.argv[2]
if (!videoId) {
  console.error('用法：node scripts/live-video-poll.mjs <VIDEO_ID>')
  process.exit(2)
}

// 环境变量优先，没有就从凭据文件里读——和插件自己的顺序一致。
if (!process.env.AGNES_API_KEY) {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const match = text.match(/AGENS_API_KEY:\s*(\S+)/)
  if (!match) {
    console.error('找不到 AGENS_API_KEY')
    process.exit(2)
  }
  process.env.AGNES_API_KEY = match[1]
}

const realFetch = globalThis.fetch
let createStubbed = false

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  // 只拦创建：把它换成一条已经存在的任务 id，跳过队列。
  if (href.endsWith('/v1/videos')) {
    createStubbed = true
    return new Response(
      JSON.stringify({
        id: videoId,
        video_id: videoId,
        task_id: videoId,
        object: 'video',
        status: 'queued',
        progress: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return realFetch(url, init)
}

const cwd = await mkdtemp(join(tmpdir(), 'agnes-live-'))
const logger = { warn: console.warn, info: console.log, error: console.error }
const ctx = { get: () => undefined, logger }
const exec = { signal: new AbortController().signal, cwd }

const tool = createAgnesVideoTool({ ctx, logger })
const started = Date.now()
const value = await tool.execute(
  { prompt: 'A single glossy red apple on a plain white studio surface.', mode: 'text', seconds: 4, aspect_ratio: '16:9' },
  exec,
)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log('创建被替换：', createStubbed)
console.log('耗时：', elapsed + 's')
console.log('返回值：', JSON.stringify(value, null, 2))

const info = await stat(value.absolutePath)
console.log('落盘大小：', info.size, 'bytes')
console.log('render：', JSON.stringify(tool.output.render({}, value), null, 2))
