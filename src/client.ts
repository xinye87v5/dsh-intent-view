/**
 * dsh-intent-view 的浏览器半边：把**意图面板挂到主区对话视图**
 * （DSH 自带的 `conversation.view` slot，与 Chat / Trajectory 同级）。
 *
 * 组件本体在 `./client/IntentTab`，挂载壳在 `./client/conversationView`；
 * 这里只负责注册、诊断钩子与依赖处理。
 *
 * ## 数据从哪来
 *
 * 会话作用域的标准 props 由 slot 给（`inject: (sessionId) => ({ sessionId })`），
 * 而面板要的**任务意图**走宿主贡献的投影单元
 * （`ctx.sessionProjections.register()`，见 `host/intentProjection.ts`）。
 *
 * 这条通路的代价是真实的（多一个宿主单元、多一个投影键），换来的是
 * **数据是活的**：订阅会话、随回合更新。而意图本来就是随时间演变的东西,
 * 静态产物表达不了它。
 *
 * ## 与 graph-view 零关联
 *
 * 本插件此前还注册过一个"查看 graph-view 产物"的文件查看器。**已移除**：
 * 意图展示与图渲染是两件事，各有各的数据通路。混在一个插件里会让
 * 包描述与名字只能覆盖其中一个。
 */

import { loadOverrides, saveOverrides } from './shared/overrideStorage'
import { registerConversationView } from './client/conversationView'

/**
 * Cordis 的服务依赖声明。
 *
 * **没有这个导出，`apply` 永远不会被调用。** Cordis 靠它知道要等哪些服务就绪，
 * 在那之前不激活这个插件的 fiber。
 *
 * 这是踩出来的：第一版只导出了 `apply`，模块**正常加载**、`loadCache` 里**能看到它**、
 * 页面**零错误**——但面板就是不出现。查注册表才发现 `apply` 从未被调用。
 *
 * **数组是空的**（2026-10-14：使用者裁定"sidebar 里面不需要了"）。原先声明 `betterSidebar`
 * ——那是右侧栏那条挂载路的服务。现在只挂主区对话视图，而它要的 `slots` 是**软依赖**
 * （`ctx.get('slots')`，**故意不写进来**）：写进来的话，缺这个服务的组合会连 `apply` 都不跑
 * （诊断钩子也随之消失）；软依赖则保持"缺 `slots` 就静默不注册，其余照常"。
 */
export const inject: string[] = []



/**
 * 客户端上下文的**结构**视图。
 *
 * 不 `import type { Context } from '@deepseek-ai/cordis'`：那是个只在本包
 * devDependencies 里存在的名字，而类型 import 会被抹掉——编译能过，运行时却可能
 * 在 DSH 不向浏览器模块图提供该包时无声失败。声明真正用到的成员即可。
 */
interface ClientContextLike {
  get(name: string): unknown
}

