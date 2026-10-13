/**
 * 意图投影：**语义唯一去处**的宿主侧折叠。
 *
 * ## 为什么在这里，而不是在浏览器里
 *
 * DSH 的官方架构是 **capability-seam three-way split**
 * （`@deepseek-ai/dsh-session-projection` 契约原文）：
 *
 * > 框架拥有订阅、watermark 缓存、变更通知；**领域宿主插件贡献纯折叠
 * > （pure fold）+ 可选的客户端视图**；载体消费快照与变更流；两侧互不知道对方。
 *
 * 而本插件此前把语义写在浏览器侧（`client/intent.ts` 等 893 行），
 * 于是**同一份语义有两道实现**（Python 侧 `parse_intent.py` + TS 侧），
 * 靠注释维持一致。实测漂移 1–2 个话题组。
 *
 * 契约给出的形状是：**fold 在宿主，渲染在浏览器**——
 * "How a value is rendered is the slot system's business, never this layer's."
 *
 * ## 每回合只做 O(1) 的工作
 *
 * `apply` 在**每个已提交事件**上跑（eager drive），所以这里只累积
 * 每回合的提示与响应**文本**——分组、转向检测、组内贴合度都是**全局批处理**，
 * 放进 fold 会退化成 O(n²)。
 *
 * 出口是契约里那个可选的 `wire`：**`view(state)` 只在快照被读时调用**，
 * 全局计算放那里。（当前这一步是链路验证，`view` 先只做统计。）
 *
 * ## 状态的形状
 *
 * 只留 `turn` 号与两段文本，**不预先算二元组**：状态必须是纯 JSON
 * （持久化缓存的前提），而 `Set` 不是。二元组是全 JSON 可表达的字符串数组，
 * 但那会让状态膨胀；先留文本，等第二步迁移语义时再定。
 */

import { z } from 'zod'
// 语义的唯一实现：`shared/` 是纯函数，宿主与浏览器两侧共用。
// 只 import 还用得着的：`goalStatement` 抽"agent 当时的理解"，`STATEMENT_LIMIT` 是它的上限。
// （`bigrams` / `BRIEF_PROMPT` 在**这里**已经不用了——判"是不是简报回合"挪到了
// `shared/semantic.ts` 的选回合策略里，宿主不再自己筛。）
import { STATEMENT_LIMIT, goalStatement } from '../shared/intent.js'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { semanticFingerprint } from '../shared/semantic.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
// **副作用导入**：`ctx.sessionProjections` 的声明合并来自这个包的根入口，
// 只 import 它的 `/types` 子路径拿不到那个合并。官方包也这样引。
import '@deepseek-ai/dsh-session-projection'

/**
 * 浏览器可见的投影键。
 *
 * **声明合并**进官方表——与 `dsh-goal` / `dsh-session-turn-outline` 同一做法。
 * 合并之后 `sessions.list` 里每个会话的 `projectionValues.intent` 就有类型了。
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 意图投影的客户端载荷。见 `intentView`。 */
    intent: IntentView
  }
  interface SessionProjectionStateMap {
    /** 意图投影的宿主侧折叠状态。**纯 JSON**。 */
    intent: IntentState
  }
}

/**
 * 宿主侧折叠状态。
 *
 * 与 `dsh-session-turn-outline` 的形状刻意保持一致（`turn` + `seq` + 两段文本），
 * 因为那个投影是权威样本：它证实了 `prompt` 与 `response` 的截断上限
 * （50 / 120 字符）以及 `turn/start` 作为锚点的做法。
 */
