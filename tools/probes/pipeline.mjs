#!/usr/bin/env node
/**
 * **冻结的任务结构流水线**——提示词的唯一来源。
 *
 * ## 为什么要有这个文件
 *
 * 这条线的实测结论里有三条是**措辞级**的（同一件事正着说 3/3、反着说 1/3），
 * 所以"提示词"必须是**可 diff 的代码**，而不是散在研究笔记里的引用块。
 * 本模块导出三段提示词与三个纯函数，`research/task-dag-pipeline.md` 逐行引用它，
 * `scripts/verify-task-dag-pipeline.cjs` **离线**校验两者一致（不需要模型、不花钱）。
 *
 * ## 存储形态：**存最具体落点**（2026-10-09 定案）
 *
 * 三段跑完之后，`membership` 要过一遍 `mostSpecific()`：
 * 去掉"被同一回合里另一个落点包含"的祖先，只留最具体的那些。
 *
 * 理由（实测见 `research/closure-explained.md`）：
 * - 中间层的路径**本来就写在节点图的 `parents` 里**，存进落点不携带新信息；
 * - 存最小集合 ⇒ 三次运行的"层级风格方差"（根收 3 / 21 / 3 行）从数据里消失；
 * - 想显示整条链时用 `closeUnderAncestors()` 展开，**两种取法逐节点等价**
 *   （travel-run3 的 11 个任务节点上结果完全相同）。
 *
 * ## 三段的分工（每一段都对应一条实测结论，别合并）
 *
 * | 段 | 输入 | 输出 | 为什么必须单独一段 |
 * |---|---|---|---|
 * | `BUILD` | 前 N 个回合 | `{nodes, membership}` | 一次建基础结构 |
 * | `ASSIGN` | 节点清单 + 新回合 | `{placements, newNodes}` | **不带任何 ops 词汇表**：ops 例子里的 `assign` 只挂一个节点，等于示范"单一归属"（实测多归属 1.7/4 → 0/4） |
 * | `CONSOLIDATE` | **只有节点清单** | `{ops}` | 合并只能在这一段发生：逐回合那一问只能*新增*，实测把"sudo 两步"记成 3 个节点 |
 *
 * ## 三条不许改的措辞（都有配对实测）
 *
 * 1. `ASSIGN` 里"闲聊"那句必须跟"不算推进"**同句**、且写成"也算一个落点"——
 *    同句正着写 \`#21\` 两处 **3/3**；写成"闲聊不算推进" **1/3**（配对、唯一变量）；
 *    **拆成两个 bullet 也不行**：我固化时拆过一次，同一份语料掉回 1 处落点
 *    （见 \`research/dag-label-sheet-2026-10-09.md\` 的 #21 那一行）。
 * 2. id 一律**字符串**、容器一律**字典**（`nodes` / `membership` / `placements`）——
 *    换成数组下标后 JSON 直接解析失败（裸标识符），结构轴从 3/3 掉到 0/3。
 * 3. `BUILD` 里"父节点是**纯容器**"这句保持原样：换成"父子都要挂"后
 *    `sudo 合并` 3/3 → 1/3、2/3，而父子双命中并没有因此出现（仍 0/4）。
 */

