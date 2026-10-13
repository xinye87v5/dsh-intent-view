/**
 * 把宿主算好的 `intent` 投影**适配**成面板要的模型——**不做任何语义计算**。
 *
 * ## 为什么有这个文件
 *
 * DSH 的官方架构是 **capability-seam three-way split**：领域宿主插件贡献**纯折叠**，
 * 框架拥有订阅与缓存，载体（浏览器）消费快照。
 * 契约原文：*"How a value is rendered is the slot system's business, never this layer's."*
 *
 * 本插件此前把语义写在浏览器侧（`buildIntentModel` 里的分组、转向、贴合度，
 * 约 740 行）。那些计算已经搬到 `src/host/intentProjection.ts` 的 `wire.view`，
 * 所以这里只做**形状转换**：投影载荷 → 渲染模型。
 *
 * **这个文件里不该出现任何 `bigrams` / `overlap` / 阈值比较。**
 * 一旦出现，语义就又有两处了。
 *
 * ## 话题组口径已经整块离开 wire（`stateVersion` 9）
 *
 * 这里曾经还转一样东西：`groups`（话题组，每组一个派生目标）。划分表达不了
 * **重叠归属**——一个回合可以同时推进两件事、落在两个任务节点上（真 DAG），
 * 而划分要求每个回合恰好属于一个组。面板换成 DAG 树（②）之后，投影侧
 * `groups` / `localFit` / `promptSize` / `brief` / `lowFitCount` / `shifts`
 * 全部下线（③），这里也就只剩回合材料。
 *
 * **一处如实标注的降级**：用户手动指定的基线（`override`）**只影响根节点的显示**。
 * 任务结构由宿主按会话的真实回合内容算出，不会因为你在浏览器里改了一段文本而重算。
 * 这是**能力的损失**，换来的是"语义只有一处"。
 */

import { snippet } from '../shared/intent'
import type { IntentModel, IntentTurn } from './intent'

/** 投影里 `intent` 键的载荷。形状与宿主 `IntentView` 对应。 */
export interface IntentProjection {
  turnCount: number
  firstSeq: number
  lastSeq: number
  /** 目标时间线：每次 `goal/change` 一条。 */
  goalTimeline?: { turn: number; operation: string; revision: number | null }[]
  /** 当前目标建立于第几回合（从 `goal/change` 的 `create` 推出）。 */
  goalOnset?: number
  /**
   * 逐回合材料。`prompt` 是 `stateVersion` 8 加的键，`statement` 更早——
   * 旧缓存行缺哪个就少哪个，所以两个都是可选的。
   */
  turns?: {
    turn: number
    /** 用户原文（截断到宿主侧的 `PROMPT_LIMIT`）。 */
    prompt?: string
    /** agent 当时的理解（宿主对每回合都抽，抽不到就没有）。 */
    statement?: string
  }[]
  /** 当前内容指纹。见 `host/intentProjection.ts` 的 `IntentView.contentHash`。 */
  contentHash?: string
}

export interface SessionProjectionLike {
  intent?: IntentProjection | null
  goal?: { goal?: { objective?: string; revision?: number } } | null
  title?: string | null
  turnOutline?: { turn?: number; prompt?: string; response?: string }[] | null
}

/**
 * 从投影造出渲染模型。
 *
 * @param projection - 客户端的 `projectionValues` 子集。
 * @param title - 会话标题（没有 goal 时作根节点文字）。
 * @param override - 用户手写的基线；**只影响根节点显示**，见文件头。
 * @returns 渲染模型。`projection.intent` 缺失时 `turns` 为空、`notes` 说明原因。
 */
