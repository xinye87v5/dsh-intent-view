/**
 * 任务结构流水线的**纯逻辑**：四段提示词 + 状态操作 + 归一化收尾。
 *
 * 面板要显示结构、还要让人**手动改落点**（B4）。这要求宿主侧能跑这条流水线，
 * 而它此前只活在研究工具 `tools/probes/pipeline.mjs` 里。搬过来的原则是
 * **一份实现**：本文件是从那份**按行号区间取**出来的（不是重写），
 * `scripts/verify-task-pipeline-port.cjs` 会拿同一批输入对两边做**逐字交叉校验**，
 * 防止将来漂移（本项目在 `splitlines` vs `split('\n')` 上吃过一次亏）。
 *
 * 与 `taskGraph.ts` 的分工：那边是**图本身**（祖先、最具体落点、人工调整），
 * 这边是**流水线**（提示词、把模型回复应用成状态、根裁定、承接、收尾）。
 */
import { ancestorsOf, mostSpecific, type TaskGraph, type TaskNode } from './taskGraph.js'

/** `taskGraph.ancestorsOf` 收的是整张图；本文件内部多处只手里有 nodes，包一层免得改十几处调用。 */
const ancestorsIn = (nodes: Record<string, TaskNode>, id: string): Set<string> =>
  ancestorsOf({ nodes, membership: {} }, id)

/** 一个回合（只需要回合号与正文）。 */
export interface Turn { turn: number; prompt: string }

/** 流水线用的状态就是 `TaskGraph`（别名一下，读起来顺）。 */
export type PipelineState = TaskGraph

export const PLACEHOLDERS: Record<string, string> = { nodes: '$NODES', turns: '$TURNS', roots: '$ROOTS' }

/** 第一段：建基础结构。 */
export const BUILD_PROMPT = [
  '把一段人与 AI 的会话整理成**任务结构**（允许重叠的图，不是划分，也不是严格的树）。',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务）：',
  '- 换了对象/子任务 → 新节点；同一个东西换侧面/换动作 → 同一个节点；',
  '- 单纯的评价/确认/承接（"跑通了就好"）→ 既不是节点，也不该有归属；',
  '- 与任务无关的插话 → 新建 kind="aside" 的小节点；',
  '- 父节点是**纯容器**：父不直接拥有散落回合，那些回合各自成子节点。',
  '',
  '**只回一个 JSON 对象**：',
  '{"nodes":{"n1":{"parents":["root"],"title":"12 字内","kind":"task"}},' +
    ' "membership":{"1":["n1"],"2":["n1","n2"]}}',
  'id 用字符串；根的 parents 写 ["root"]；membership 的键是回合号，值是节点 id 的**列表**；',
  'membership 必须覆盖每一个回合。',
  '',
  PLACEHOLDERS.turns,
].join('\n')

/**
 * 第二段：只判归属。**刻意不提供 `assign` 这类 ops**——
 * 给了就会退化成"一个回合一个落点"。见本文件头部第 1 条。
 */
export const ASSIGN_PROMPT = [
  '已有节点清单：',
  PLACEHOLDERS.nodes,
  '',
  '下面是**新增的回合**。逐个回答：这个回合**在推进哪几件事**？',
  '- 每件事给一个落点：已有节点的 id，或在 newNode 里建一个新节点（id 用 "t<回合号>"）；',
  '- **一个回合推进两件事就给两个落点，三件就给三个**；只推进一件就给一个；',
  '- 单纯的评价/确认/承接、"好的/收到"**不算推进**；闲聊若有自己的节点也算一个落点；',
  '- 不要输出区间，不要解释。',
  '',
  PLACEHOLDERS.turns,
  '',
  '只回 JSON，形状：{"placements":{"21":["n5","n9"],"22":["n3"]},' +
    ' "newNodes":{"t22":{"parents":["n3"],"title":"12 字内"}}}',
  '（某回合没有落点就给空数组；newNodes 里声明的 id 才算存在）',
].join('\n')