export interface IntentState {
  /** 每个回合一条：回合号、锚点 seq、提示与响应文本。 */
  turns: {
    turn: number
    /** 锚点 seq。用官方的品牌类型 `SessionSeq`，与状态表声明一致。 */
    seq: SessionSeq
    prompt: string
    response: string
    /**
     * ⚠️ 这里原本存着 `terms`（prompt + response 的二元组集合），**已删**。
     *
     * 它当年只为"话题组"服务——分组要在每次快照时反复比较集合，所以放进 fold 缓存。
     * 使用者裁定弃组、只保留 DAG 之后，它没有消费者了：承接语检测只需要
     * `bigrams(prompt).size`（**现算**，一次线性扫描，不必存整集合）。
     *
     * 删掉它同时省下每个回合一份集合的内存（139 回合的会话是几万个短串）。
     */
    /**
     * **agent 当时把任务理解成了什么**：从靠前的思考里抽出的那一句。
     *
     * **每一回合都抽**（`stateVersion` 10 起；此前只抽简报回合），抽不到就是空串。
     * 理由见 `shared/intent.ts` 的 `goalStatement` 与下面 `turn/end` 分支的说明：
     * 简报回合里用户只说了「同意」，原话没有任何具体指称（产物记号一个都没有，
     * 实测 n=211 里 0 个）；而 agent 的复述是完整的一句话。
     *
     * **只为显示而存**，不参与任何判定——拿它当切分判据已被否掉
     * （`tools/test-early-reasoning-signal.mjs`：边际 ≤0.012 且安慰剂一样好）。
     */
    statement: string
  }[]
  /**
   * 发生过压缩的回合号，升序去重。
   *
   * **从事件流里收集**（`compaction/start` 自带 `turn`），不靠外部文件。
   * 第一版打算让调用方传进来，但**压缩回合是按会话的**，而投影定义是全局注册的
   * ——那样只能全局固定一份，等于错。fold 本来就看得见这些事件，就地收集才对。
   */
  compactionTurns: number[]
  /**
   * 目标的生命周期：**每次 `goal/change` 的完整快照**。
   *
   * `goal/change` 是**完整快照事件**（不是 delta），自带 `operation`、
   * `goal`（含 objective 与 revision）与 `roundsStarted`。
   *
   * 这里只留界面需要的几项——状态必须是纯 JSON，而且整份 objective 已经在
   * `goal` 投影里有了，不必重复存。
   */
  goalTimeline: {
    /** 折叠到这一刻时的回合号。 */
    turn: number
    /** `create` / `edit` / `pause` / `resume` / `clear` / `complete`。 */
    operation: string
    /** 目标版本号。`clear` 时为 null。 */
    revision: number | null
  }[]
}

/**
 * 客户端载荷。
 *
 * **只发回合相关的东西**（`stateVersion` 9 起）。
 *
 * 这里曾有一整套"话题组"口径：`groups`（划分）、每回合的 `localFit` /
 * `promptSize` / `brief`、`lowFitCount`、以及 `shifts`（话题转向）。
 * 它们全部在**面板侧**被 DAG 结构取代（②），随后计算也一并下线（③）——
 * 划分表达不了重叠归属，而结构是重叠的：一个回合可以落在多个任务节点上，
 * 一个节点也可以有多个父节点。组口径的字段留在 wire 上只会让浏览器
 * 继续读一份已经没人维护的视图。
 *
 * 现在每回合只带：回合号、用户原文（结构流水线与无结构时的回退列表都要它）、
 * 以及简报回合的 `statement`（agent 当时的理解，语义核查的材料之一）。
 */
export interface IntentView {
  /** 累积到几个回合。 */
  turnCount: number
  /** 锚点 seq 的范围，用于核对水位。 */
  firstSeq: number
  lastSeq: number
  /** 逐回合材料：由宿主算，浏览器只显示。 */
  turns: {
    turn: number
    /**
     * 用户原文（截断）。
     *
     * `stateVersion` 8 加的键。**发给浏览器是因为结构流水线要用它**：
     * 分批判归属时喂给模型的就是"第 N 回合：<原文>"，而流水线跑在宿主侧、
     * 材料只能来自投影；浏览器侧那份不带原文的回合列表是无结构时的回退视图。
     */
    prompt?: string
    /**
     * **agent 当时把任务理解成了什么**（从靠前的思考里抽出的一句话）。
     *
     * 抽得到时才有这个字段（宿主对每回合都抽）。**它不是用户说的话**，
     * 界面必须标出来。缺省 = 没有。
     */
    statement?: string
  }[]
  /**
   * 发生过压缩的回合号，升序。
   *
   * **这是折叠时从事件流收集的**（`compaction/start` 自带 `turn`），
   * 所以随投影一起发出去即可——客户端**不需要读任何文件**。
   *
   * 这个字段曾经缺失，导致客户端只能去读一份外部报告，而插件没有可用的
   * 读文件通道，于是整块压缩标记成了死代码。**状态里已有的东西就该发出去。**
   */
  compactionTurns: number[]
  /**
   * 目标时间线：每次 `goal/change` 一条。
   *
   * **这是"目标何时被改过"的唯一来源。** 官方的 `goal` 投影只有**当前值**，
   * 没有历史；而事件流里有完整快照。
   */
  goalTimeline: {
    turn: number
    operation: string
    revision: number | null
  }[]
  /**
   * 当前目标建立于第几回合。
   *
   * **从 `goal/change` 的 `create` 事件推出来**，不是从 `roundsStarted`。
   *
   * 这里曾经写死为 0 并注明"不可观测"——**那个结论是错的**：
   * `roundsStarted` 确实是"目标寿命内的计数"（把它当回合号用会错 89 个回合），
   * 但**事件流里带着真正的回合号**，而我当时没有 fold `goal/change`。
   *
   * `0` 表示没有目标，或目标在第 1 回合之前就已存在（`turn` 从 0 起算）。
   */
  goalOnset: number
  /**
   * **当前内容的指纹。**
   *
   * 浏览器拿它跟"上一次语义判定的指纹"比：不相等就去触发一次判定（A+C 里的 C）。
   * 判定结论**不落在日志里**（原因见 `host/semanticUnit.ts` 顶部），
   * 所以这里只发指纹，不发结论。
   * 由 `view` 现算（纯函数），所以永远反映当前状态，不会过期。
   */
  contentHash: string
}