/** 三段提示词里的占位符，替换时会做存在性检查（缺了就是拼装 bug）。 */
export const PLACEHOLDERS = { nodes: '$NODES', turns: '$TURNS', roots: '$ROOTS' }

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
export function fillPrompt(prompt, { nodes, turns, roots }) {
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
export function renderTurns(turns) {
  return turns.map((t) => `#${t.turn} ${String(t.prompt).replace(/\s+/g, ' ').slice(0, 90)}`).join('\n')
}

/** 节点字典 → 提示词里的清单（父在前，便于模型判断层级）。 */
export function nodeList(nodes) {
  return Object.entries(nodes).map(([id, n]) => `${id} [父 ${n.parents.join('/')}] ${n.title}`).join('\n')
}

/** 空状态。 */
export function emptyState() {
  return { nodes: {}, membership: {} }
}

/**
 * 应用第二段的回复。
 *
 * - `newNodes` 里声明的 id 才算存在（**不接受** placements 里凭空出现的 id）；
 * - 一个回合给多个落点 = 多归属，保留顺序、去重。
 */
export function applyAssign(state, reply) {
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
  for (const [turn, list] of Object.entries(reply?.placements ?? {})) {
    const keep = [...new Set((list ?? []).map(String).filter((id) => nodes[id] !== undefined))]
    for (const id of (list ?? []).map(String)) if (nodes[id] === undefined) dropped.push(`${turn}:${id}`)
    if (keep.length > 0) membership[String(turn)] = keep
  }
  return { nodes, membership, dropped }
}

/**
 * 应用第三段的回复。`merge` 会真的把 `from` 的归属并进 `into`——
 * 这是"两个兄弟合成一个"在数据上的唯一实现方式。
 */
export function applyConsolidate(state, ops) {
  const nodes = structuredClone(state.nodes)
  const membership = structuredClone(state.membership)
  const unknown = []
  for (const op of ops ?? []) {
    const kind = String(op?.op ?? '')
    if (kind === 'merge') {
      const into = String(op.into)
      const from = (op.from ?? []).map(String).filter((id) => id !== into)
      if (nodes[into] === undefined) continue
      for (const id of from) delete nodes[id]
      const moved = new Set([into, ...from])
      for (const [turn, ids] of Object.entries(membership)) {
        if (!ids.some((id) => moved.has(id))) continue
        membership[turn] = [...new Set([...ids.filter((id) => !moved.has(id)), into])]
      }
      if (op.title !== undefined) nodes[into].title = String(op.title)
      if (op.parents !== undefined) nodes[into].parents = op.parents.map(String)
    } else if (kind === 'retitle') {
      const n = nodes[String(op.id)]
      if (n !== undefined && op.title !== undefined) n.title = String(op.title)
    } else if (kind === 'reparent') {
      const n = nodes[String(op.id)]
      if (n !== undefined && op.parents !== undefined) n.parents = op.parents.map(String)
    } else {
      unknown.push(kind)
    }
  }
  return { nodes, membership, unknown }
}

/** 某节点的祖先集合（不含 `root`）。 */
export function ancestorsOf(nodes, id) {
  const seen = new Set()
  const queue = [...(nodes[id]?.parents ?? [])]
  while (queue.length > 0) {
    const p = queue.pop()
    if (p === 'root' || seen.has(p)) continue
    seen.add(p)
    queue.push(...(nodes[p]?.parents ?? []))
  }
  return seen
}

/**
 * **与语料无关的形状统计**——换一套语料也能用（`measure` 里那些判据是
 * 上一套语料（部署会话）的回合号写死的，只在那套语料上有意义）。
 *
 * 多归属必须分两类，因为使用者对它们的裁定不同：
 *
 * - **单链**：所有落点在**同一条祖先链**上（父与子同时命中）。
 *   使用者裁定"**允许、不算问题**"。
 * - **异支**：存在两个落点互不为祖先/后代（同一回合真的在推**两件事**）。
 *   这才是"同个对话存了几个任务的内容，几个任务下都放"要的那种多归属。
 */
export function attachmentShape(state, total) {
  const idsOf = (t) => state.membership[String(t)] ?? []
  const isAncestor = (a, b) => a !== b && ancestorsOf(state.nodes, b).has(a)
  const ordered = (list) =>
    list.every((a) => list.every((b) => a === b || isAncestor(a, b) || isAncestor(b, a)))
  // `zero` 数的是"**没有归属的回合**"（1..total 里缺席的那些），
  // 而不是"值为空列表的 membership 条目"——后者会因为 applyAssign 不写空列表而恒为 0，
  // 与表里 (a) 组列出的行数对不上。
  let zero = total === undefined ? 0 : [...Array(total)].map((_, i) => String(i + 1)).filter((t) => idsOf(t).length === 0).length
  let single = 0
  let chain = 0
  let branch = 0
  for (const list of Object.values(state.membership)) {
    if (list.length === 0) zero += 1
    else if (list.length === 1) single += 1
    else if (ordered(list)) chain += 1
    else branch += 1
  }
  return { zero, single, chain, branch }
}

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
export function treeRows(state, turns) {
  const ids = Object.keys(state.nodes)
  const children = new Map()
  for (const id of ids) {
    for (const parent of state.nodes[id].parents) {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(id)
    }
  }
  const turnsOf = (id) =>
    turns.filter((t) => (state.membership[String(t.turn)] ?? []).includes(id)).map((t) => t.turn)
  const compress = (list) => {
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
  const order = (list) => [...list].sort((a, b) => (turnsOf(a)[0] ?? 1e9) - (turnsOf(b)[0] ?? 1e9) || a.localeCompare(b))
  const rows = []
  const printed = new Set()
  const safe = (id) => state.nodes[id] !== undefined
  const emit = (id, depth, notes, cycle) => {
    const node = state.nodes[id]
    rows.push({
      id, depth, cycle,
      parentIds: node === undefined ? [] : node.parents.filter((p) => p !== 'root'),
      title: node === undefined ? '' : node.title,
      kind: node === undefined ? 'task' : (node.kind ?? 'task'),
      turns: turnsOf(id),
      notes,
    })
  }
  const walk = (id, depth, path) => {
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
export function renderTree(state, turns) {
  const { rows, unattached, compress } = treeRows(state, turns)
  const gap = (depth) => (depth === 0 ? '' : '│  '.repeat(depth - 1) + '├─ ')
  const text = rows.map((r) => {
    const marks = [...r.notes]
    const label = `${r.id} ${r.title} ← ${r.turns.length === 0 ? '（没有回合）' : compress(r.turns)}` +
      (marks.length > 0 ? `　[${marks.join(' · ')}]` : '')
    return `${gap(r.depth)}${label}`
  }).join('\n')
  return { text, unattached }
}

/**
 * **祖先闭包**：把每个落点补全为"它 + 它的全部祖先"。
 *
 * 为什么：使用者认可的正是"挂具体节点时，整条祖先链一起挂"
 * （`research/fairytale-verdict-2026-10-09.md`）。但实测同一份流水线连跑 3 次，
 * 有时给这一档、有时只挂最具体的那个（`research/fairytale-stability-2026-10-09.md`）。
 * ⇒ 与其靠提示词让它自觉，不如**在数据上确定性地补齐**：这样风格不会跳。
 *
 * 纯函数：不改传入的 state。补出来的落点**排在原有之后**，且已存在的祖先不重复。
 */
export function closeUnderAncestors(state) {
  const membership = {}
  for (const [turn, ids] of Object.entries(state.membership)) {
    const out = []
    const seen = new Set()
    for (const id of ids) {
      if (!seen.has(id)) { seen.add(id); out.push(id) }
      for (const anc of ancestorsOf(state.nodes, id)) {
        if (!seen.has(anc)) { seen.add(anc); out.push(anc) }
      }
    }
    membership[turn] = out
  }
  return { nodes: state.nodes, membership }
}

/** 每个落点是否都已含全部祖先（闭包后应为 true）——这是可以当闸门用的判据。 */
export function isAncestorClosed(state) {
  return Object.entries(state.membership).every(([, ids]) =>
    ids.every((id) => [...ancestorsOf(state.nodes, id)].every((anc) => ids.includes(anc))),
  )
}

/**
 * **根裁定**：顶层节点"能不能用一句话概括"。
 *
 * 实测三臂对照（`research/root-adjudication-ab.md`）：这句话比"是几件独立的大事吗"
 * 稳得多——两批共 6 次里**一次都没有把两件独立的事合并**（错合并的代价最大：
 * 会把"任务演化分叉"这个信号藏起来），而分类式问法 1/3 与 3/3 次都合并错了。
 *
 * 只在**顶层有 ≥2 个非插话节点**时才问这一次；答案是"能"，就按它给的名字建项目节点、
 * 把那些顶层挂进去（**应用它的语义判断，而不是我的阈值**）。
 */
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

export const isMetaName = (name) => META_NAME_RE.test(String(name))

/** 把顶层节点渲染成**带序号**的清单——让模型回序号，别抄标题（抄会把注记一起抄回来）。 */
export function renderRoots(state, turns) {
  const ids = Object.keys(state.nodes)
  const roots = mostSpecific(state) === state
    ? ids.filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
    : ids.filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
  return roots.map((id, k) => {
    const subtree = new Set([id, ...ids.filter((x) => ancestorsOf(state.nodes, x).has(id))])
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
export function applyAdjudication(state, verdict, rootIds = []) {
  const groups = Array.isArray(verdict?.groups) ? verdict.groups : []
  const nodes = { ...state.nodes }
  const merged = []
  const taken = new Set()
  groups.forEach((g, k) => {
    const ids = (g.roots ?? [])
      .map((x) => (typeof x === 'number' ? rootIds[x - 1] : rootIds.find((id) => state.nodes[id]?.title === String(x)) ?? x))
      .filter((id) => typeof id === 'string' && state.nodes[id] !== undefined && !taken.has(id))
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

export const isContinuation = (prompt) => {
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
export function carryForward(state, turns) {
  const membership = { ...state.membership }
  const ordered = [...turns].sort((a, b) => a.turn - b.turn)
  const inherited = []
  const has = (t) => (membership[String(t.turn)] ?? []).length > 0
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
export function rootSummary(state, turns = []) {
  const ids = Object.keys(state.nodes)
  const roots = ids.filter((id) => state.nodes[id].parents.includes('root'))
  const projects = roots.filter((id) => state.nodes[id].kind !== 'aside')
  const asides = roots.filter((id) => state.nodes[id].kind === 'aside')
  const turnNo = (t) => (typeof t === 'number' ? t : t.turn)
  /** 每条线：收了几个回合、从第几回合开始（**分叉点**）。 */
  const lines = roots.map((id) => {
    const subtree = new Set([id, ...ids.filter((x) => ancestorsOf(state.nodes, x).has(id))])
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
 * **强制合并成一个项目根**——使用者裁定之后，流水线**不再调用**它。
 *
 * 保留的理由：它是个纯函数、有离线断言，将来若要"把一场会话硬压成一个项目视图"
 * 可以按需调用（例如某个展示模式）。默认路径不做任何 reparent。
 *
 * 纯函数；幂等。
 */
export function ensureProjectRoot(state, { maxProjects = 1 } = {}) {
  const gate = { projects: Object.keys(state.nodes).filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside') }
  if (gate.projects.length <= maxProjects) return { state, gate, repaired: false, promoted: null, reparented: [] }
  const countOf = (id) => Object.values(state.membership).filter((ids) => ids.includes(id)).length
  const promoted = [...gate.projects].sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b))[0]
  if (promoted === undefined) return { state, gate, repaired: false, promoted: null, reparented: [] }
  const nodes = { ...state.nodes }
  const reparented = []
  for (const id of gate.projects) {
    if (id === promoted) continue
    nodes[id] = { ...nodes[id], parents: [promoted] }
    reparented.push(id)
  }
  return { state: { nodes, membership: state.membership }, gate, repaired: true, promoted, reparented }
}

/**
 * **最具体落点**：把"被同一回合里另一个落点包含"的祖先去掉。
 *
 * 它与 `closeUnderAncestors` 互逆，但**更该用来存**：
 * 中间层的路径本来就写在节点图的 `parents` 里，不携带额外信息；
 * 存最小集合 ⇒ 跨运行的"层级风格方差"从数据里消失，渲染想看几层再按图展开。
 * 见 `research/closure-explained.md`。
 */
export function mostSpecific(state) {
  const membership = {}
  for (const [turn, ids] of Object.entries(state.membership)) {
    membership[turn] = ids.filter((id) => !ids.some((other) => other !== id && ancestorsOf(state.nodes, other).has(id)))
  }
  return { nodes: state.nodes, membership }
}

/**
 * 流水线的**收尾**：先过结构闸门（必要时提升项目根），再规范化成最具体落点。
 *
 * 调用点只需要这一个函数——顺序（闸门在前、strip 在后）写在这里，
 * 免得每个入口各记一遍。见本文件头部"存储形态"与 `rootGate`。
 */
export function finalize(state, turns = []) {
  return {
    state: mostSpecific(state),
    roots: rootSummary(state, turns),
  }
}

/**
 * **两轴分开量**（结构失败与语义失败是两回事，别混着数）。
 *
 * 结构轴只看形状：id 解析得出、父节点存在、回合覆盖。
 * 语义轴按人工标记的判据算；其中"父与子同时命中"使用者裁定为
 * **允许**（不是必须），所以它只作为"不计为错"进入 `sem.parent`，不单独判失败。
 */
export function measure(state, total) {
  const ids = new Set(Object.keys(state.nodes))
  const of = (t) => state.membership[String(t)] ?? []
  const titleOf = (t) => of(t).map((id) => state.nodes[id]?.title ?? '??').join(' + ')
  const sudo = Object.entries(state.nodes).filter(([, n]) => /sudo/i.test(n.title))
  return {
    structural: {
      roots: rootSummary(state),
      idsResolve: Object.values(state.membership).every((l) => l.every((id) => ids.has(id))),
      parentsResolve: Object.values(state.nodes).every((n) => n.parents.every((p) => p === 'root' || ids.has(p))),
      uncovered: [...Array(total)].map((_, i) => String(i + 1)).filter((t) => of(t).length === 0),
    },
    sem: {
      sudoMerged: sudo.length === 1 && [23, 24].every((t) => of(t).includes(sudo[0][0])),
      sudoDetail: `${sudo.length} 个(${sudo.map(([, n]) => n.title).join('/') || '无'})`,
      only25: of(25).length > 0 && of(25).every((id) => /权限/.test(state.nodes[id]?.title ?? '')),
      detail25: titleOf(25) || '(空)',
      multi21: of(21).length >= 2,
      detail21: titleOf(21) || '(空)',
      /** 22/26/27/28 有几处给了 ≥2 个落点（使用者裁定：这类是**允许**的，不计为错）。 */
      multi: [22, 26, 27, 28].filter((t) => of(t).length >= 2).length,
      /** 其中真正构成父子的有几个（信息用，不作得分）。 */
      chain: [22, 26, 27, 28].filter((t) => of(t).some((a) => of(t).some((b) => a !== b && ancestorsOf(state.nodes, b).has(a)))).length,
    },
  }
}