/** 第三段：只判**节点**层面的整理。合并只能在这里发生。 */
export const CONSOLIDATE_PROMPT = [
  '下面是任务结构的**节点清单**（只列节点，不含回合归属）：',
  PLACEHOLDERS.nodes,
  '',
  '只做**节点层面的整理**，输出 ops 数组：',
  '- 若两个（或更多）节点其实是**同一步工作的前后半段**、或同一件事的两种说法，',
  '  用 {"op":"merge","from":["n7","n9"],"into":"n7","title":"合并后的名字"} 合掉；',
  '- 若某个节点的名字只是**临时描述**、不代表正在弄的东西，用',
  '  {"op":"retitle","id":"n7","title":"..."} 改成对象的说法；',
  '- 只改必要的，**不要为了少而合并**；同一件事的上下级**不要**合并（父是容器）。',
  '',
  '只回 JSON：{"ops":[...]}（没有要改的就回 {"ops":[]}）',
].join('\n')

/** 拼装用：把占位符换掉，并**断言每个占位符都被替换过**（缺了就是拼装 bug）。 */
export function fillPrompt(prompt: string, { nodes, turns, roots }: { nodes?: string; turns?: string; roots?: string }): string {
  let out = prompt
  for (const [key, value] of Object.entries({ nodes, turns, roots })) {
    if (value === undefined) continue
    const token = PLACEHOLDERS[key]
    if (token === undefined) throw new Error(`PLACEHOLDERS 里没有 ${key}`)
    if (!prompt.includes(token)) throw new Error(`这段提示词没有 ${token} 占位符`)
    out = out.split(token).join(value)
  }
  const left = Object.values(PLACEHOLDERS).filter((t) => out.includes(t))
  if (left.length > 0) throw new Error(`还有没替换掉的占位符：${left.join('、')}`)
  /**
   * ⚠️ 这条是**用血换来的**：`ADJUDICATE_PROMPT` 里我写过 `PLACEHOLDERS.roots`，
   * 而 `PLACEHOLDERS` 当初根本没有 `roots` 键 —— 提示词里就留下一个字面量
   * `undefined`，**根清单从未注入**，模型在看不见任何根的情况下瞎编分组
   * （症状是项目名叫 `会话节点分组`、且只并了 10 个根）。
   * 所以：拼好的提示词里绝不允许出现 `undefined`。
   */
  if (out.includes('undefined')) throw new Error('拼好的提示词里出现了 undefined——多半是某个占位符常量不存在')
  return out
}

export const SYS = '你是任务结构标注器。只回 JSON，不要解释。'

/** 回合列表 → 提示词里的正文（截断到 90 字，避免长会话把提示词撑爆）。 */
export function renderTurns(turns: Turn[]): string {
  return turns.map((t) => `#${t.turn} ${String(t.prompt).replace(/\s+/g, ' ').slice(0, 90)}`).join('\n')
}

/** 节点字典 → 提示词里的清单（父在前，便于模型判断层级）。 */
export function nodeList(nodes: Record<string, TaskNode>): string {
  return Object.entries(nodes).map(([id, n]) => `${id} [父 ${n.parents.join('/')}] ${n.title}`).join('\n')
}

/** 空状态。 */
export function emptyState(): TaskGraph {
  return { nodes: {}, membership: {} }
}

/**
 * 应用第二段的回复。
 *
 * - `newNodes` 里声明的 id 才算存在（**不接受** placements 里凭空出现的 id）；
 * - 一个回合给多个落点 = 多归属，保留顺序、去重。
 */