/**
 * 文本预算：**不照抄 `turnOutline` 的 50 / 120**，因为两者的用途不同。
 *
 * `turnOutline` 的上限是按侧栏卡片的显示行数定的（一行 prompt、三行 response）。
 * 而这里要拿这些文本**算二元组重合度**，而分组阈值 0.08 是在**全文**语料上标定的
 * （`research/intent-grouping.py`，`SAMPLE = 400`）。
 *
 * **实测的后果**（`session-abcd1235`，379 回合）：
 *
 * | 文本量 | 话题组 | 转向 |
 * |---|---|---|
 * | 全文（Python 参考） | **35** | 0 |
 * | 截断 50/120 | **28** | 4 |
 *
 * 所以说"照抄上限"是错的：**阈值不能跨文本量继承**。
 * 取与标定语料同量级的上限，让两侧算的是同一个东西。
 */
const PROMPT_LIMIT = 400
const RESPONSE_LIMIT = 400

/**
 * 空间的折叠与截断。与官方 `preview()` 同口径（空白折叠 + 超出加省略号）。
 *
 * **导出是为了研究探针**：`tools/probes/structure-via-host.mjs` 要复刻"浏览器
 * 到底把什么材料送给了结构流水线"，而它只能在会话日志上重放这一步。
 * 让探针 import 这一份，好过在探针里再抄一遍规则——抄的那份会漂。
 */
export function preview(text: string, limit = PROMPT_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit - 1 ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}


/**
 * 从消息内容块里取**思考**文本。
 *
 * 与 `textOf` 分开：思考块（`type: 'reasoning'`）与正文块在同一个 `content`
 * 数组里（实测一条消息的块类型是 `reasoning,text,tool-call,tool-call`），
 * 而 `textOf` 刻意只认正文——那个口径是给 prompt/response 用的。
 */
function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type !== 'reasoning' || typeof item.text !== 'string') continue
    out += out === '' ? item.text : ` ${item.text}`
    // 目标句只可能在**最前面**（`research/reasoning-phases.md`：只有靠前的思考
    // 在谈目标），所以够抽一句就停，不把整段思考拼出来。
    if (out.length >= STATEMENT_LIMIT * 2) break
  }
  return out
}

/** 从消息内容块里取纯文本。只认 `text` 块——与官方实现一致。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type !== 'text' || typeof item.text !== 'string') continue
    // 单块的界：折叠在每条消息事件上跑，一个几兆的块不该被整段拼接。
    const chunk = item.text.length > RESPONSE_LIMIT * 2
      ? item.text.slice(0, RESPONSE_LIMIT * 2)
      : item.text
    out += out === '' ? chunk : ` ${chunk}`
    if (item.text.length > RESPONSE_LIMIT * 2) break
  }
  return out
}

/**
 * 纯折叠：前一状态 + 一个已提交事件 → 下一状态。
 *
 * **不关心的事件必须返回同一引用**——契约原文："an unchanged reference
 * (`Object.is`) produces zero downstream work"。返回新对象会让每个事件都触发一次
 * 下游发布，长会话里那是纯粹的浪费。
 *
 * 锚点用 `turn/start` 而不是 `user/message`：与官方一致，因为它的 seq 是
 * 跳转的加载目标，而且它是回合的**唯一边界**。
 */
