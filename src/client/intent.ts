/**
 * 意图面板的**类型、常量与会话选择**。
 *
 * ## 这个文件里没有语义
 *
 * 分组、话题转向、组内贴合度**都不在这里**——它们已经搬到宿主投影
 * （`src/host/intentProjection.ts` 的 `wire.view`），浏览器只渲染。
 * 依据是 DSH 官方的 **capability-seam three-way split**：
 *
 * > 框架拥有订阅、watermark 缓存、变更通知；**领域宿主插件贡献纯折叠（pure fold）
 * > + 可选的客户端视图**；载体消费快照与变更流；两侧互不知道对方。
 * >
 * > *"How a value is rendered is the slot system's business, never this layer's."*
 *
 * 所以这里的职责只有两件：**定义渲染要的形状**，和**挑一个有数据的会话**。
 *
 * ## 曾经的语义住在哪里（留档，避免有人再搬回来）
 *
 * 本文件原先有 `buildIntentModel`，其中包含分组、转向检测与贴合度计算（约 740 行
 * 连同 `grouping.ts` / `shifts.ts`）。那套实现与 Python 侧的 `parse_intent.py`
 * 构成"同一语义两份实现"，靠注释维持一致，实测漂移 1–2 个话题组。
 *
 * 搬到宿主之后，语义只有一处：`src/shared/intent.ts`（纯函数，两侧共用），
 * 由宿主的 `wire.view` 调用。Python 那份降为**独立交叉校验**
 * （见 `plugin/scripts/verify-shared.cjs`，两个实现在同一语料上逐字一致）。
 */

/**
 * 一个回合在前端的形态。
 *
 * 这里曾有三个**组口径**的信号：`reach`（组内贴合度）、`brief`（承接/指令型）、
 * `promptSize`。判据的容器换成任务节点（DAG）之后，面板侧不再用它们
 * ⇒ 宿主也不再发（`stateVersion` 9）。**不在这里重算**：阈值与二元组都在
 * `shared/intent.ts`，在浏览器里再算一份就是"同一语义两处实现"。
 */
export interface IntentTurn {
  turn: number
  /**
   * 用户原文（宿主折叠时截断到 `PROMPT_LIMIT`）。
   *
   * 结构流水线的材料就是它——分批判归属时喂给模型的是"第 N 回合：<原文>"。
   * 旧载荷（`stateVersion` 8 之前）没有这个键，那时回落到官方 `turnOutline`。
   */
  prompt: string
  response: string
  /**
   * **agent 当时把任务理解成了什么**——从靠前的思考里抽出的一句话。
   *
   * **任何回合都可能抽到**（宿主对每一回合都抽，2026-10-10 起），抽不到就没有。**它不是用户说的话**：界面必须标出来
   * （见 `shared/intent.ts` 的 `goalStatement`）。思考多为英文，所以这一句
   * 常常是英文原文——**不翻译**，翻译是额外一层失真。
   */
  statement?: string
}

export interface IntentModel {
  rootLabel: string
  rootDetail: string
  /** 根节点文字的来源。标题不是作者写的目标，必须区分。 */
  rootProvenance: 'derived' | 'inferred'
  /**
   * 逐回合材料：回合号、用户原文、以及那句 agent 理解（有就带）。
   *
   * **文本取宿主投影里的那份**（`intent.turns[].prompt`，截断到 400），
   * 官方 `turnOutline` 只作回落——两份都从同一个 `turn/end` 事件来，
   * 但流水线要的是宿主折叠时用的那份口径。
   */
  turns: IntentTurn[]
  /**
   * 当前内容的指纹（宿主投影给出）。
   *
   * 面板拿它跟"上一次任务结构的指纹"比：不一致就去请求一次结构。
   */
  contentHash: string
  turnCount: number
  /**
   * 目标时间线：每次 `goal/change` 一条。
   *
   * **官方 `goal` 投影只有当前值，没有历史**——"目标何时改过、改了几次"
   * 是这份时间线独有的信息。
   */
  goalTimeline: { turn: number; operation: string; revision: number | null }[]
  notes: string[]
}

/** `pickSession` 看的投影子集。 */
interface SessionProjectionLike {
  intent?: { turnCount?: number } | null
  goal?: { goal?: { objective?: string } } | null
  turnOutline?: unknown[] | null
}

/** `pickSession` 的结果。 */
export interface PickedSession {
  id: string | undefined
  /** 这个会话**不是**当前作用域里的那个，是借来的。界面必须说出来。 */
  borrowed: boolean
}

/**
 * 挑一个会话给面板显示。
 *
 * ## 现在的规矩：**就显示你正在看的那个**
 *
 * 第一位是 `preferred`（tab 作用域里的会话），**它有没有数据都选它**。
 * 「这一段在做什么」这个问题只对**你正在看的会话**成立；
 * 拿另一个会话的意图来回答，是个**看起来像答案的错答案**。
 *
 * ## 这条规矩是反过来的（原来优先挑"有值的"）
 *
 * 原来排序是「有值 > 有 goal > 回合多」，理由是"新会话还没投影值，
 * 挑一个有的，用户一打开就能看到东西，而不是先看到一片空白"。
 *
 * **那个交换是亏的**，两处：
 *
 *   1. **会静默跳到别的会话**。你在一个新会话里打开面板，看到的是**别人的**
 *      133 回合、别人的话题组，而界面上没有任何一处说这不是本会话。
 *      空白至少诚实，错答案不诚实。
 *   2. **基线和显示的会话会对不上**。自定义基线按会话 id 存
 *      （`intent-view:intent-baseline:<id>`），而调用方原来拿的是**作用域**的
 *      id，不是这里挑出来的 id。跳走之后，你在这个会话里编辑的基线
 *      会写到另一个会话的键上。
 *
 * 实测：上一版在 3098 上验过——面板顶部写「目标 · 第 2 版 | 133 回合」，
 * 而侧栏当前会话是另一个 7 回合的新会话。
 *
 * ## 什么时候才借
 *
 * 只在**作用域里压根没有会话**时（tab 开在应用层、没选中任何会话）。
 * 那时借一个内容最丰富的，并置 `borrowed: true`，界面据此显式标注。
 *
 * @param snapshot - `sessions.list` 的快照。
 * @param preferred - 当前作用域的会话。
 */
export function pickSession(
  snapshot:
    | { ids?: string[]; byId?: Record<string, unknown>; current?: string | null }
    | undefined,
  preferred?: string,
): PickedSession {
  // 作用域里有会话就用它。**不看它有没有数据。**
  if (preferred !== undefined && preferred !== '') return { id: preferred, borrowed: false }

  const byId = (snapshot?.byId ?? {}) as Record<
    string,
    { projectionValues?: SessionProjectionLike } | undefined
  >
  const score = (id: string): number => {
    const pv = byId[id]?.projectionValues
    if (pv === undefined) return -1
    const hasIntent = (pv.intent?.turnCount ?? 0) > 0 ? 1000000 : 0
    const hasGoal = pv.goal?.goal?.objective ? 100000 : 0
    return hasIntent + hasGoal + (pv.turnOutline?.length ?? 0)
  }
  let best: string | undefined
  let bestScore = -1
  for (const id of snapshot?.ids ?? []) {
    const value = score(id)
    if (value > bestScore) {
      bestScore = value
      best = id
    }
  }
  const id = best ?? snapshot?.current ?? undefined
  return { id, borrowed: id !== undefined }
}