export function applyAssign(state: TaskGraph, reply: { newNodes?: Record<string, { parents?: unknown[]; title?: unknown; kind?: unknown }>; placements?: Record<string, unknown[]> } | null | undefined) {
  const nodes = { ...state.nodes }
  const membership = { ...state.membership }
  for (const [id, n] of Object.entries(reply?.newNodes ?? {})) {
    nodes[String(id)] = {
      parents: (n.parents ?? ['root']).map(String),
      title: String(n.title ?? ''),
      kind: String(n.kind ?? 'task'),
    }
  }
  const dropped = []
  for (const [turn, list] of Object.entries((reply?.placements ?? {}) as Record<string, unknown[]>)) {
    const keep = [...new Set((list ?? []).map(String).filter((id) => nodes[id] !== undefined))]
    for (const id of (list ?? []).map(String)) if (nodes[id] === undefined) dropped.push(`${turn}:${id}`)
    if (keep.length > 0) membership[String(turn)] = keep
  }
  return { nodes, membership, dropped }
}

/**
 * `newTurns` 是不是 `oldTurns` 的**前缀延长**（同一批回合、后面多了几个）。
 *
 * 这是增量归属的**唯一入口判据**：只有"前面逐字没变、后面多了"才能把新回合接到
 * 已有结构上。任何一处早期回合变了（压缩把早期 prompt 改写、或换了会话）都必须
 * 回退到全量——否则会在结构上叠出一棵与当前内容不符的树，而那种错**不会报错**。
 *
 * 逐字比较 prompt 是有意的：那一列正是折叠时写下的原文，变了就说明这段历史动过。
 */
export function isPrefixExtension(oldTurns: Turn[], newTurns: Turn[]): boolean {
  if (newTurns.length <= oldTurns.length) return false
  for (let i = 0; i < oldTurns.length; i += 1) {
    if (oldTurns[i].turn !== newTurns[i].turn) return false
    if (oldTurns[i].prompt !== newTurns[i].prompt) return false
  }
  return true
}

/**
 * 应用**增量**归属那一段的回复。
 *
 * 与 `applyAssign` 的差别只有两条**保护**，都是"已有结构不许重排"这条标准的落地：
 *
 * 1. `placements` 只认 `allowedTurns` 里的回合——模型若顺手把老回合也写了一遍，
 *    那些条目**丢掉**（否则一次增量会悄悄改写历史归属）；
 * 2. `newNodes` 里与已有 id 撞名的**丢掉**——`applyAssign` 对新 id 是直接
 *    `nodes[id] = ...`，撞名会覆盖掉已有节点（标题、父子关系全没了）。
 *
 * 返回被丢掉/撞名的条数，供调用方记账（**不要静默**：这两个数一旦长期不为 0，
 * 说明提示词里的约束没被遵守，该去看模型回了什么）。
 */
export function applyIncrement(
  state: TaskGraph,
  reply: { newNodes?: Record<string, { parents?: unknown[]; title?: unknown; kind?: unknown }>; placements?: Record<string, unknown[]> } | null | undefined,
  allowedTurns: readonly number[],
) {
  const allowed = new Set(allowedTurns.map(Number))
  const placements: Record<string, unknown[]> = {}
  let ignored = 0
  for (const [turn, list] of Object.entries(reply?.placements ?? {})) {
    if (!allowed.has(Number(turn))) {
      ignored += 1
      continue
    }
    placements[turn] = list ?? []
  }
  const newNodes: Record<string, { parents?: unknown[]; title?: unknown; kind?: unknown }> = {}
  let collisions = 0
  for (const [id, node] of Object.entries(reply?.newNodes ?? {})) {
    if (state.nodes[String(id)] !== undefined) {
      collisions += 1
      continue
    }
    newNodes[id] = node
  }
  // 已有节点的 title / parents **一个都不碰**（`applyAssign` 只写 newNodes 与 membership）。
  const applied = applyAssign(state, { newNodes, placements })
  return { ...applied, ignored, collisions }
}

/**
 * 应用第三段的回复。`merge` 会真的把 `from` 的归属并进 `into`——
 * 这是"两个兄弟合成一个"在数据上的唯一实现方式。
 */