export function applyIntent(state: IntentState, event: SessionEvent): IntentState {
  const type = event.type as string

  if (type === 'goal/change') {
    const data = event.data as
      | { operation?: unknown; goal?: { revision?: unknown } | null }
      | undefined
    const operation = String(data?.operation ?? '')
    if (operation === '') return state
    const revision = Number((data?.goal as { revision?: unknown } | null)?.revision)
    const entry = {
      // **回合号从折叠状态里取**，不从 `roundsStarted` 取——
      // 后者是"目标寿命内的计数"，把它当回合号用会错得离谱
      // （实测某会话错 89 个回合）。真正的回合号在这里是直接可得的。
      turn: state.turns.length,
      operation,
      revision: Number.isFinite(revision) ? revision : null,
    }
    // 同一回合内可能连发多条（create→pause），所以用数组而非单值。
    return { ...state, goalTimeline: [...state.goalTimeline, entry] }
  }

  if (type === 'compaction/start') {
    const data = event.data as { turn?: unknown } | undefined
    const turn = Number(data?.turn)
    if (!Number.isInteger(turn) || turn < 1) return state
    if (state.compactionTurns.includes(turn)) return state
    // 保持升序：界面按序渲染，而且**下游按它查找"最近的压缩点"**。
    // 转向检测那个消费者已随组口径删除（提交 ④），于是这条排序成了**约定**：
    // 投影发出去的东西不该依赖"客户端自己会排"。
    return { ...state, compactionTurns: [...state.compactionTurns, turn].sort((a, b) => a - b) }
  }

  if (type === 'turn/start') {
    const turns = [
      ...state.turns,
      {
        turn: state.turns.length + 1,
        seq: SessionSeq(Number(event.seq)),
        prompt: '',
        response: '',
        statement: '',
      },
    ]
    return { ...state, turns }
  }

  if (type === 'user/message') {
    const last = state.turns[state.turns.length - 1]
    if (last === undefined || last.prompt !== '') return state
    const data = event.data as { content?: unknown; source?: { kind?: unknown } } | undefined
    // **必须过滤注入消息。** 实测一个 133 回合的会话里 `user/message` 有 151 条，
    // 而其中只有 132 条是真人输入——其余 19 条的 `source.kind` 是
    // `plugin` / `agent-instructions` / `goal` / `at-file-mention` /
    // `subagent-report` / `subagent-settled`。
    //
    // 不过滤的后果实测过：prompt 位置会抓到
    // "Current runtime context. This snapshot supersedes…" 这类系统文本，
    // 而它对读者毫无意义——而这一段文字会成为话题组的标题（组目标取自最中心的回合）。
    if ((data?.source?.kind ?? 'user') !== 'user') return state
    const text = textOf(data?.content)
    if (text === '') return state
    const turns = [...state.turns]
    const prompt = preview(text, PROMPT_LIMIT)
    turns[turns.length - 1] = { ...last, prompt }
    return { ...state, turns }
  }

  if (type === 'assistant/message') {
    const last = state.turns[state.turns.length - 1]
    if (last === undefined) return state
    const data = event.data as { message?: { content?: unknown } } | undefined
    /**
     * **每一回合都抽**"agent 把任务理解成了什么"（使用者 2026-10-10 裁定之后）。
     *
     * 原先只在**简报回合**（prompt 短于 `BRIEF_PROMPT`）抽，理由是"其余回合 prompt
     * 自己就说了，再显示一遍是冗余"。那句话对**显示**成立，但对**判据**不成立：
     * 「工作偏离」判的是"agent 行为是否符合用户交办的任务"，参照物是用户指令、
     * 被判的是 agent 的理解——**新任务出现的回合（节点起点）与压缩之后的回合恰恰
     * 多半是实质回合**，只抽简报回合等于把最该判的那些跳过了。
     *
     * 抽取本身不花钱（纯函数，思考文本已经在手上）；代价只在投影载荷——
     * 实测 377 回合那场能多抽 134 条、约 20 KB。
     */
    let statement = last.statement ?? ''
    if (statement === '') {
      statement = goalStatement(reasoningOf(data?.message?.content))
    }
    const text = textOf(data?.message?.content)
    if (text === '') {
      // 正文为空但抽到了目标句：状态仍要更新（思考可以早于正文出现）
      if (statement === last.statement) return state
      const turns = [...state.turns]
      turns[turns.length - 1] = { ...last, statement }
      return { ...state, turns }
    }
    // **每次都覆盖**：官方 `turnOutline` 在 `turn/end` 时提交**最新**一条带文本的
    // assistant 消息。取第一条会让响应文本与官方不一致——而两处不一致正是
    // 本项目吃过一次的亏（调用方拿到的回合文本和它以为的不是同一句）。
    const turns = [...state.turns]
    const response = preview(text, RESPONSE_LIMIT)
    turns[turns.length - 1] = { ...last, response, statement }
    return { ...state, turns }
  }

  return state
}

