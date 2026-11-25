// Agnes 图像 / 视频生成插件入口。
//
// 两个工具都只是「往 api.agnes-ai.cn 发请求、把结果落到会话目录」，
// 没有共享状态需要维护，所以注册逻辑很薄：拿到 tools 服务就注册两个定义，
// 卸载时把两个注销函数都调掉。
//
// 一处刻意的设计：API Key 不在 apply 时解析。用户可能刚装完插件才去填 key，
// 也可能中途换 key；每次调用重新解析才能让「填完立刻能用」成立。
//
// 另一半是设置页要用的 HTTP 路由（`lib/routes.js`）：webServer 只在宿主提供时
// 才有，所以挂在 `ctx.inject(['webServer'], …)` 里，拿不到就静默跳过 ——
// 工具本身照常可用，只是没有设置页。

import { createAgnesImageTool } from './lib/image-tool.js'
import { createAgnesVideoTool } from './lib/video-tool.js'
import { registerAgnesRoutes } from './lib/routes.js'

export const name = 'agnes-media'
export const inject = ['tools']

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const deps = { ctx, logger }
  const disposers = []

  ctx.inject(['tools'], (toolsCtx) => {
    const register = (definition) => {
      try {
        const dispose = toolsCtx.tools.register(definition)
        disposers.push(dispose)
        return true
      } catch (error) {
        // 工具注册失败不该拖垮整个插件：另一个工具通常还能用。
        logger.warn?.('注册工具 ' + definition.name + ' 失败：' + (error instanceof Error ? error.message : String(error)))
        return false
      }
    }

    register(createAgnesImageTool(deps))
    register(createAgnesVideoTool(deps))

    toolsCtx.effect(() => () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch (error) {
          logger.warn?.('注销工具失败：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }, 'agnes-media.tools')
  })

  // 设置页的数据面。没有 webServer 的宿主上这一段直接不生效，不影响工具。
  ctx.inject(['webServer'], (webCtx) => {
    let disposeRoutes
    try {
      disposeRoutes = registerAgnesRoutes(webCtx, logger)
    } catch (error) {
      logger.warn?.('agnes-media 设置路由挂载失败：' + (error instanceof Error ? error.message : String(error)))
      return
    }
    webCtx.effect(() => () => {
      try {
        disposeRoutes?.()
      } catch {
        // 卸载路径上的失败没有可做的事。
      }
    }, 'agnes-media.routes')
  })

  return () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose?.()
      } catch {
        // 卸载路径上的失败没有可做的事，吞掉即可。
      }
    }
  }
}
