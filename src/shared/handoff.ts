/**
 * **交接摘要**：把"选中的枝 / 回合"整理成一份可以贴进**新会话**的说明。
 *
 * ## 它要同时满足两件事（使用者的原话）
 *
 * > "即减少新会话的学习难度，又保证新会话的了解程度"
 *
 * 于是分成两层：
 * - **结构骨架**（`withTitles = true` 时）：保留枝的**层级**（缩进），一眼看清"这件事分几摊、
 *   哪个枝收哪些回合"。这是"了解程度"的来源——没有它，新会话只能看到一堆散回合；
 * - **回合要点**：每条一行"用户说了什么 → agent 当时理解成什么"。这是"学习难度"的落点——
 *   新会话不用重读全文，就能知道发生了什么、当时是怎么理解的。
 *
 * ## 三条硬约定
 *
 * 1. **这是一份快照**：源会话后续的更新**不会**同步过来，摘要里必须写清楚（否则会误以为它是活的）；
 * 2. **带枝名就必须保留结构**（使用者："如果是带不带枝的名称，那要带上并保留结构"）
 *    —— 要么不给枝名，要么给完整的层级，不许拍平成一串标题；
 * 3. **纯函数**：选择集的口径、文本形状都在这儿定死，宿主与断言用同一份
 *    （与 `taskPipeline` / `semantic` 同样的理由：只允许有一份实现）。
 *
 * ## 选择集的口径（使用者："枝未选中时可以整棵，之后就是可选"）
 *
 * 点一个枝 ⇒ 把**整棵子树**的回合铺进选择集；之后用户自由增减（取消某个回合、
 * 或再点别的枝叠加）。所以这里没有"枝选择"这个状态——**只有回合集合**，
 * "某个枝是否整选"是由集合反推出来的（`fullySelectedNodes`）。
 */

/** 一条回合的要点材料（面板从投影里取，截断口径与语义核查一致）。 */
export interface HandoffTurn {
  turn: number
  /** 所挂枝的标题（`withTitles = false` 时不进正文）。 */
  task: string
  /** 用户这一回合的指令。 */
  ask: string
  /** agent 当时的自述理解（判它），拿不到就空。 */
  did: string
}

export interface HandoffOutlineRow {
  id: string
  title: string
  depth: number
  /** 这一枝（含子枝）收的回合，已排序去重。 */
  turns: number[]
}

export interface HandoffInput {
  sessionId: string
  sessionTitle?: string
  goal?: string
  turns: HandoffTurn[]
  outline: HandoffOutlineRow[]
  /** 选中的枝（用于写"选中 K 枝"这句账）。 */
  nodeIds: readonly string[]
}

export interface HandoffOptions {
  /** 带枝名称 ⇒ 输出层级结构；不带 ⇒ 只出回合要点。 */
  withTitles: boolean
  /** 正文里每条材料截多长（默认 200 字：新会话要的是要点，不是全文）。 */
  clip?: number
}

export interface HandoffDraft {
  /** 可以直接贴走的文本。 */
  text: string
  /** 进了正文的回合号（升序）。 */
  turns: number[]
  /** 字数（给人看的规模感）。 */
  chars: number
}

const CLIP_DEFAULT = 200

const oneLine = (text: string): string => String(text ?? '').replace(/\s+/g, ' ').trim()