/**
 * 浏览器侧 apply。
 *
 * **不读任何第三方服务**：侧栏那条路（`betterSidebar`）连同它的类型依赖一起删掉了，
 * 唯一的挂载路是主区对话视图，它要的 `slots` 走软依赖。
 *
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContextLike): void {
  /**
   * **主区对话视图**（Chat / Trajectory 同级）。软依赖 `slots`：取不到就当没有
   * （`registerConversationView` 返回 false，只记一行日志，不抛）。
   * 契约与取舍见 `client/conversationView.ts` 与
   * `research/conversation-view-mounting-2026-10-10.md`。
   */
  const registeredView = registerConversationView(ctx)
  if (registeredView) {
    try {
      console.log('[dsh-intent-view] 主区视图已注册（conversation.view: intent-view）')
    } catch {
      // 没有 console 的环境（测试）不该因此失败
    }
  }

  // 诊断钩子，**只在 localhost 上挂**。
  //
  // 它暴露了服务对象本身，在别人的浏览器里那是没必要的攻击面。而它确实有用：
  // 上一个 bug（`apply` 从未被调用）就是靠它才定位的——模块加载成功、`loadCache`
  // 里有它、页面零错误，但 tab 不出现。没有这个钩子就只能继续猜。
  //
  // 判断依据是 `location.hostname`：开发与测试实例都在回环上。
  const host =
    typeof location === 'undefined' ? '' : String(location.hostname || '')
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    ;(globalThis as { __intentViewDiagnostics?: unknown }).__intentViewDiagnostics = {
      /** 主区视图是否注册成功（探针与 e2e 读它）。 */
      conversationView: registeredView,
      /** 任意服务探测：插件的 ctx 上到底有什么可用。 */
      ctxGet: (name: string) => ctx.get(name),
      /**
       * 读投影值：验证"宿主算的、浏览器读到了"。
       *
       * 返回每个会话的 `projectionValues.intent` 摘要——它是**宿主折叠算出来的**，
       * 浏览器只读不算。链路不通时这里就是 undefined/absent。
       */
      /**
       * **覆盖存储的往返自检**（真机验证用）。
       *
       * 为什么要有它：`localStorage` 那条链（键名、序列化、浏览器真实行为）只有
       * **真浏览器**能验，而"打开面板、改一条、刷新"这套动作依赖 UI——CDP 探针一直
       * 没能把意图 tab 打开（`openTab` 与 `+` 引导页两条路都试过）。
       * 这个函数走**面板同一条代码路径**（`saveOverrides` / `loadOverrides`），
       * 于是"刷新后还在不在"可以**不开面板**地机器验证。
       */
      overrideRoundTrip: (sessionId: string, list?: unknown[]) => {
        const before = loadOverrides(globalThis.localStorage, sessionId)
        // **不传 list = 只读**（第一版"省略就写示例"，于是探针第二步"刷新后再读"
        // 读到的其实是它自己上一步写进去的示例——读操作会写，就没法验"刷新后还在"）
        if (list === undefined) return { read: before, same: true }
        const saved = saveOverrides(globalThis.localStorage, sessionId, list as never)
        const after = loadOverrides(globalThis.localStorage, sessionId)
        return { saved, before, wrote: list, read: after, same: JSON.stringify(after) === JSON.stringify(list) }
      },
      intentProbe: (idPrefix?: string) => {
        const svc = ctx.get('sessions') as
          | { list?: { getSnapshot?: () => { ids: string[]; byId: Record<string, { projectionValues?: Record<string, unknown> }> } } }
          | undefined
        const snap = svc?.list?.getSnapshot?.()
        if (snap === undefined) return { error: 'no sessions.list snapshot' }
        const out: Record<string, unknown> = { keys: [] as string[] }
        const keys = new Set<string>()
        let samples = 0
        for (const id of snap.ids) {
          if (idPrefix !== undefined && !id.includes(idPrefix)) continue
          const pv = snap.byId[id]?.projectionValues
          if (pv === undefined) continue
          for (const k of Object.keys(pv)) keys.add(k)
          const intent = pv['intent'] as
            | {
                turnCount?: number
                turns?: {
                  turn: number
                  /** 用户原文（`stateVersion` 8 起的键）。 */
                  prompt?: string
                  statement?: string
                }[]
                compactionTurns?: number[]
                goalOnset?: number
                goalTimeline?: { turn: number; operation: string }[]
                contentHash?: string
              }
            | undefined
          if (intent !== undefined && (intent.turnCount ?? 0) > 0) {
            const summary = {
              id: id.slice(0, 14),
              turnCount: intent.turnCount,
              // 简报回合里抽到"agent 理解"的条数——这条数据通路要能看见
              statementCount: intent.turns?.filter((t) => t.statement).length,
              // 带用户原文的条数：结构流水线的材料就是它（缺这个键 = 旧缓存行）
              promptCount: intent.turns?.filter((t) => (t.prompt ?? '') !== '').length,
              compactionTurns: intent.compactionTurns,
              goalOnset: intent.goalOnset,
              goalTimeline: intent.goalTimeline?.map((g) => `${g.turn}:${g.operation}`),
              contentHash: intent.contentHash?.slice(0, 8),
              firstTurns: intent.turns
                ?.slice(0, 3)
                .map((t) => `${t.turn}:${(t.prompt ?? '').slice(0, 18)}`),
            }
            // `sample0` 是"随便一个会话"，用来证明链路通；另外两个按需挑，
            // 因为**随便挑的那个很可能既没有目标也没有压缩**，验不到那两条通路。
            if (samples === 0) (out['sample0'] = summary), (samples += 1)
            if (out['goalSample'] === undefined && (intent.goalTimeline?.length ?? 0) > 0) out['goalSample'] = summary
            if (out['compactionSample'] === undefined && (intent.compactionTurns?.length ?? 0) > 0) out['compactionSample'] = summary
          }
        }
        out['keys'] = [...keys].sort()
        out['intentSamples'] = samples
        return out
      },
    }
  }

  // 扩展点只注册一个：主区对话视图（在 `apply` 开头，`registerConversationView`）。
  //
  // **侧栏注册已删除**（使用者 2026-10-14："sidebar 里面不需要了，现在 tab 看着没什么问题了"），
  // 连同 `betterSidebar` 服务读取、它的类型 import 与 devDependency 一起清掉——
  // 发布出去的树里不再有任何第三方运行时依赖。
}