export function applyConsolidate(state: TaskGraph, ops: Array<Record<string, unknown>> | null | undefined) {
  const nodes = structuredClone(state.nodes)
  const membership = structuredClone(state.membership)
  const unknown = []
  for (const op of ops ?? []) {
    const kind = String(op?.op ?? '')
    if (kind === 'merge') {
      const into = String(op.into)
      const from = ((op.from ?? []) as unknown[]).map(String).filter((id) => id !== into)
      if (nodes[into] === undefined) continue
      for (const id of from) delete nodes[id]
      const moved = new Set([into, ...from])
      for (const [turn, ids] of Object.entries(membership)) {
        if (!ids.some((id) => moved.has(id))) continue
        membership[turn] = [...new Set([...ids.filter((id) => !moved.has(id)), into])]
      }
      if (op.title !== undefined) nodes[into].title = String(op.title)
      if (Array.isArray(op.parents)) nodes[into].parents = op.parents.map(String)
    } else if (kind === 'retitle') {
      const n = nodes[String(op.id)]
      if (n !== undefined && op.title !== undefined) n.title = String(op.title)
    } else if (kind === 'reparent') {
      const n = nodes[String(op.id)]
      if (n !== undefined && Array.isArray(op.parents)) n.parents = op.parents.map(String)
    } else {
      unknown.push(kind)
    }
  }
  return { nodes, membership, unknown }
}

export const ADJUDICATE_PROMPT = [
  '这是一场会话被划分出的几个**顶层**节点（每个后面是它覆盖的回合数与代表回合）：',
  PLACEHOLDERS.roots,
  '',
  '问：请把它们**分组**，使得**每一组都能用一句话概括**（那句话就是这一组的项目名）。',
  '- 全都属于同一件事 → 只给一组；',
  '- 只有一部分属于同一件事 → 该组一组，其余各自成组；',
  '- 彼此都不同 → 每个各成一组。',
  '',
  '只回 JSON：{"groups":[{"name":"这一组的一句话名字（12 字内）","roots":[1,3,5]}]}',
  '（roots 写上面的**序号**，不要抄标题；每个序号只能出现在一组里）',
  '',
  '**名字要说明这件事"是什么"**（例如"个人资料制作""京都行程规划"），',
  '不要描述"分组"这个动作——不要出现"分组""归类""节点""会话"这些词。',
].join('\n')

/**
 * **动作名**：描述"我在做分组"而不是"这件事是什么"的名字。
 *
 * 真实会话里出现过 `会话节点分组` 这种项目名（`research/root-adjudication-ab.md`），
 * 对使用者没有信息量。提示词里已经要求它别这么起，这里再兜一道底：
 * 命中就用**该组第一个根的标题**当项目名（确定性、且一定说明事情本身）。
 */
export const META_NAME_RE = /分组|归类|节点|会话/

export const isMetaName = (name: string): boolean => META_NAME_RE.test(String(name))

/** 把顶层节点渲染成**带序号**的清单——让模型回序号，别抄标题（抄会把注记一起抄回来）。 */
export function renderRoots(state: TaskGraph, turns: Turn[]): string {
  const ids = Object.keys(state.nodes)
  const roots = mostSpecific(state) === state
    ? ids.filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
    : ids.filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
  return roots.map((id, k) => {
    const subtree = new Set([id, ...ids.filter((x) => ancestorsIn(state.nodes, x).has(id))])
    const mine = turns.filter((t) => (state.membership[String(t.turn)] ?? []).some((x) => subtree.has(x)))
    const samples = mine.slice(0, 3).map((t) => `#${t.turn} ${String(t.prompt).slice(0, 46)}`).join('　')
    return `${k + 1}) ${state.nodes[id].title}（${mine.length} 个回合）${samples === '' ? '' : `\n    ${samples}`}`
  }).join('\n')
}

