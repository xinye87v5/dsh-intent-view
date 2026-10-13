/**
 * dsh-intent-view 的宿主半边。
 *
 * Cordis loader 需要 profile 行有一个入口；渲染的那一半在浏览器侧
 * （`./client`，由 dsh-client-modules 提供）。
 *
 * ## 这一半为什么不再"什么都不做"
 *
 * 最初这里有意为空，理由是"面板展示的是磁盘上的产物文件，为它们再建一套投影
 * 等于把同一份事实描述两遍"。**那个理由对产物渲染成立，对实时语义不成立**：
 * 意图的分组与转向检测此前写在浏览器侧（`client/intent.ts` 等 893 行），
 * 于是同一份语义有两道实现，实测漂移 1–2 个话题组。
 *
 * DSH 的官方架构是 **capability-seam three-way split**：领域宿主插件贡献
 * **纯折叠**，框架拥有订阅与缓存，载体（浏览器）消费快照。所以正确的形状是
 * **语义在宿主的投影里，浏览器只渲染**。
 *
 * ## 一个 ESM 的坑（实测踩到，宿主直接启动失败）
 *
 * 宿主半边是**纯 ESM，由 Node 直接 import**（不经过 `wrap-client.py` 的内联）。
 * Node 的 ESM 解析**要求相对导入带 `.js` 扩展名**，而 tsc 在
 * `moduleResolution: bundler` 下不会补。
 *
 * 漏了它的后果不是警告，是**整个 `dsh` 启动失败**：
 * `ERR_MODULE_NOT_FOUND … lib/host/intentProjection`。
 *
 * 客户端半边不会暴露这个问题——包装脚本把相对导入**内联**掉了，它们根本不进产物。
 * 所以这个坑只在有宿主半边之后才存在。
 *
 * ## 这里仍然不碰文件系统
 *
 * profile 行在启动路径上实例化，同步 IO 会拖慢宿主启动。读产物文件交给
 * 投影由框架按需驱动，本插件不读文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerIntentProjection } from './host/intentProjection.js'
import { registerSemanticUnit } from './host/semanticUnit.js'
import { registerHandoffUnit } from './host/handoffUnit.js'
import { registerTaskStructure } from './host/taskStructureUnit.js'

/** profile 行标识。 */
export const name = 'dsh-intent-view'

/**
 * 宿主侧依赖声明。
 *
 * **必需，不是可选**：`ctx.get('sessionProjections')` 在没有 inject 声明时直接抛
 * `cannot get property "sessionProjections" without inject`——
 * 而 apply 抛错会让**整个 dsh 启动失败**（实测如此）。
 *
 * `dsh-goal` 用的是同一个写法：`static inject = ["agents", "sessionProjections"]`。
 *
 * 投影服务是 DSH 的核心能力（框架本身就有），所以按**必需**声明是对的；
 * `ctx-compression/docs/23` §7.1 提醒"不要把**可选**服务写进 inject"，
 * 因为服务缺失会让插件整块不挂载——而这里它不该缺失。
 */
export const inject = ['sessionProjections']

/**
 * 宿主侧 apply。
 *
 * @param ctx - loader 交给这个 profile 行的宿主上下文。
 */
export function apply(ctx: Context): void {
  // 注册意图投影：**词面语义**的唯一去处。见 `host/intentProjection.ts`。
  registerIntentProjection(ctx)

  // 语义判定那条缝是**可选**的：它要 `llm`（模型）与 `connection`（HTTP 路由），
  // 而这两个在某些组合里可以缺席。用 `ctx.inject` 做**可选注册**——
  // 写进上面那个必需的 `inject` 数组会让整个插件在缺服务的 profile 里不挂载
  // （`docs/23` §7.1 的提醒）。缺了它们，面板照旧工作，只是没有语义判定。
  ctx.inject(['llm', 'connection'], (scope) => {
    console.log('[intent-view] 可选注入回调跑了（llm + connection 都在）')
    /**
     * **每个单元各自兜错**：注册里任何一处抛错，原来会把后面的注册一起带走——
     * 而症状是"路由 404"，看起来像路由没写对（2026-10-14 实测踩到：新加的
     * 交接单元一抛，结构路由跟着消失）。现在一处失败只影响自己，其余照常。
     */
    const safe = (name: string, run: () => void): void => {
      try {
        run()
      } catch (error) {
        console.error(
          `[intent-view] ${name} 注册失败（其余照常）：`,
          String((error as Error)?.message ?? error).slice(0, 200),
        )
      }
    }
    safe('语义判定', () => registerSemanticUnit(scope))
    safe('交接摘要', () => registerHandoffUnit(scope))
    // 人工调整（落点/改名/挂枝/合并…）**不再走宿主路由**（B4-5）：
    // 使用者裁定持久化落在"插件的部件内"，实现定为浏览器侧 localStorage
    // （`shared/overrideStorage.ts`），人就在浏览器里改。宿主那条路由与它的进程内 store 已删，
    // 免得"哪份是真的"变成第二个问题。
    // 任务结构：四段流水线（建结构 → 分批判归属 → 判整理 → 根裁定）+ 承接 + strip。
    // 与语义核查那条路各自独立：失败面不同，任何一段挂了只影响自己。
    safe('任务结构', () => registerTaskStructure(scope))
  })
}