export function modelFromProjection(
  projection: SessionProjectionLike | undefined,
  title: string,
): IntentModel {
  const notes: string[] = []
  const intent = projection?.intent ?? undefined
  const outline = projection?.turnOutline ?? []
  const goalBlock = projection?.goal ?? undefined
  const sessionObjective = String(goalBlock?.goal?.objective ?? '')

  // **目标建立于第几回合** —— 从 `goal/change` 事件的真实回合号来。
  // 这里曾经写死 0 并注明"不可观测"，那个结论是错的：事件流里带着回合号，
  // 只是当时没有 fold `goal/change`。
  const timeline = intent?.goalTimeline ?? []
  const onset = intent?.goalOnset ?? 0

  let rootLabel: string
  let rootDetail: string
  let rootProvenance: 'derived' | 'inferred'
  if (sessionObjective) {
    rootLabel = snippet(sessionObjective, 120)
    rootDetail = `目标 · 第 ${goalBlock?.goal?.revision ?? '?'} 版`
    rootProvenance = 'derived'
  } else if (title) {
    rootLabel = snippet(title, 120)
    rootDetail = '会话标题（未声明目标）'
    rootProvenance = 'inferred'
    notes.push('此会话没有 goal 投影；根节点用的是会话标题，标为 inferred')
  } else {
    rootLabel = '（无标题、无目标）'
    rootDetail = ''
    rootProvenance = 'inferred'
    notes.push('会话既无 goal 也无标题')
  }

  // 逐回合：**文本优先取宿主折叠的那份**（`intent.turns[].prompt`），
  // 官方 `turnOutline` 只作回落。
  //
  // 两者都从同一个 `turn/end` 事件来，但 `turnOutline` 的截断是按侧栏卡片的
  // 显示行数定的，而任务结构的分批判归属要的是"这一回合用户到底说了什么"。
  // 宿主把 `prompt` 放进 wire 就是为这件事（见 `IntentView.turns` 的字段说明）。
  const signals = new Map(intent?.turns?.map((item) => [item.turn, item]) ?? [])
  const turns: IntentTurn[] = outline.map((raw, index) => {
    const turn = Number(raw.turn ?? index + 1)
    const signal = signals.get(turn)
    const hostPrompt = typeof signal?.prompt === 'string' ? signal.prompt : ''
    return {
      turn,
      prompt: hostPrompt !== '' ? hostPrompt : String(raw.prompt ?? ''),
      response: String(raw.response ?? ''),
      // **只在有值时带上**：这个字段在投影里就是可选的（绝大多数回合没有），
      // 写成 `?? ''` 会让"没有"和"空串"混成一件事。
      ...(signal?.statement ? { statement: signal.statement } : {}),
    }
  })

  if (intent === undefined) {
    notes.push(
      '**这个会话还没有意图投影。** 投影是宿主按会话日志折叠出来的，' +
        '新会话或日志尚未加载的会话还没有值——打开它的对话再回来看。',
    )
  } else if ((intent.turnCount ?? 0) === 0) {
    // **"有投影但一个回合都没有"要和"没有投影"分开说。**
    //
    // 合并成一句会让新会话看起来像"还没加载"，而它其实已经加载好了——
    // 只是真的没内容。这个区别决定了用户是继续等还是去提问。
    notes.push('**这个会话还没有回合。** 一问一答才算一个回合；有回合之后，这里会出现任务结构。')
  } else {
    // **目标何时建立、改过几次** —— 从 `goal/change` 事件算，不是猜的。
    if (timeline.length === 0) {
      notes.push('此会话没有 `goal/change` 事件；根节点用的是会话标题，标为 inferred')
    } else if (onset > 0) {
      // **只数"当前目标建立之后"的变更。**
      //
      // 一个会话可能有多个目标（实测某会话：turn 0 create → pause → turn 4 clear
      // → turn 58 create → pause）。数整条时间线会把**上一个目标**的变更也算进来，
      // 于是"当前目标改过几次"这个说法就是错的。
      const created = timeline.map((item) => item.operation).lastIndexOf('create')
      const changes =
        created < 0
          ? 0
          : timeline.slice(created + 1).filter((item) => item.operation !== 'create').length
      notes.push(
        `目标建立于**第 ${onset} 回合**` +
          (changes > 0 ? `，之后有 ${changes} 次变更` : '') +
          '——判据是 `goal/change` 事件的真实回合号（**不是** `roundsStarted`，' +
          '那是目标寿命内的计数，把它当回合号会错得离谱）',
      )
    }
    notes.push(
      '任务结构（DAG）**由宿主的四段流水线算出**，浏览器只渲染' +
        '（DSH 的 capability-seam：领域插件贡献纯折叠，载体只管显示）',
    )
  }

  return {
    rootLabel,
    rootDetail,
    rootProvenance,
    turns,
    turnCount: intent?.turnCount ?? outline.length,
    contentHash: String(intent?.contentHash ?? ''),
    goalTimeline: timeline,
    notes,
  }
}