/**
 * 裁定结果 → 新状态。**分组**形状：每组若含 ≥2 个顶层，就建一个项目节点把它们挂进去；
 * 单元素组原样留下（那就是"任务演化分叉出来的独立线"）。插话不动。
 *
 * 为什么用分组而不是"是不是一件事"的二选一：真实会话（个人资料，28 个平铺根）
 * 上分组给出 5 组、三次完全一致，且与使用者自己的三条线（个人资料／AI经纪人网页／岗位调研）对得上；
 * 而二选一问法只能说"几件事"，28 个根原样留着（`research/root-adjudication-ab.md`）。
 *
 * `rootIds` 是提示词里那份编号清单的顺序（序号 → 节点 id）。
 */
export interface AdjudicationMerged { id: string; title: string; count: number; asked: string; renamed: boolean }

export function applyAdjudication(
  state: TaskGraph,
  verdict: { groups?: Array<{ name?: unknown; roots?: unknown[] }> } | null | undefined,
  rootIds: string[] = [],
): { state: TaskGraph; applied: boolean; merged: AdjudicationMerged[] } {
  const groups = Array.isArray(verdict?.groups) ? verdict.groups : []
  const nodes: Record<string, TaskNode> = { ...state.nodes }
  const merged: AdjudicationMerged[] = []
  const taken = new Set<string>()
  groups.forEach((g, k) => {
    const ids = (g.roots ?? [])
      .map((x) => (typeof x === 'number' ? rootIds[x - 1] : rootIds.find((id) => state.nodes[id]?.title === String(x)) ?? x))
      .filter((id): id is string => typeof id === 'string' && state.nodes[id] !== undefined && !taken.has(id))
    if (ids.length < 2) return
    for (const id of ids) taken.add(id)
    const id = k === 0 ? 'project' : `project${k + 1}`
    const raw = String(g.name ?? '').trim()
    // 兜底：动作名（"会话节点分组"）→ 用该组第一个根的标题，那一定说明事情本身
    const renamed = raw === '' || isMetaName(raw)
    const name = renamed ? String(state.nodes[ids[0]]?.title ?? '本场会话的项目') : raw
    nodes[id] = { parents: ['root'], title: name, kind: 'task' }
    for (const r of ids) nodes[r] = { ...nodes[r], parents: [id] }
    merged.push({ id, title: name, count: ids.length, asked: raw, renamed })
  })
  return { state: { nodes, membership: state.membership }, applied: merged.length > 0, merged }
}

/**
 * **承接语**：这些回合自己不带新内容，语义是"接着刚才那件事做"。
 *
 * 实测五场真实会话里"没有归属"的回合大多属于这一类（`同意`/`好的`/`继续优化`/`重试`…），
 * 另一小撮是**实质内容被漏掉**（章节讨论、片段修订）。两者要用不同的手段处理：
 * 前者继承上一回合的落点，后者补问一次。
 */
const CONTINUATION_TOKENS = '继续任务|继续优化|继续研究|继续|同意|好的|好|可以|行|嗯|收到|重试|ok|OK|按你的判断处理|按你的判断|开始处理|那就这样|就这样|可以了|辛苦'
// 允许**多个承接词连用**（"好的，继续任务"），但整句必须有长度上限——
// 否则"好的，那我们把 07 章重写一遍"这种带新内容的话会被误当承接语。
export const CONTINUATION_RE = new RegExp(`^((${CONTINUATION_TOKENS})[。.!！,，、~～\\s]*)+$`)

export const isContinuation = (prompt: string): boolean => {
  const text = String(prompt).trim()
  return text.length <= 12 && CONTINUATION_RE.test(text)
}

/**
 * **承接**：没有归属的回合，继承**上一回合**的落点（第一回合则取下一个有归属的）。
 *
 * 为什么这么修：使用者裁定"单纯正确评价可以不用挂"，但那会让面板缺行；
 * 而"继续/同意"这类话在任务结构里的含义就是"保持当前这件事"。
 * 于是覆盖变成 100%，且**继承来的落点会被单独计数**（`inherited`），可以量。
 *
 * 纯函数；不修改传入的 state。
 */
