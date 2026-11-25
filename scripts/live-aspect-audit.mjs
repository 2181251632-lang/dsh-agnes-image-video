// 实测视频各画幅的真实输出像素，用来判定文档里两张互相矛盾的 720P 尺寸表哪张对。
// 用法：node scripts/live-aspect-audit.mjs [并发数]
// 只跑 text 模式、4 秒（最短最便宜），每档一个任务，最后从 mp4 的 tkhd 里读真实宽高。
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoPixelSizeOf } from '../lib/media.js'

const BASE = 'https://api.agnes-ai.cn'
const MODEL = 'agnes-video-2.5-flash'
const KEY = process.env.AGNES_API_KEY
if (!KEY) throw new Error('AGNES_API_KEY 没有设置')

const RATIOS = process.argv[3] ? process.argv[3].split(',') : ['4:3', '1:1', '3:4']
const CONCURRENCY = Number(process.argv[2] ?? 3)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 免费额度有速率限制：429 时退避重试，最多等 10 分钟。
async function createTask(ratio) {
  let wait = 30000
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(BASE + '/v1/videos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt: '一只猫坐在窗台上，镜头缓慢推近，自然光',
        mode: 'text',
        seconds: '4',
        size: '720P',
        aspect_ratio: ratio,
      }),
      signal: AbortSignal.timeout(120000),
    })
    const json = await res.json().catch(() => ({}))
    if (res.status === 429) {
      console.error(ratio + ' 被限流，' + Math.round(wait / 1000) + ' 秒后重试（第 ' + attempt + ' 次）')
      await sleep(wait)
      wait = Math.min(wait * 2, 180000)
      continue
    }
    if (!res.ok) throw new Error(ratio + ' 创建失败 HTTP ' + res.status + ' ' + JSON.stringify(json))
    return json.video_id ?? json.id
  }
  throw new Error(ratio + ' 一直限流，放弃')
}

async function poll(videoId) {
  const url = BASE + '/agnesapi?video_id=' + encodeURIComponent(videoId) + '&model_name=' + encodeURIComponent(MODEL)
  const started = Date.now()
  let interval = 5000
  while (Date.now() - started < 15 * 60 * 1000) {
    await sleep(interval)
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + KEY }, signal: AbortSignal.timeout(30000) })
    if (res.status === 429) { interval = Math.min(interval + 5000, 20000); continue }
    const json = await res.json().catch(() => ({}))
    if (json.status === 'failed') throw new Error('任务失败：' + JSON.stringify(json.error ?? json))
    if (json.status === 'completed') return { url: json.url, waited: Math.round((Date.now() - started) / 1000) }
  }
  throw new Error('轮询超时')
}

async function one(ratio, dir) {
  const videoId = await createTask(ratio)
  const { url, waited } = await poll(videoId)
  const bytes = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(180000) })).arrayBuffer())
  const file = join(dir, ratio.replace(':', 'x') + '.mp4')
  await writeFile(file, bytes)
  return { ratio, pixels: videoPixelSizeOf(bytes) ?? '读不出', bytes: bytes.length, waited, file }
}

const dir = await mkdtemp(join(tmpdir(), 'agnes-aspect-'))
const results = []
for (let i = 0; i < RATIOS.length; i += CONCURRENCY) {
  const batch = RATIOS.slice(i, i + CONCURRENCY)
  const settled = await Promise.allSettled(batch.map((r) => one(r, dir)))
  settled.forEach((s, k) => {
    if (s.status === 'fulfilled') results.push(s.value)
    else console.error(batch[k] + ' 失败：' + s.reason?.message)
  })
}

console.log('\n画幅  实测像素        文档(Flash页)   文档(Video2.5页)')
const FLASH = { '21:9': '1680x720', '16:9': '1280x704', '4:3': '960x720', '1:1': '720x720', '3:4': '720x960', '9:16': '720x1280' }
const MAIN = { '21:9': '1470x630', '16:9': '1280x720', '4:3': '1112x834', '1:1': '960x960', '3:4': '834x1112', '9:16': '720x1280' }
for (const r of results) {
  console.log(
    r.ratio.padEnd(6) + String(r.pixels).padEnd(16) + (FLASH[r.ratio] ?? '-').padEnd(16) + (MAIN[r.ratio] ?? '-') +
    '   ' + (r.pixels === FLASH[r.ratio] ? '=Flash' : r.pixels === MAIN[r.ratio] ? '=Main' : '≠两边'),
  )
}
console.log('\n文件目录：' + dir)
