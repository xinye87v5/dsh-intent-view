/**
 * **主区对话视图**（`conversation.view` slot）的挂载壳。
 *
 * ## 为什么加这一条
 *
 * 面板原先只挂在第三方右侧栏（`betterSidebar.registerTab`）。主区那条路（Chat / Trajectory
 * 同级）有三个好处：**宽度**（现在这套密度是为窄列调的，树/徽标/回合摘要/编辑栏都在挤）、
 * **少一个第三方 peer 依赖**、以及主区 tab 在无头窗口里可能可点（那能把
 * "真浏览器点不了面板"这条验证限制划掉）。调查见
 * `research/conversation-view-mounting-2026-10-10.md`。
 *
 * ## 契约（照 `dsh-client-ui-trajectory` 的用法）
 *
 * ```js
 * ctx.slots.inject('conversation.view', () => ctx.slots.register({ name, id, order, label, inject }, Component))
 * ```
 * **第二个参数就是视图组件**——这一点在轨迹页里是 `}, TrajectoryView));`。
 *
 * ## 两个刻意的做法
 *
 * 1. **`ctx` 从闭包拿，不从 slot props 拿**：面板要 `ctx.get('sessions')` 读快照，
 *    而 slot 的 props 面很重（会话/工作区快照、composer、store、locale…）且形状会变。
 *    注册发生在 `apply(ctx)` 里，直接闭包引用最稳；
 * 2. **`slots` 当软依赖**（`ctx.get('slots')`，**不写进 `inject` 数组**）：写进 `inject`
 *    的话，缺这个服务的组合会连插件本身一起不激活（`apply` 都不跑、诊断钩子也没有）；
 *    软依赖保持"缺 `slots` 就静默不注册、其余照常"。
 */
import { createElement } from 'react'
import { IntentTab, type IntentTabProps } from './IntentTab'

/** slot props 里我们真正要找的东西：**当前会话 id**。 */
export interface SlotPropsLike {
  sessionId?: unknown
  inject?: { sessionId?: unknown }
  scope?: { sessionId?: unknown }
  session?: { id?: unknown }
  binding?: { sessionId?: unknown }
}

/**
 * **从 slot props 里取出会话 id**（纯函数，可离线断言）。
 *
 * 为什么这么防御：`conversation.view` 的 props 由框架按注册项的 `inject` 面组合，
 * 我们只声明了 `inject: (sessionId) => ({ sessionId })`，但不同版本可能把它放在
 * `props.inject.sessionId` / `props.sessionId` / `props.scope.sessionId` 等位置。
 * **取不到就返回 undefined**（面板自己有"没有选中会话"的提示，不会白屏）——
 * 猜错形状的代价只是显示那句提示，不是崩。
 */
export function slotSessionId(props: SlotPropsLike | undefined): string | undefined {
  const candidates = [
    props?.sessionId,
    props?.inject?.sessionId,
    props?.scope?.sessionId,
    props?.session?.id,
    props?.binding?.sessionId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

/**
 * 主区视图组件：把 slot 的 props **降级成面板已经认识的那三个字段**
 * （`ctx` / `visible` / `scope.sessionId`），于是组件主体 `IntentTab` 一行都不用改——
 * 512 条断言打的还是同一份主体。
 */
export function makeConversationView(ctx: unknown): (props: SlotPropsLike) => unknown {
  return function IntentConversationView(props: SlotPropsLike) {
    // 面板自己的 props 面（`IntentTabProps`，定义在 IntentTab.ts）：**不再借第三方的类型**，
    // 于是这里也不需要 `as unknown as` 那种掩盖形状的转换。
    const view: IntentTabProps = {
      ctx,
      visible: true,
      // **主区是宽区**：只调版式四个数（内边距/限宽/摘要长度/每节点条数），不重排结构
      wide: true,
      scope: { sessionId: slotSessionId(props) },
    }
    return createElement(IntentTab, view)
  }
}

/** 主区视图的注册参数（id / 顺序 / 标题）。 */
export const CONVERSATION_VIEW = {
  name: 'conversation.view',
  id: 'intent-view',
  /** 排在轨迹页（order 10）之后。 */
  order: 20,
  label: '意图',
} as const

/**
 * 注册主区视图。**软失败**：任何一步不成立就返回 false（调用方只管日志），
 * 绝不因为主区那条路坏了而影响侧栏那条。
 */
export function registerConversationView(ctx: unknown): boolean {
  const slots = (ctx as { get?: (name: string) => unknown })?.get?.('slots') as
    | { inject?: (name: string, callback: () => unknown) => unknown; register?: unknown }
    | undefined
  if (slots?.inject === undefined || slots.register === undefined) return false
  try {
    slots.inject(CONVERSATION_VIEW.name, () =>
      (slots.register as (def: unknown, component: unknown) => unknown)(
        {
          name: CONVERSATION_VIEW.name,
          id: CONVERSATION_VIEW.id,
          order: CONVERSATION_VIEW.order,
          label: () => CONVERSATION_VIEW.label,
          inject: (sessionId: string) => ({ sessionId }),
        },
        makeConversationView(ctx),
      ),
    )
    return true
  } catch {
    return false
  }
}