/** 客户端载荷的校验。契约要求 wire 载荷在离开宿主前被校验。 */
const intentViewSchema = z.object({
  turnCount: z.number().int().nonnegative(),
  firstSeq: z.number().int(),
  lastSeq: z.number().int(),
  turns: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      statement: z.string().max(STATEMENT_LIMIT).optional(),
      // 用户原文（截断）。wire 形状在 v8 加的这个键；旧载荷没有 ⇒ optional。
      prompt: z.string().max(PROMPT_LIMIT).optional(),
    }),
  ),
  compactionTurns: z.array(z.number().int().nonnegative()),
  goalTimeline: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      operation: z.string(),
      revision: z.number().int().nullable(),
    }),
  ),
  goalOnset: z.number().int().nonnegative(),
  contentHash: z.string(),
})

/** 宿主状态的校验。契约要求持久化状态在被信任前被校验。 */
const intentStateSchema = z.object({
  turns: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      seq: z.number().int().nonnegative().transform(SessionSeq),
      prompt: z.string().max(PROMPT_LIMIT),
      response: z.string().max(RESPONSE_LIMIT),
      // **`.default('')` 不是装饰**：旧缓存行没有这个字段，写成必填会让
      // restore 校验失败——那时整条投影会安静地不出值（本项目为此栽过一次，
      // 症状是"所有会话都没有 intent"，而我一开始误判成"冷重折慢"）。
      statement: z.string().max(STATEMENT_LIMIT).default(''),
    }),
  ),
  compactionTurns: z.array(z.number().int().nonnegative()),
  goalTimeline: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      operation: z.string(),
      revision: z.number().int().nullable(),
    }),
  ),
})

/**
 * 投影单元。
 *
 * 与 `dsh-goal` 的 `goalProjectionDefinition` 同形——那是本文件的模板。
 */