export function carryForward(state: TaskGraph, turns: Turn[]) {
  const membership = { ...state.membership }
  const ordered = [...turns].sort((a, b) => a.turn - b.turn)
  const inherited = []
  const has = (t: Turn) => (membership[String(t.turn)] ?? []).length > 0
  for (let i = 0; i < ordered.length; i += 1) {
    const t = ordered[i]
    if (has(t)) continue
    let source = null
    for (let k = i - 1; k >= 0; k -= 1) if (has(ordered[k])) { source = ordered[k]; break }
    if (source === null) for (let k = i + 1; k < ordered.length; k += 1) if (has(ordered[k])) { source = ordered[k]; break }
    if (source === null) continue
    membership[String(t.turn)] = [...membership[String(source.turn)]]
    inherited.push({ turn: t.turn, from: source.turn, continuation: isContinuation(t.prompt) })
  }
  return { state: { nodes: state.nodes, membership }, inherited }
}

/**
 * **根的报告**（不是闸门）：顶层有几个、分别是谁、每条线从第几回合开始。
 *
 * ⚠️ 使用者裁定（2026-10-09）：**根的数量不设阈值**——"应该按任务领域的语义划分，
 * 同时根的拆分也表明了会话实际的任务演化分歧了"。
 * 所以这里**只报告、不判失败**，流水线也**不再自动合并根**：
 * 多根是一条信息（这场会话的任务演化分叉成几条线），不是一个要修的错误。
 *
 * 用途：面板可以据此说"本会话的任务在第 #83、#99 回合分叉出两条线"，
 * 而不是把它们硬塞进一个项目。
 *
 * 为什么需要它：使用者认可的形状是"一个项目根 + 若干插话"（2 个顶层）。
 * 但同一份流水线在童话语料上三次里有一次给出**平铺**结构——
 * 8 个非插话顶层节点、没有项目根（`research/fairytale-stability-2026-10-09.md`）。
 * 那是**两种结构**，不是粗细差别，而 strip 规范化治不了它（路径折叠不创造根）。
 *
 * 插话（\`kind: "aside"\`）留在顶层是合法的，所以闸门**只管非插话顶层**；
 * 顶层总数另作提示（\`notes\`），不判失败——否则一堆题外话会被误判成结构崩坏。
 */
export function rootSummary(state: TaskGraph, turns: Turn[] = []) {
  const ids = Object.keys(state.nodes)
  /**
   * **顶层 = root 的孩子 ∪ 独立节点（没有父的）**。
   *
   * 使用者裁定："独立节点计数吧"。原先只数 `parents.includes('root')`，于是树顶并排着
   * 几个独立节点、状态行却写"1 条线"——那个数字与实际看到的顶层对不上。
   * 独立节点是"几件独立大事"的正当表达（`parents: []`，见 `pruneEmptyLeaves` 那几条断言），
   * 它们与项目线在这个计数里同级。
   */
  // ⚠️ 要排除 `root` 自己：它的 `parents` 也是空数组，不排除就会把自己数成一条线
  // （断言当场抓到这个：返回了 `root,项目一,独立的一件事`）
  const isTop = (id: string): boolean =>
    id !== 'root' && (state.nodes[id].parents.length === 0 || state.nodes[id].parents.includes('root'))
  const roots = ids.filter(isTop)
  const projects = roots.filter((id) => state.nodes[id].kind !== 'aside')
  const asides = roots.filter((id) => state.nodes[id].kind === 'aside')
  const turnNo = (t: Turn | number): number => (typeof t === 'number' ? t : t.turn)
  /** 每条线：收了几个回合、从第几回合开始（**分叉点**）。 */
  const lines = roots.map((id) => {
    const subtree = new Set([id, ...ids.filter((x) => ancestorsIn(state.nodes, x).has(id))])
    const mine = turns
      .filter((t) => (state.membership[String(turnNo(t))] ?? []).some((x) => subtree.has(x)))
      .map(turnNo)
    return {
      id,
      title: state.nodes[id].title,
      kind: state.nodes[id].kind ?? 'task',
      turnCount: mine.length,
      firstTurn: mine.length > 0 ? Math.min(...mine) : null,
    }
  }).sort((a, b) => (a.firstTurn ?? 1e9) - (b.firstTurn ?? 1e9) || a.id.localeCompare(b.id))
  return {
    roots,
    projects,
    asides,
    lines,
    /** 非插话的线各自从哪开始——这就是"任务演化在哪里分叉"。 */
    forks: lines.filter((l) => l.kind !== 'aside' && l.firstTurn !== null).map((l) => ({ id: l.id, title: l.title, at: l.firstTurn })),
    note: projects.length > 1 ? `任务演化分叉成 ${projects.length} 条线` : '单线',
  }
}