const clip = (text: string, limit: number): string => {
  const flat = oneLine(text)
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * 一个枝（含所有子枝）收的回合。
 *
 * `membership` 是"回合 → 挂了它的节点"（宿主结构的形状）；子枝关系从 `parents` 反推。
 * 用 BFS 防环（多父 + 人工编辑都可能造出环）。
 */
export function subtreeTurns(
  nodes: Record<string, { parents?: string[] } | undefined>,
  membership: Record<string, string[] | undefined>,
  nodeId: string,
): number[] {
  const wanted = new Set<string>([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const [id, node] of Object.entries(nodes)) {
      if (wanted.has(id)) continue
      if ((node?.parents ?? []).includes(current)) {
        wanted.add(id)
        queue.push(id)
      }
    }
  }
  const out = new Set<number>()
  for (const [turn, ids] of Object.entries(membership)) {
    for (const id of ids ?? []) if (wanted.has(id)) out.add(Number(turn))
  }
  return [...out].sort((left, right) => left - right)
}

/**
 * 把"选中的枝"铺成回合集合，再并上用户单独勾的回合。
 * **去重 + 升序**：摘要是给人读的，顺序必须稳定（同一份选择永远得到同一份文本）。
 */
export function selectedTurns(
  nodes: Record<string, { parents?: string[] } | undefined>,
  membership: Record<string, string[] | undefined>,
  nodeIds: readonly string[],
  extraTurns: readonly number[] = [],
): number[] {
  const out = new Set<number>(extraTurns)
  for (const id of nodeIds) for (const turn of subtreeTurns(nodes, membership, id)) out.add(turn)
  return [...out].sort((left, right) => left - right)
}

/** 那些"整枝都被选中"的枝（面板上标一下，让人知道这一枝拿全了）。 */
export function fullySelectedNodes(
  nodes: Record<string, { parents?: string[] } | undefined>,
  membership: Record<string, string[] | undefined>,
  nodeIds: readonly string[],
  turns: readonly number[],
): string[] {
  const chosen = new Set(turns)
  return nodeIds.filter((id) => {
    const all = subtreeTurns(nodes, membership, id)
    return all.length > 0 && all.every((turn) => chosen.has(turn))
  })
}

/**
 * **确定性草稿**（不需要模型，秒出、免费）。
 *
 * 模型精炼那一步（阶段 2）以这份为底稿：先给人看"将要带过去的是什么"，再决定要不要花钱润色。
 */
export function handoffDraft(input: HandoffInput, options: HandoffOptions): HandoffDraft {
  const limit = options.clip ?? CLIP_DEFAULT
  const wanted = new Set(input.turns.map((item) => item.turn))
  const turns = [...wanted].sort((left, right) => left - right)
  const lines: string[] = []

  const range = turns.length === 0 ? '（没有选中任何回合）' : `#${turns[0]}–#${turns[turns.length - 1]}`
  lines.push(`# 交接摘要${input.sessionTitle === undefined || input.sessionTitle.trim() === '' ? '' : ` · ${oneLine(input.sessionTitle)}`}`)
  lines.push('')
  // 去掉 `session-` 前缀再截：否则显示出来的是 `session-`（前 8 个字符全是前缀，实测踩到）
  const shortId = input.sessionId.replace(/^session-/, '').slice(0, 8)
  lines.push(`来源：会话 ${shortId} · 回合 ${range}（共 ${turns.length} 条 · 选中 ${input.nodeIds.length} 枝）`)
  // **快照这件事必须写在正文里**：新会话里读的人（或模型）会把这份当全部事实
  lines.push('这是**当时**的一段快照：源会话之后的更新不会同步到这里。')
  if (input.goal !== undefined && oneLine(input.goal) !== '') lines.push(`会话目标：${clip(input.goal, 300)}`)

  if (options.withTitles) {
    lines.push('')
    lines.push('## 任务结构（层级原样保留；括号里是它收的回合）')
    /**
     * `outline` 是**扁平有序**的（每行自带 `depth`），这里只按 depth 缩进输出。
     * **不重建父子关系**：选择集可能只覆盖其中几枝，"补全"出来的层级反而是假的。
     * 带枝名就必须保留结构（使用者裁定）——给的就是原样的层级 + 被选中的回合范围。
     */
    for (const row of input.outline) {
      const mine = row.turns.filter((turn) => wanted.has(turn))
      if (mine.length === 0) continue
      const spread = mine.length === 1 ? `#${mine[0]}` : `#${mine[0]}–#${mine[mine.length - 1]}`
      lines.push(`${'  '.repeat(Math.max(0, row.depth ?? 0))}- ${oneLine(row.title) || row.id}（${spread}）`)
    }
  }

  lines.push('')
  lines.push('## 回合要点')
  for (const turn of input.turns.slice().sort((left, right) => left.turn - right.turn)) {
    const ask = clip(turn.ask, limit)
    const did = clip(turn.did, limit)
    const head = options.withTitles && oneLine(turn.task) !== '' ? `#${turn.turn}｜${oneLine(turn.task)}｜` : `#${turn.turn}｜`
    lines.push(`${head}用户：${ask === '' ? '（无文字指令）' : ask}`)
    if (did !== '') lines.push(`　　　agent 理解：${did}`)
  }

  const text = `${lines.join('\n')}\n`
  return { text, turns, chars: text.length }
}

/**
 * 勾/取消一个回合（**升序去重**：摘要是给人读的，顺序必须稳定）。
 * 面板的"自由增减"走的就是它——枝铺开之后，用户还能单独取消其中某个回合。
 */
export function toggleTurn(list: readonly number[], turn: number): number[] {
  return (list.includes(turn) ? list.filter((item) => item !== turn) : [...list, turn]).sort((left, right) => left - right)
}

/**
 * 点一个枝：**整棵子树铺进选择集**；再点一次（整棵都在里面了）就整棵取消。
 *
 * 使用者裁定："枝未选中时可以整棵，之后就是可选"——所以铺开是"当成一批加入"，
 * 而不是"绑定这个枝"：加入之后每个回合都能单独取消（`toggleTurn`），
 * 也不会因为之后改了某个回合而牵动枝。
 */
export function toggleBranch(list: readonly number[], subtree: readonly number[]): number[] {
  if (subtree.length === 0) return [...list].sort((left, right) => left - right)
  const chosen = new Set(list)
  const whole = subtree.every((turn) => chosen.has(turn))
  if (whole) for (const turn of subtree) chosen.delete(turn)
  else for (const turn of subtree) chosen.add(turn)
  return [...chosen].sort((left, right) => left - right)
}
