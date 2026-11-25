// 三种模式的联调脚本。视频队列经常满，创建这一步过不去，但「请求体拼得对不对」
// 和「轮询 → 下载 → 落盘」都必须能验。
//
// 做法：拦下创建请求，把**真实要发的 body** 打印出来（data URI 只留头尾），
// 然后回一条已经完成的 video_id 让后续轮询/下载/落盘全部走真实网络。
//
// 用法：node scripts/live-video-modes.mjs <已完成的 VIDEO_ID>
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import { createAgnesVideoTool } from '../lib/video-tool.js'

const videoId = process.argv[2]
if (!videoId) {
  console.error('用法：node scripts/live-video-modes.mjs <已完成的 VIDEO_ID>')
  process.exit(2)
}

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
let captured = null

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  if (href.endsWith('/v1/videos')) {
    captured = JSON.parse(String(init.body))
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

// data URI 太长，只留头 60 字符 + 长度，其余原样。
function shrink(value) {
  if (typeof value === 'string' && value.startsWith('data:')) {
    return `${value.slice(0, 60)}…(共 ${value.length} 字符)`
  }
  if (Array.isArray(value)) return value.map(shrink)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = shrink(item)
    return out
  }
  return value
}

const logger = { warn: console.warn, info: console.log, error: console.error }

const cases = [
  {
    label: 'text 模式（纯文字）',
    args: { prompt: 'A single glossy red apple on a white studio surface.', mode: 'text', seconds: 4, aspect_ratio: '16:9' },
  },
  {
    label: 'keyframe 模式（本地图当首帧 → Data URI）',
    args: {
      prompt: 'The apple slowly rotates, soft light sweeps across it.',
      mode: 'keyframe',
      first_frame: 'D:/项目文件/agnes-images/agnes-20261125-004938-16b40f.png',
      seconds: 4,
      aspect_ratio: '16:9',
    },
  },
  {
    label: 'reference 模式（本地图当参考）',
    args: {
      prompt: 'Match the look of <Picture 1> and add a slow camera orbit.',
      mode: 'reference',
      images: ['D:/项目文件/agnes-images/agnes-20261125-004949-78bafa.png'],
      seconds: 4,
      aspect_ratio: '9:16',
    },
  },
]

for (const item of cases) {
  const cwd = await mkdtemp(join(tmpdir(), 'agnes-modes-'))
  const ctx = { get: () => undefined, logger }
  const exec = { signal: new AbortController().signal, cwd }
  const tool = createAgnesVideoTool({ ctx, logger })
  captured = null

  console.log('\n=== ' + item.label + ' ===')
  const started = Date.now()
  try {
    const value = await tool.execute(item.args, exec)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log('创建 body：', JSON.stringify(shrink(captured), null, 2))
    const info = await stat(value.absolutePath)
    console.log(`耗时 ${elapsed}s；落盘 ${info.size} bytes；pixels=${value.pixels}；mode=${value.mode}；seconds=${value.seconds}`)
    console.log('render：', tool.output.render({}, value)[0].text.split('\n')[0])
  } catch (error) {
    console.log('失败：', error.code || '(no code)', '-', String(error.message).slice(0, 200))
  }
}