/**
 * 流水线的**收尾**：先过结构闸门（必要时提升项目根），再规范化成最具体落点。
 *
 * 调用点只需要这一个函数——顺序（闸门在前、strip 在后）写在这里，
 * 免得每个入口各记一遍。见本文件头部"存储形态"与 `rootGate`。
 */
export function finalize(state: TaskGraph, turns: Turn[] = []) {
  return {
    state: mostSpecific(state),
    roots: rootSummary(state, turns),
  }
}

// ---- treeRows：渲染要用的行结构（同样从 tools/probes/pipeline.mjs 抽取）----
/**
 * 把结构画成**树状缩进图**，每个节点后面跟它收的回合号。
 *
 * 为什么要画：判"该合还是该拆"时，一行行读表看不出形状；
 * 而**根节点一人收了十几行**这种问题在图上一眼就看得见。
 *
 * - 回合号压成区间（`#7–9`），一行不至于太长；
 * - 一个节点有多个父时**在每个父下都画一次**（这是 DAG，不是树），
 *   重复出现的那次标 `↩ 同 nX`；
 * - 父母不在节点表里 → 画在顶层并标 `⚠ 父节点缺失`；
 * - 有环时标 `↻ 环` 并停住（不会递归到爆栈）。
 */
/** 渲染要用的行：节点 + 深度 + 它收的回合号 + 标记。 */
export interface TreeRow {
    id: string
    depth: number
    cycle: boolean
    parentIds: string[]
    title: string
    kind: string
    turns: number[]
    notes: string[]
  }

export function treeRows(state: TaskGraph, turns: Turn[]) {
  const ids = Object.keys(state.nodes)
  const children = new Map()
  for (const id of ids) {
    for (const parent of state.nodes[id].parents) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(id)
    }
  }
  const turnsOf = (id: string): number[] =>
    turns.filter((t) => (state.membership[String(t.turn)] ?? []).includes(id)).map((t) => t.turn)
  const compress = (list: number[]): string => {
    const out = []
    let start = list[0]
    let prev = list[0]
    for (const t of list.slice(1)) {
      if (t === prev + 1) { prev = t; continue }
      out.push(start === prev ? `#${start}` : `#${start}–${prev}`)
      start = t
      prev = t
    }
    if (list.length > 0) out.push(start === prev ? `#${start}` : `#${start}–${prev}`)
    return out.join('、')
  }
  const order = (list: string[]): string[] => [...list].sort((a, b) => (turnsOf(a)[0] ?? 1e9) - (turnsOf(b)[0] ?? 1e9) || a.localeCompare(b))
  /** 一行：节点 + 缩进深度 + 它收的回合号 + 标记（插话 / ↩ 多父 / 父缺失）。 */
  const rows: TreeRow[] = []
  const printed = new Set<string>()
  const safe = (id: string): boolean => state.nodes[id] !== undefined
  const walk = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id)) {
      rows.push({ id, depth, cycle: true, parentIds: [], title: state.nodes[id].title, kind: state.nodes[id].kind ?? 'task', turns: turnsOf(id), notes: ['↻ 环'] })
      return
    }
    const node = state.nodes[id]
    const notes = []
    if (node.kind === 'aside') notes.push('插话')
    if (printed.has(id)) notes.push(`↩ 同 ${id}`)
    for (const p of node.parents) if (p !== 'root' && !safe(p)) notes.push('⚠ 父节点缺失')
    rows.push({
      id, depth, cycle: false,
      parentIds: node.parents.filter((p) => p !== 'root'),
      title: node.title, kind: node.kind ?? 'task', turns: turnsOf(id), notes,
    })
    printed.add(id)
    const next = new Set([...path, id])
    for (const child of order(children.get(id) ?? [])) walk(child, depth + 1, next)
  }
  const tops = order(ids.filter((id) => state.nodes[id].parents.length === 0 || state.nodes[id].parents.includes('root') || state.nodes[id].parents.every((p) => !safe(p))))
  for (const id of tops) walk(id, 0, new Set())
  // 没有顶层节点时（全在环里 / 全断链）上面什么都不会画——把剩下的也画出来，
  // 否则"图是空的"会被误读成"结构是空的"。
  for (const id of order(ids)) {
    if (printed.has(id)) continue
    walk(id, 0, new Set())
  }
  const unattached = turns.filter((t) => (state.membership[String(t.turn)] ?? []).length === 0).map((t) => t.turn)
  return { rows, unattached, compress }
}

