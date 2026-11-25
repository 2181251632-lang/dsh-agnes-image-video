// 设置页（浏览器端）。
//
// 这个文件只在 Web GUI 里跑，由宿主的模块加载器载入，因此：
//   * 唯一的 require 是 'react'（宿主从模块表里给，不允许自带一份）；
//   * 不能 import 本包的其它文件 —— 这里就是独立的一段浏览器代码，
//     需要的数据全部通过 HTTP 找宿主拿（lib/routes.js 那一侧）。
//
// 页面只有两件事：填 / 换 API Key，调生成参数的默认值。两件事都写回宿主，
// 工具下一次调用就会用上，不需要重启插件。

window.__ModuleLoader__.load({
  id: 'dsh-agnes-image-video',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NAMESPACE = 'agnes-media.settings'
    const SECTION_ID = 'dsh-agnes-image-video'
    const BASE = '/plugins/dsh-agnes-image-video'
    // 连通性测试正常一两百毫秒就回来，按钮上那句「测试中…」几乎看不见；
    // 至少压住这么久，让用户确认自己确实点到了、也确实测了。
    const VERIFY_MIN_BUSY_MS = 600

    const IMAGE_SIZES = ['1K', '2K', '3K', '4K']
    const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']
    const VIDEO_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
    const VIDEO_SECONDS = [4, 5, 6, 7, 8, 9, 10, 11, 12]

    // 1K 档的实际像素；更高档位是这个表的整数倍。上游文档里的表。
    const BASE_PIXELS = {
      '1:1': [1024, 1024],
      '3:4': [864, 1152],
      '4:3': [1152, 864],
      '16:9': [1312, 736],
      '9:16': [736, 1312],
      '2:3': [832, 1248],
      '3:2': [1248, 832],
      '21:9': [1568, 672],
    }
    // 720P 六档实测值，和 Agnes Video 2.5 主文档一致（Flash 页那张表六行里五行是错的）。
    const VIDEO_PIXELS = {
      '21:9': '1470x630',
      '16:9': '1280x720',
      '4:3': '1112x834',
      '1:1': '960x960',
      '3:4': '834x1112',
      '9:16': '720x1280',
    }

    function imagePixels(size, ratio) {
      const base = BASE_PIXELS[ratio]
      if (base === undefined) return ''
      const factor = IMAGE_SIZES.indexOf(size) + 1
      if (factor <= 0) return ''
      return base[0] * factor + 'x' + base[1] * factor
    }

    async function call(path, init) {
      const options = { credentials: 'same-origin', ...init }
      options.headers = { accept: 'application/json' }
      if (options.body !== undefined) options.headers['content-type'] = 'application/json'
      let response
      try {
        response = await fetch(BASE + '/' + path, options)
      } catch (error) {
        throw new Error('请求发不出去：' + (error instanceof Error ? error.message : String(error)))
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('宿主没有这个路由（HTTP 404）：插件已装好，但设置页的数据面没挂上，重启一次 DSH 再试')
        }
        throw new Error(body?.error ?? 'HTTP ' + response.status)
      }
      return body
    }

    const STYLE = `
.dsam-page { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 24px; color: var(--dsw-alias-label-primary); }
.dsam-card { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsam-title { font-size: 14px; font-weight: 600; margin: 0; }
.dsam-sub { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsam-row { display: flex; align-items: center; gap: 12px; }
.dsam-row-top { align-items: flex-start; }
.dsam-label { flex: 0 0 132px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsam-control { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsam-input, .dsam-select { height: 30px; box-sizing: border-box; padding: 0 8px; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; outline: none; font-family: inherit; }
.dsam-input { flex: 1 1 240px; min-width: 0; }
.dsam-input:focus, .dsam-select:focus { border-color: var(--dsw-alias-brand-primary); }
.dsam-input:disabled, .dsam-select:disabled { opacity: .55; cursor: not-allowed; }
.dsam-btn { height: 30px; padding: 0 12px; font-size: 13px; font-family: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; cursor: pointer; white-space: nowrap; }
.dsam-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dsam-btn:disabled { opacity: .5; cursor: not-allowed; }
.dsam-btn-primary { color: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-brand-primary); }
.dsam-btn-danger { color: var(--dsw-alias-state-error-primary); }
.dsam-pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; font-size: 12px; border-radius: 11px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dsam-pill-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.dsam-pill-off { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dsam-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsam-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsam-note-ok { color: var(--dsw-alias-state-success-primary); }
.dsam-note-err { color: var(--dsw-alias-state-error-primary); }
/* 结果提示必须贴着触发它的控件显示：挂到页面底部会被三张卡片挤出视口，
   看起来就像「点了没反应」。左侧色条 + 浅底让它在卡片里一眼可见。 */
.dsam-notice { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 10px; font-size: 12px; line-height: 1.6; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); border-left-width: 3px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); word-break: break-word; }
.dsam-notice-ok { border-left-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary); }
.dsam-notice-err { border-left-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary); }
.dsam-notice-icon { flex: 0 0 auto; font-size: 12px; line-height: 1.6; }
.dsam-notice-ok .dsam-notice-icon { color: var(--dsw-alias-state-success-primary); }
.dsam-notice-err .dsam-notice-icon { color: var(--dsw-alias-state-error-primary); }
.dsam-notice-text { flex: 1 1 auto; min-width: 0; }
.dsam-hr { height: 1px; background: var(--dsw-alias-border-l1); border: 0; margin: 2px 0; }
.dsam-meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
`

    function Notice(props) {
      const notice = props.notice
      if (notice === null || notice === undefined) return null
      if (props.where !== undefined && notice.where !== props.where) return null
      return h(
        'p',
        { className: 'dsam-notice ' + (notice.ok ? 'dsam-notice-ok' : 'dsam-notice-err'), role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsam-notice-icon', 'aria-hidden': 'true' }, notice.ok ? '✓' : '!'),
        h('span', { className: 'dsam-notice-text' }, notice.text),
      )
    }

    function Pill(props) {
      const tone = props.tone === 'ok' ? ' dsam-pill-ok' : props.tone === 'off' ? ' dsam-pill-off' : ''
      return h('span', { className: 'dsam-pill' + tone }, props.children)
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsam-row' + (props.top === true ? ' dsam-row-top' : '') },
        h('div', { className: 'dsam-label' }, props.label),
        h('div', { className: 'dsam-control' }, props.children),
      )
    }

    function Select(props) {
      return h(
        'select',
        {
          className: 'dsam-select',
          value: props.value,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.value),
          'aria-label': props.label,
        },
        props.options.map((option) =>
          h('option', { key: String(option.value), value: option.value }, option.label),
        ),
      )
    }

    function AgnesIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: props?.active === false ? 0.75 : 1 },
        },
        h('path', {
          d: 'M4 17.5 8.6 10l3.2 4.6L14.4 11l5.6 6.5',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8.2, cy: 7.2, r: 1.7, stroke: 'currentColor', strokeWidth: 1.7 }),
      )
    }

    function AgnesSettingsPage(props) {
      const t = props.t
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [keyDraft, setKeyDraft] = useState('')
      const [notice, setNotice] = useState(null)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const apply = useCallback((body) => {
        if (mounted.current) setState(body)
      }, [])

      const load = useCallback(async () => {
        try {
          const body = await call('state')
          apply(body)
          if (mounted.current) setError('')
        } catch (failure) {
          if (mounted.current) setError(failure.message)
        }
      }, [apply])

      useEffect(() => {
        load()
      }, [load])

      const settings = state?.settings
      const key = state?.key

      const saveKey = async () => {
        setBusy('key')
        setNotice(null)
        try {
          const body = await call('key', { method: 'POST', body: JSON.stringify({ value: keyDraft }) })
          apply({ ...state, key: body.key })
          setKeyDraft('')
          setNotice({ where: 'key', ok: true, text: body.key.configured ? '已保存，工具下一次调用就会用这把 key' : '已清空' })
        } catch (failure) {
          setNotice({ where: 'key', ok: false, text: failure.message })
        } finally {
          setBusy('')
        }
      }

      const clearKey = async () => {
        setBusy('key')
        setNotice(null)
        try {
          const body = await call('key', { method: 'POST', body: JSON.stringify({ value: '' }) })
          apply({ ...state, key: body.key })
          setKeyDraft('')
          setNotice({ where: 'key', ok: true, text: '已从凭据库移除，环境变量（如果有）重新生效' })
        } catch (failure) {
          setNotice({ where: 'key', ok: false, text: failure.message })
        } finally {
          setBusy('')
        }
      }

      const verify = async () => {
        setBusy('verify')
        setNotice(null)
        // 测试连通性通常 100ms 内就回来，按钮上的「测试中…」一闪而过，用户会以为没反应。
        // 至少压住 600ms，让「确实点了、确实在测」这件事被看见。
        const startedAt = Date.now()
        try {
          const body = await call('verify', { method: 'POST', body: '{}' })
          const waited = Date.now() - startedAt
          if (waited < VERIFY_MIN_BUSY_MS) await new Promise(resolve => setTimeout(resolve, VERIFY_MIN_BUSY_MS - waited))
          setNotice({ where: 'key', ok: body.ok === true, text: body.message })
        } catch (failure) {
          setNotice({ where: 'key', ok: false, text: failure.message })
        } finally {
          setBusy('')
        }
      }

      const patchSettings = async (patch, where) => {
        setBusy('settings')
        setNotice(null)
        try {
          const body = await call('settings', { method: 'POST', body: JSON.stringify(patch) })
          apply({ ...state, settings: body.settings })
        } catch (failure) {
          setNotice({ where: where ?? 'page', ok: false, text: failure.message })
        } finally {
          setBusy('')
        }
      }

      const resetSettings = async () => {
        setBusy('settings')
        setNotice(null)
        try {
          const body = await call('settings', { method: 'POST', body: JSON.stringify({ reset: true }) })
          apply({ ...state, settings: body.settings })
          setNotice({ where: 'page', ok: true, text: '已恢复出厂默认值' })
        } catch (failure) {
          setNotice({ where: 'page', ok: false, text: failure.message })
        } finally {
          setBusy('')
        }
      }

      const imageSizeOptions = useMemo(
        () => IMAGE_SIZES.map((value) => ({ value, label: value + '（' + imagePixels(value, settings?.image.ratio ?? '1:1') + '）' })),
        [settings?.image.ratio],
      )
      const videoSecondsOptions = useMemo(
        () => VIDEO_SECONDS.map((value) => ({ value: String(value), label: value + ' 秒' })),
        [],
      )
      const videoModeOptions = useMemo(
        () => [
          { value: '', label: t('mode.auto') },
          { value: 'text', label: t('mode.text') },
          { value: 'keyframe', label: t('mode.keyframe') },
          { value: 'reference', label: t('mode.reference') },
        ],
        [t],
      )

      const style = h('style', { key: 'dsam-style' }, STYLE)

      if (error !== '') {
        return h(
          'div',
          { className: 'dsam-page' },
          style,
          h('div', { className: 'dsam-card' },
            h('p', { className: 'dsam-title' }, t('title')),
            h('p', { className: 'dsam-note dsam-note-err' }, error),
            h('div', { className: 'dsam-row' },
              h('div', { className: 'dsam-label' }, ''),
              h('div', { className: 'dsam-control' },
                h('button', { className: 'dsam-btn', onClick: load }, t('retry')),
              ),
            ),
          ),
        )
      }

      if (state === null) {
        return h('div', { className: 'dsam-page' }, style, h('p', { className: 'dsam-note' }, t('loading')))
      }

      const keyReady = key?.configured === true
      const keyWritable = key?.credentialService !== false

      return h(
        'div',
        { className: 'dsam-page' },
        style,

        h('div', { className: 'dsam-card' },
          h('p', { className: 'dsam-title' }, t('key.title')),
          h('p', { className: 'dsam-sub' }, t('key.desc')),
          h('div', { className: 'dsam-row' },
            h('div', { className: 'dsam-label' }, t('key.status')),
            h('div', { className: 'dsam-control' },
              h(Pill, { tone: keyReady ? 'ok' : 'off' }, keyReady ? t('key.configured') : t('key.missing')),
              keyReady
                ? h('span', { className: 'dsam-note dsam-mono' },
                    (key.source === 'env' ? t('key.source.env') + ' ' + key.envRef : t('key.source.store') + ' ' + key.credentialRef)
                      + (key.masked ? '  ' + key.masked : ''))
                : null,
            ),
          ),
          h(Row, { label: keyReady ? t('key.replace') : t('key.input') },
            h('input', {
              className: 'dsam-input',
              type: 'password',
              value: keyDraft,
              placeholder: keyWritable ? t('key.placeholder') : t('key.readonly'),
              disabled: !keyWritable || busy === 'key',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setKeyDraft(event.target.value),
            }),
            h('button', {
              className: 'dsam-btn dsam-btn-primary',
              disabled: !keyWritable || busy === 'key' || keyDraft.trim() === '',
              onClick: saveKey,
            }, busy === 'key' ? t('saving') : t('save')),
            h('button', {
              className: 'dsam-btn dsam-btn-danger',
              disabled: !keyWritable || busy === 'key' || !keyReady,
              onClick: clearKey,
            }, t('clear')),
            h('button', {
              className: 'dsam-btn',
              disabled: busy === 'verify' || !keyReady,
              onClick: verify,
            }, busy === 'verify' ? t('testing') : t('verify')),
          ),
          keyWritable
            ? null
            : h('p', { className: 'dsam-note dsam-note-err' }, t('key.noService')),
          h(Notice, { notice, where: 'key' }),
          h('p', { className: 'dsam-note' },
            t('key.envHint') + ' ' + (key?.envRef ?? 'AGNES_API_KEY')),
        ),

        h('div', { className: 'dsam-card' },
          h('p', { className: 'dsam-title' }, t('image.title')),
          h('p', { className: 'dsam-sub' }, t('image.desc')),
          h(Row, { label: t('image.size') },
            h(Select, {
              label: t('image.size'),
              value: settings.image.size,
              disabled: busy === 'settings',
              options: imageSizeOptions,
              onChange: (value) => patchSettings({ image: { size: value } }),
            }),
            h('span', { className: 'dsam-note dsam-mono' },
              t('image.pixels') + ' ' + imagePixels(settings.image.size, settings.image.ratio)),
          ),
          h(Row, { label: t('image.ratio') },
            h(Select, {
              label: t('image.ratio'),
              value: settings.image.ratio,
              disabled: busy === 'settings',
              options: IMAGE_RATIOS.map((value) => ({ value, label: value })),
              onChange: (value) => patchSettings({ image: { ratio: value } }),
            }),
          ),
          h('p', { className: 'dsam-note' }, t('image.hint')),
        ),

        h('div', { className: 'dsam-card' },
          h('p', { className: 'dsam-title' }, t('video.title')),
          h('p', { className: 'dsam-sub' }, t('video.desc')),
          h(Row, { label: t('video.mode') },
            h(Select, {
              label: t('video.mode'),
              value: settings.video.mode,
              disabled: busy === 'settings',
              options: videoModeOptions,
              onChange: (value) => patchSettings({ video: { mode: value } }),
            }),
          ),
          h(Row, { label: t('video.seconds') },
            h(Select, {
              label: t('video.seconds'),
              value: String(settings.video.seconds),
              disabled: busy === 'settings',
              options: videoSecondsOptions,
              onChange: (value) => patchSettings({ video: { seconds: Number(value) } }),
            }),
            h('span', { className: 'dsam-note' }, t('video.cost')),
          ),
          h(Row, { label: t('video.aspect') },
            h(Select, {
              label: t('video.aspect'),
              value: settings.video.aspectRatio,
              disabled: busy === 'settings',
              options: VIDEO_ASPECTS.map((value) => ({ value, label: value + '（' + VIDEO_PIXELS[value] + '）' })),
              onChange: (value) => patchSettings({ video: { aspectRatio: value } }),
            }),
          ),
          h('p', { className: 'dsam-note' }, t('video.hint')),
        ),

        notice === null ? null : h(Notice, { notice, where: 'page' }),

        h('hr', { className: 'dsam-hr' }),
        h('div', { className: 'dsam-meta' },
          h('span', null, t('meta.imageModel')),
          h('span', { className: 'dsam-mono' }, state.models.image),
          h('span', null, t('meta.videoModel')),
          h('span', { className: 'dsam-mono' }, state.models.video),
          h('span', null, t('meta.baseUrl')),
          h('span', { className: 'dsam-mono' }, state.baseUrl),
        ),
        h('div', { className: 'dsam-row' },
          h('div', { className: 'dsam-label' }, ''),
          h('div', { className: 'dsam-control' },
            h('button', {
              className: 'dsam-btn',
              disabled: busy === 'settings',
              onClick: resetSettings,
            }, t('reset')),
          ),
        ),
      )
    }

    const ZH = {
      'nav.panel': 'Agnes 生成',
      title: 'Agnes 图像与视频',
      loading: '正在读取设置…',
      retry: '重试',
      save: '保存',
      saving: '保存中…',
      clear: '清除',
      verify: '测试连通性',
      testing: '测试中…',
      reset: '恢复出厂默认值',
      'key.title': 'API Key',
      'key.desc': '图像和视频两个工具共用这一把 key。存在本机凭据库（AGENS_API_KEY），不进配置文件、不回传明文。',
      'key.status': '状态',
      'key.configured': '已配置',
      'key.missing': '未配置',
      'key.source.env': '来源：环境变量',
      'key.source.store': '来源：凭据库',
      'key.replace': '换一把',
      'key.input': '填一把',
      'key.placeholder': 'sk-…',
      'key.readonly': '这个 profile 没有凭据服务',
      'key.noService': '当前 profile 没有凭据服务，只能把 key 放在环境变量 AGNES_API_KEY 里。',
      'key.envHint': '环境变量优先于这里的值：如果它非空，工具会先用它。',
      'image.title': '图像默认参数',
      'image.desc': '调用 agnes_image_generate 时没写 size / ratio 就用这里的值。',
      'image.size': '输出档位',
      'image.ratio': '宽高比',
      'image.pixels': '实际输出',
      'image.hint': '档位只决定「多大」，宽高由比例决定。要 1920x1080 这类显示器尺寸，选 2K + 16:9 再自己缩放。',
      'video.title': '视频默认参数',
      'video.desc': '调用 agnes_video_generate 时没写 mode / seconds / aspect_ratio 就用这里的值。',
      'video.mode': '模式',
      'video.seconds': '时长',
      'video.aspect': '画幅',
      'video.cost': '按秒计费',
      'video.hint': '「自动」会按这次调用给了哪些素材推断模式；一旦设置了某个模式，只在素材对得上时才用它。',
      'mode.auto': '自动（按素材推断）',
      'mode.text': '纯文字',
      'mode.keyframe': '首尾帧',
      'mode.reference': '参考图 / 音频',
      'meta.imageModel': '图像模型',
      'meta.videoModel': '视频模型',
      'meta.baseUrl': '接口地址',
    }

    const EN = {
      'nav.panel': 'Agnes',
      title: 'Agnes image and video',
      loading: 'Reading settings…',
      retry: 'Retry',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Remove',
      verify: 'Test key',
      testing: 'Testing…',
      reset: 'Restore defaults',
      'key.title': 'API key',
      'key.desc': 'Both tools share this key. It is stored in the local credential store (AGENS_API_KEY), never in the config file, and never echoed back.',
      'key.status': 'Status',
      'key.configured': 'Configured',
      'key.missing': 'Not configured',
      'key.source.env': 'Source: environment',
      'key.source.store': 'Source: credential store',
      'key.replace': 'Replace',
      'key.input': 'Key',
      'key.placeholder': 'sk-…',
      'key.readonly': 'No credential service in this profile',
      'key.noService': 'This profile has no credential service; put the key in the AGNES_API_KEY environment variable instead.',
      'key.envHint': 'The environment variable wins over this value: if it is set, the tools use it.',
      'image.title': 'Image defaults',
      'image.desc': 'Used by agnes_image_generate when size / ratio are omitted.',
      'image.size': 'Size tier',
      'image.ratio': 'Aspect ratio',
      'image.pixels': 'Output',
      'image.hint': 'The tier only sets how large; the ratio sets the shape. For 1920x1080, pick 2K + 16:9 and scale down.',
      'video.title': 'Video defaults',
      'video.desc': 'Used by agnes_video_generate when mode / seconds / aspect_ratio are omitted.',
      'video.mode': 'Mode',
      'video.seconds': 'Duration',
      'video.aspect': 'Aspect ratio',
      'video.cost': 'billed per second',
      'video.hint': 'Auto infers the mode from the media this call supplies; a pinned mode is only used when the media matches it.',
      'mode.auto': 'Auto (from media)',
      'mode.text': 'Text only',
      'mode.keyframe': 'First / last frame',
      'mode.reference': 'Reference images / audio',
      'meta.imageModel': 'Image model',
      'meta.videoModel': 'Video model',
      'meta.baseUrl': 'Endpoint',
    }

    // 可见文案统一走 Client 的 locale 服务；字典注册失败也不影响页面显示中文。
    // 占位符用宿主约定的单花括号写法（{count}），这里保持一致。
    function fallbackT(key, params) {
      let text = ZH[key] ?? key
      if (params !== null && typeof params === 'object') {
        for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
      }
      return text
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = fallbackT
        try {
          ctx.effect(() => ctx.locale.register(NAMESPACE, { zh: ZH, en: EN }), 'agnes-media: settings copy')
          t = ctx.locale.bind(NAMESPACE)
        } catch (error) {
          console.error('[agnes-media] locale registration failed (page falls back to zh):', error)
        }

        // 注册包在 try/catch 里，且 catch 在 inject 回调内部：slots.inject 的回调
        // 可能在宿主声明插槽之后才跑，那时抛出的异常会从微任务里冒出来，
        // 调用点的 try 接不住，用户看到的是整块面板崩掉。
        try {
          ctx.slots.inject('settings.section', () => {
            const disposers = []
            disposers.push(ctx.slots.register({
              name: 'settings.section',
              id: SECTION_ID,
              order: 32,
              label: () => t('nav.panel'),
              locale: NAMESPACE,
              inject: () => ({ t }),
            }, AgnesSettingsPage))
            try {
              const iconInject = ctx.slots.inject('settings.section.icon', () => {
                const iconDisposer = ctx.slots.register({
                  name: 'settings.section.icon',
                  id: SECTION_ID,
                  locale: NAMESPACE,
                }, AgnesIcon)
                disposers.push(iconDisposer)
                return iconDisposer
              })
              if (typeof iconInject === 'function') disposers.push(iconInject)
            } catch (error) {
              console.error('[agnes-media] settings nav icon failed to register (page unaffected):', error)
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose()
                } catch {
                  // 注销路径上的失败没有可做的事。
                }
              }
            }
          })
        } catch (error) {
          console.error('[agnes-media] settings section failed to register (host provider unaffected):', error)
        }
      },
    }
  },
})