export const intentProjectionDefinition = {
    key: 'intent' as const,
  stateSchema: intentStateSchema,
  init: (): IntentState => ({ turns: [], compactionTurns: [], goalTimeline: [] }),
  apply: applyIntent,
  wire: {
    viewSchema: intentViewSchema,
    /**
     * 状态 → 客户端载荷。**快照被读时才调用**，
     * 所以全局批处理（分组、转向）将来放在这里，而不是 `apply` 里。
     */
    view: (state: IntentState): IntentView => {
      /**
       * **载荷里只剩回合本身**（使用者裁定弃组、只保留 DAG）。
       *
       * 这里原本还算四样东西：话题分组（`groupTurns` + 组目标 + 组内贴合度）、
       * 话题转向（`findTopicShifts`）、低贴合计数、以及给每回合算的 `reach`。
       * 它们全部围着"划分"这个形状转，而 DAG 是重叠归属——划分表达不了它。
       * 组与转向的显示也已从面板撤掉（②），所以计算一并下线。
       *
       * 现在每回合只带：回合号、用户原文（结构流水线与回退列表都要它）、
       * 以及简报回合的 `statement`（agent 当时的理解，语义核查的材料之一）。
       */
      const turns = state.turns.map((item) => ({
        turn: item.turn,
        prompt: item.prompt,
        // **只在有值时才带这个键**：抽不到就没有（`goalStatement` 宁缺勿滥）。
        ...(item.statement ? { statement: item.statement } : {}),
      }))

      /**
       * **内容指纹**：决定"要不要重算结构"。
       *
       * 口径：只含**会话内容**（逐回合原文 + agent 的理解）。语义核查的键
       * **不是这个**——那一侧的输入是**节点**（结构），所以要按材料另算，
       * 见 `client/IntentTab.ts` 的 `semanticKey`。两个键各管一条路的缓存，
       * 混用就会"结构变了而键没变、旧结论贴到新结构上"。
       */
      const contentHash = semanticFingerprint(
        state.turns.map((item) => `${item.turn}:${item.prompt}`),
        state.turns.filter((item) => item.statement !== '').map((item) => item.statement),
      )

      return {
        turnCount: state.turns.length,
        firstSeq: state.turns[0]?.seq ?? -1,
        lastSeq: state.turns[state.turns.length - 1]?.seq ?? -1,
        turns,
        compactionTurns: state.compactionTurns,
        goalTimeline: state.goalTimeline,
        // 最后一次 `create` 的回合号。之后的 edit/pause/resume 不改变"建立于第几轮"。
        goalOnset: (() => {
          for (let i = state.goalTimeline.length - 1; i >= 0; i -= 1) {
            if (state.goalTimeline[i].operation === 'create') return state.goalTimeline[i].turn
          }
          return 0
        })(),
        contentHash,
      }
    },
  },
  //: 折叠语义或状态字段一变就要加。让旧缓存行被丢弃而不是被前向套用成垃圾。
  //:
  //: **实测教训（两次）**：
  //:
  //: 1. `stateVersion` 只挡住"声明的版本"不符，挡不住"同一版本号下语义改过"。
  //:    投影缓存里混过不同构建写下的 `intent` 行（同一会话的 `terms` 数出现
  //:    253 / 102 / 0 三种），症状是分组数从 56 变成 28。
  //: 2. **给 wire 加字段也算变**。加 `compactionTurns` 时漏加这个数，于是
  //:    浏览器读到的是**旧缓存行**——字段为 `undefined`，而没有任何报错。
  //:    症状是"代码对了但值不在"，比报错难查。
  //:
  //: 所以：**改折叠语义、改 wire 载荷形状、加字段，都要加这个数。**
  //: 3 —— 加 compactionTurns（忘了加，于是读到旧缓存行、字段 undefined 而无报错）
  //: 4 —— 加 goalTimeline（改 wire 载荷形状）
  //: 5 —— 已使用，但当时**没在这份日志里登记**（本次如实补记，不追认细节）
  //: 7 —— 组的 wire 载荷加 `samples`（整组语料，供语义判定当"这一组在做什么"）
  //: 6 —— 加 `statement`（简报回合的"agent 理解"，只为显示）。**并且把
  //:    stateSchema 里这个字段写成 `.default('')`**：旧缓存行没有它，
  //:    写成必填会让 restore 校验失败——那时整条投影会安静地不出值。
  //: 8 —— 回合行加 `prompt`（原文，供**任务结构**那条路判归属与渲染树）。
  //:    此前 wire 只有 `statement`（少数简报回合才有），结构流水线拿不到逐回合原文。
  //:    ⚠️ 旧载荷没有这个键 ⇒ 客户端要按"可能缺失"处理（wire 不是持久化状态，
  //:    所以这里不需要 `.default()`；需要它的是 `stateSchema` 那边）。
  //: 10 —— **折叠语义**变：`statement`（agent 当时的理解）从"只有简报回合"改成
  //:    **每一回合都抽**。形状没变（还是可选字段），所以这一条不是给 schema 看的，
  //:    是给"同一版本号下语义改过"那个坑看的：旧缓存行里实质回合的 `statement`
  //:    都是空的，浏览器会以为"这些回合没有理解可判"。
  //: 9 —— **删**字段：`groups` / `localFit` / `promptSize` / `brief` / `lowFitCount`
  //:    / `shifts`（话题组口径整块下线）。删也要加这个数：旧缓存行仍然带着那
  //:    六个键，浏览器若还按老形状读，读到的是一份**没人再维护**的视图；
  //:    而 `IntentView` 已经把它们删了，读到就是在读 `undefined`。
  stateVersion: 10,
}

/**
 * 注册意图投影。
 *
 * 在宿主 `apply` 里调用——这正是宿主半边存在的理由。
 *
 * @param ctx - loader 给的宿主上下文。
 */
export function registerIntentProjection(ctx: Context): void {
  ctx.sessionProjections.register(intentProjectionDefinition)
}