// ---- renderTree：把行结构画成带引导线的树（同样从 tools/probes/pipeline.mjs 抽取）----
/**
 * 把结构画成**树状缩进图**，每个节点后面跟它收的回合号。
 *
 * 为什么要画：判"该合还是该拆"时，一行行读表看不出形状；
 * 而**根节点一人收了十几行**这种问题在图上一眼就看得见。
 *
 * - 回合号压成区间（`#7–9`），一行不至于太长；
 * - 一个节点有多个父时**在每个父下都画一次**（这是 DAG，不是树），
 *   重复出现的那次标 `↩ 同 nX`；
 * - 父母不在节点表里 → 画在顶层并标 `⚠ 父节点缺失`；
 * - 有环时标 `↻ 环` 并停住（不会递归到爆栈）。
 */
export function renderTree(state: TaskGraph, turns: Turn[]): { text: string; unattached: number[] } {
  const { rows, unattached, compress } = treeRows(state, turns)
  const gap = (depth: number): string => (depth === 0 ? '' : '│  '.repeat(depth - 1) + '├─ ')
  const text = rows.map((r) => {
    const marks = [...r.notes]
    const label = `${r.id} ${r.title} ← ${r.turns.length === 0 ? '（没有回合）' : compress(r.turns)}` +
      (marks.length > 0 ? `　[${marks.join(' · ')}]` : '')
    return `${gap(r.depth)}${label}`
  }).join('\n')
  return { text, unattached }
}

/**
 * 把 `treeRows` 的**扁平行**嵌成树：每个节点带上它的子行。
 *
 * 为什么需要：面板要的是**可折叠的目录树**（`<details>/<summary>` 嵌套），
 * 而 `treeRows` 给的是"深度 + 顺序"的扁平表——`renderTree` 把它画成文本，
 * 这里把它嵌成结构。两者用的是**同一份行**，所以面板上的树与研究里的树同源。
 *
 * 多父节点（`↩ 同 nX`）天然处理：它在每个父下各出现一次，于是各自嵌进各自的子树。
 */
export interface TreeOutline {
  row: TreeRow
  children: TreeOutline[]
}

export function nestRows(rows: TreeRow[]): TreeOutline[] {
  const roots: TreeOutline[] = []
  // 栈里放"当前这一层的祖先"，深度回退时弹栈
  const stack: TreeOutline[] = []
  for (const row of rows) {
    const node: TreeOutline = { row, children: [] }
    while (stack.length > row.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    stack.push(node)
  }
  return roots
}

/** 子树里一共有几个节点（不含自己），用来在折叠时显示"+N"。 */
export function descendantCount(node: TreeOutline): number {
  return node.children.reduce((sum, child) => sum + 1 + descendantCount(child), 0)
}
