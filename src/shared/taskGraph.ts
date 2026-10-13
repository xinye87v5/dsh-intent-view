/**
 * 任务结构的**人工调整**：纯函数，无 React、无 DOM、无宿主依赖。
 *
 * ## 为什么要这一层（使用者裁定 2026-10-10）
 *
 * 结构里有两类错，**判据逼不近**：
 *
 * 1. **挂错对象**——实测里模型把"缓存目录权限要不要配"挂到了"缓存目录**位置**"节点上；
 * 2. **命名不对**——合并是对的（3/3），但名字还是 `sudo 两次原因`（"问题"式），
 *    而真值是 `sudo 处理`（"正在做的事"式）。
 *
 * 我原本打算再写两条判据去自动判定这两件事，使用者裁定改成：
 * **给使用者一个手动改落点的入口**。判据只留"能不能被机器验证"的部分
 * （id 能解析、父节点存在、覆盖完整），语义对错交给人来定。
 *
 * ## 覆盖（override）存在哪
 *
 * **不进会话日志**。`Session.append` 不写 `ignorable`，第三方自定义事件会让别的构建
 * 拒绝重建会话（这是本项目早先就踩住的契约）。所以覆盖**独立存放**（宿主侧按会话存一份），
 * 在渲染/回传时**叠加**在模型算出的结构上：
 *
 * ```
 * 模型折叠 → 结构（authoritative，可随时重算）
 *                 ↓ applyOverrides(graph, overrides)   ← 纯函数，本文件
 * 人工调整后的结构（面板显示 / 导出用）
 * ```
 *
 * 这样：模型那侧永远可以重算，人工调整永远可回放、可撤销、可单独评审。
 */

/** 一个任务节点。父节点是**列表**——多父就是"真 DAG 分支"（已实测会出现）。 */
export interface TaskNode {
  /** 可选：流水线里的节点是按 id 为键存的，内层不带 id；人工新建时会写上。 */
  id?: string
  title: string
  /** `root` 表示顶层。 */
  parents: string[]
  kind?: string
}

/** 结构：节点表 + 回合到节点的归属（值恒为列表，哪怕只有一个）。
 *
 * ⚠️ **落点列表的顺序不参与契约**：`mostSpecific` 与 `closeUnderAncestors` 只保证
 * "集合"互逆，先后次序由实现决定（实测里两者给出的顺序确实不同：`['a','p','c']` vs
 * `['c','a','p']`）。要比对就按集合比；要显示就自己排序。 */

export interface TaskGraph {
  nodes: Record<string, TaskNode>
  /** 键是回合号（字符串），值是节点 id 列表。 */
  membership: Record<string, string[]>
}

/** 人工调整的一步。与流水线里验证过的 ops 词汇表一致（merge/retitle 那套）。 */
/**
 * 人工调整的类型：**唯一一份**在 `taskOverrides.ts`（含 `OVERRIDE_OPS` 词汇表与形状校验）。
 *
 * 这里原先自己声明了一份，于是加 `reparent` 时两边不同步、tsc 报
 * "Type ... is not assignable"——正是"同一契约两处声明"的典型症状。
 * 现在只 import + re-export，别处照旧可以从本文件取类型。
 */
export type { TaskOverride } from './taskOverrides.js'
import type { TaskOverride as TaskOverrideType } from './taskOverrides.js'

/** 一次应用的账：哪些生效了、哪些被拒（**不抛异常**，拒了要能说清原因）。 */
export interface OverrideResult {
  graph: TaskGraph
  applied: number
  rejected: Array<{ override: TaskOverrideType; reason: string }>
}

const ROOT = 'root'

/** 某节点的祖先集合（不含 `root`）。有环时按已访问剪枝，不会死循环。 */
export function ancestorsOf(graph: TaskGraph, id: string): Set<string> {
  const seen = new Set<string>()
  const queue = [...(graph.nodes[id]?.parents ?? [])]
  while (queue.length > 0) {
    const p = queue.pop() as string
    if (p === ROOT || seen.has(p)) continue
    seen.add(p)
    queue.push(...(graph.nodes[p]?.parents ?? []))
  }
  return seen
}

/**
 * **最具体落点**：去掉"被同一回合里另一个落点包含"的祖先。
 *
 * 这是**存储形态**（使用者已定案）：中间层路径本来就写在 `parents` 里，
 * 存进落点不携带新信息；存最小集合后"层级风格"不再随采样跳。
 */
export function mostSpecific(graph: TaskGraph): TaskGraph {
  const membership: Record<string, string[]> = {}
  for (const [turn, ids] of Object.entries(graph.membership)) {
    membership[turn] = ids.filter(
      (id) => !ids.some((other) => other !== id && ancestorsOf(graph, other).has(id)),
    )
  }
  return { nodes: graph.nodes, membership }
}

/** **祖先闭包**：每个落点补上它的全部祖先（与 `mostSpecific` 互逆，显示时用）。 */
export function closeUnderAncestors(graph: TaskGraph): TaskGraph {
  const membership: Record<string, string[]> = {}
  for (const [turn, ids] of Object.entries(graph.membership)) {
    const out: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
      for (const anc of ancestorsOf(graph, id)) {
        if (!seen.has(anc)) {
          seen.add(anc)
          out.push(anc)
        }
      }
    }
    membership[turn] = out
  }
  return { nodes: graph.nodes, membership }
}

/**
 * **同一条父枝下不许有同名**（使用者 2026-10-10："同个父枝不允许下级有同名枝或节点"）。
 *
 * 规则的精确定义（"同级"按**共享至少一个父**算，因为这里一个节点可以挂多个父）：
 * 与 `id` 共享任一父节点的其它节点，标题（trim 后）不许与 `title` 相同。
 *
 * 为什么必须挡：树上一条枝的标题是**人认路的唯一标识**。同级出现两个"整理工作文件"，
 * 人就再也说不清"我要挪到哪一个"——而面板上所有动作（拖拽、复制到…、新建枝）都按标题读。
 *
 * @returns 撞名的那个节点 id（没有冲突时 `undefined`）。
 */
export function siblingTitleConflict(
  nodes: Record<string, TaskNode>,
  id: string,
  title: string,
): string | undefined {
  const wanted = title.trim()
  if (wanted === '') return undefined
  const mine = nodes[id]?.parents ?? []
  // 新建节点（还没进图）时按调用方给的父集合比——见 `validateOverride` 的 create 分支
  const parents = mine.length > 0 ? mine : (nodes[id]?.parents ?? [])
  for (const [otherId, node] of Object.entries(nodes)) {
    if (otherId === id) continue
    if (String(node.title ?? '').trim() !== wanted) continue
    // 同级 = 共享至少一个父；两边都没有父（都是顶层孤儿）也算同级
    const shared = (node.parents ?? []).some((p) => parents.includes(p))
    const bothRootless = (node.parents ?? []).length === 0 && parents.length === 0
    if (shared || bothRootless) return otherId
  }
  return undefined
}

/**
 * **删枝时到底删掉哪些节点**（含 `id` 自身）——标准树语义：**整棵子树一起删**。
 *
 * ## 为什么要改（使用者 2026-10-10："删除枝的时候，下挂的所有回合还是没有变成独立回合"）
 *
 * 上一版是"只删这一个节点，子枝**上提一级**"（继承被删枝的父）。那等于"解散这个分组"
 * 而不是"删除这个枝条"：删完之后，挂在子枝上的回合仍然挂在那里，一个都不会变独立——
 * 使用者要的"下挂的回合变成独立回合"永远不会发生。
 *
 * 而且实测建出来的结构里，**父节点常常是纯容器**（回合都归子节点，见 `pruneEmptyLeaves`
 * 的注释）。删一个容器时"上提一级"甚至什么都没改变。文件管理器里删一个目录是删子树，
 * 这里也照这个来。
 *
 * ## 多父保护：共享的子枝不能被连坐
 *
 * 一个节点可能挂在多个枝下（`shared.parents = ['a', 'b']`）。删 `a` 时它**不该被删**——
 * 它还有 `b` 这个家。判据：节点留在删除集里，**当且仅当它的每一个父都在集合里**
 * （子树根除外）。所以这里算完闭包后要反复剔除"外面还有爹"的节点，直到稳定。
 */
export function deleteSet(nodes: Record<string, TaskNode>, id: string): string[] {
  const set = new Set<string>()
  if (nodes[id] === undefined) return []
  set.add(id)
  // 先向下收闭包
  let grew = true
  while (grew) {
    grew = false
    for (const [childId, node] of Object.entries(nodes)) {
      if (set.has(childId)) continue
      if (!node.parents.some((parent) => set.has(parent))) continue
      set.add(childId)
      grew = true
    }
  }
  // 再反复剔除"外面还有爹"的（多父保护）——剔除会让它的后代也重新判定
  let shrank = true
  while (shrank) {
    shrank = false
    for (const member of [...set]) {
      if (member === id) continue
      const parents = nodes[member]?.parents ?? []
      if (parents.every((parent) => set.has(parent))) continue
      set.delete(member)
      shrank = true
    }
  }
  return [...set]
}

/**
 * 删一枝会**波及什么**：删掉哪些节点、哪些回合因此变成独立回合。
 *
 * 界面要把它写在回收站上（"删除枝条 X 及下挂 N 个枝，其中 M 个回合变独立"）——
 * 破坏性操作必须先把后果说清楚。op 与界面共用这一份，避免两处算出不同的数。
 */
export function deleteImpact(
  graph: TaskGraph,
  id: string,
): { nodes: string[]; affected: number[]; orphaned: number[] } {
  const victims = deleteSet(graph.nodes, id)
  const inSet = new Set(victims)
  const affected: number[] = []
  /** **变成独立回合**的那些：摘完之后一个落点都不剩。 */
  const orphaned: number[] = []
  for (const [turn, ids] of Object.entries(graph.membership)) {
    const hit = ids.some((nodeId) => inSet.has(nodeId))
    if (!hit) continue
    affected.push(Number(turn))
    if (ids.every((nodeId) => inSet.has(nodeId))) orphaned.push(Number(turn))
  }
  const asc = (left: number, right: number): number => left - right
  return { nodes: victims, affected: affected.sort(asc), orphaned: orphaned.sort(asc) }
}

/** 一条调整能不能应用；不能则给出人话原因。 */
export function validateOverride(graph: TaskGraph, override: TaskOverrideType): string[] {
  const problems: string[] = []
  const has = (id: string): boolean => graph.nodes[id] !== undefined
  switch (override.op) {
    case 'setPlacement': {
      if (!Number.isInteger(override.turn) || override.turn < 1) problems.push('回合号必须是正整数')
      for (const id of override.nodes) if (!has(id)) problems.push(`没有这个节点：${id}`)
      break
    }
    case 'rename': {
      if (!has(override.id)) problems.push(`没有这个节点：${override.id}`)
      if (String(override.title).trim() === '') problems.push('名字不能为空')
      else {
        const clash = siblingTitleConflict(graph.nodes, override.id, String(override.title))
        if (clash !== undefined) {
          problems.push(`同一条父枝下已经有「${String(override.title).trim()}」了（${clash}）——同级不能同名`)
        }
      }
      break
    }
    case 'merge': {
      if (!has(override.into)) problems.push(`没有这个节点：${override.into}`)
      const from = override.from.filter((id) => id !== override.into)
      if (from.length === 0) problems.push('没有可合并的节点')
      for (const id of from) if (!has(id)) problems.push(`没有这个节点：${id}`)
      /**
       * **带标题的合并也要过"同级不许同名"**：合并会顺手给目标枝改名，
       * 而改名那条规则已经在挡了——两处不一致就等于没挡（同一语义两处实现的老坑）。
       * 校验时先按"被并的枝已经从图里去掉"算，否则会跟即将消失的枝自己撞名。
       */
      if (override.title !== undefined && String(override.title).trim() !== '' && problems.length === 0) {
        const probe: Record<string, TaskNode> = {}
        for (const [id, node] of Object.entries(graph.nodes)) if (!from.includes(id)) probe[id] = node
        const clash = siblingTitleConflict(probe, override.into, String(override.title))
        if (clash !== undefined) {
          problems.push(`同一条父枝下已经有「${String(override.title).trim()}」了（${clash}）——同级不能同名`)
        }
      }
      break
    }
    case 'create': {
      if (override.id === ROOT) problems.push(`id 不能是 ${ROOT}`)
      if (has(override.id)) problems.push(`id 已存在：${override.id}`)
      if (String(override.title).trim() === '') problems.push('名字不能为空')
      for (const p of override.parents) if (p !== ROOT && !has(p)) problems.push(`没有父节点：${p}`)
      /**
       * **新建枝也要过"同级不许同名"**：不然"新建枝…"能造出两个同名枝，
       * 而拖拽/复制到… 都是按标题认路的（使用者："同个父枝不允许下级有同名枝或节点"）。
       * 这里节点还没进图，所以按调用方给的父集合比——临时挂一条 parents 再查。
       */
      if (problems.length === 0) {
        const probe = { ...graph.nodes, [override.id]: { id: override.id, title: override.title, parents: [...override.parents] } }
        const clash = siblingTitleConflict(probe, override.id, String(override.title))
        if (clash !== undefined) {
          problems.push(`同一条父枝下已经有「${String(override.title).trim()}」了（${clash}）——同级不能同名`)
        }
      }
      break
    }
    case 'delete': {
      // 删根 = 整棵树没了。这条入口不该存在（改名/别的枝都能达到目的）
      if (override.id === ROOT) problems.push(`不能删除根节点 ${ROOT}`)
      else if (!has(override.id)) problems.push(`没有这个节点：${override.id}`)
      break
    }
    case 'reparent': {
      if (!has(override.id)) problems.push(`没有这个节点：${override.id}`)
      if (override.id === ROOT) problems.push(`不能改 ${ROOT} 自己的父`)
      for (const p of override.parents) {
        if (p === ROOT) continue
        if (!has(p)) problems.push(`没有父节点：${p}`)
        /**
         * **成环必须挡住**：把某个节点的父设成它的后代，树就成环了。
         * 渲染侧对环有防护（`↻ 环`、不死循环），但**多父 + 人工编辑很容易造出环**，
         * 与其让界面去解释一个畸形结构，不如在这里拒掉并说清原因。
         */
        else if (ancestorsOf(graph, p).has(override.id) || p === override.id) {
          problems.push(`会成环：${p} 在 ${override.id} 的子树里`)
        }
      }
      /**
       * **挪枝也会撞名**：把"整理工作文件"挪到另一个已经有同名子枝的父下，
       * 树上立刻出现两个同名同级——而拖拽是按标题认路的。按**新父**检查一遍。
       */
      if (problems.length === 0) {
        const title = String(graph.nodes[override.id]?.title ?? '')
        const probe: Record<string, TaskNode> = {
          ...graph.nodes,
          [override.id]: { ...graph.nodes[override.id], parents: [...override.parents] },
        }
        const clash = siblingTitleConflict(probe, override.id, title)
        if (clash !== undefined) {
          problems.push(`同一条父枝下已经有「${title.trim()}」了（${clash}）——同级不能同名`)
        }
      }
      break
    }
  }
  return problems
}

/**
 * 按顺序应用一串人工调整。**纯函数**：不改传入的 graph；
 * 被拒的调整进 `rejected`（带原因），其余照常应用。
 */
export function applyOverrides(graph: TaskGraph, overrides: TaskOverrideType[]): OverrideResult {
  let nodes: Record<string, TaskNode> = { ...graph.nodes }
  let membership: Record<string, string[]> = { ...graph.membership }
  const rejected: OverrideResult['rejected'] = []
  let applied = 0

  for (const override of overrides) {
    const problems = validateOverride({ nodes, membership }, override)
    if (problems.length > 0) {
      rejected.push({ override, reason: problems.join('；') })
      continue
    }
    switch (override.op) {
      case 'setPlacement': {
        const keep = [...new Set(override.nodes.filter((id) => nodes[id] !== undefined))]
        if (keep.length === 0) delete membership[String(override.turn)]
        else membership[String(override.turn)] = keep
        break
      }
      case 'rename': {
        nodes[override.id] = { ...nodes[override.id], title: String(override.title) }
        break
      }
      case 'merge': {
        /**
         * 合并：把 `from` 并进 `into`。
         *
         * **审查发现并本轮补齐的两处收尾**（与"删枝"同一类问题）：
         * 1. `from` 的**子枝要上提到 `into`**——否则它们仍指着已被删掉的 id，
         *    结果"树上看得见、却不计入几条线"（`treeRows` 把"父不在图里"当顶层，
         *    而 `rootSummary` 只认无父或 root 的孩子，两边口径不一致）；
         * 2. `into` 自己的父集合里若有 `from`（互为父子）也要摘掉，同理。
         */
        const into = override.into
        const from = override.from.filter((id) => id !== into && nodes[id] !== undefined)
        for (const id of from) delete nodes[id]
        const moved = new Set([into, ...from])
        for (const [turn, ids] of Object.entries(membership)) {
          if (!ids.some((id) => moved.has(id))) continue
          membership[turn] = [...new Set([...ids.filter((id) => !moved.has(id)), into])]
        }
        for (const [id, node] of Object.entries(nodes)) {
          if (!node.parents.some((p) => from.includes(p))) continue
          const stripped = node.parents.filter((p) => !from.includes(p))
          /**
           * 子枝挂到**存活的 `into`** 下（"合并"= 被并枝的工作从此算目标枝的），
           * 而不是继承被并枝的父（那是**删除**的语义——删了才让子枝上提一级）。
           * 我第一版把两者混了，断言当场抓到 `kid.parents === ['root']`。
           */
          const parents = id === into ? stripped : [...new Set([...stripped, into])]
          nodes[id] = { ...node, parents: [...new Set(parents.filter((p) => p !== id))] }
        }
        if (override.title !== undefined) nodes[into] = { ...nodes[into], title: String(override.title) }
        break
      }
      case 'reparent': {
        // 整份替换父集合（去重、去空串）；标题与 kind 一律不动——挂枝只改"挂在哪儿"
        const next = [...new Set(override.parents.filter((p) => p !== ''))]
        nodes[override.id] = { ...nodes[override.id], parents: next }
        break
      }
      case 'create': {
        nodes[override.id] = { id: override.id, title: String(override.title), parents: [...override.parents] }
        break
      }
      case 'delete': {
        /**
         * **删枝 = 删掉这个枝连同它下挂的整棵子树**（使用者 2026-10-10 纠正；
         * 判据与多父保护都在 `deleteSet` 里，界面上的后果提示用同一个函数算）。
         *
         * 两件事：
         * 1. 删除集里所有节点从 `membership` 摘掉 ⇒ 那些回合变成**独立回合**。
         *    摘成**空数组**而不是删键：空数组是"明确没有落点"，删键会让它在
         *    "属于某枝"与"未归属"两边都不显示——看起来像回合丢了。
         *    回合若**还挂在删除集之外的枝上**（多归属），就留在那边（那不是丢失，
         *    是它本来就属于别的枝）。
         * 2. 删除集之外的节点若指着删除集里的父（多父共享），摘掉那些父——
         *    留下的父保证它不再是孤儿（`deleteSet` 已保证外面至少有一个父）。
         */
        const victims = deleteSet(nodes, override.id)
        const inSet = new Set(victims)
        for (const id of victims) delete nodes[id]
        for (const [turn, ids] of Object.entries(membership)) {
          if (!ids.some((id) => inSet.has(id))) continue
          membership[turn] = ids.filter((id) => !inSet.has(id))
        }
        for (const [id, node] of Object.entries(nodes)) {
          if (!node.parents.some((p) => inSet.has(p))) continue
          nodes[id] = { ...node, parents: node.parents.filter((p) => !inSet.has(p)) }
        }
        break
      }
    }
    applied += 1
  }
  return { graph: { nodes, membership }, applied, rejected }
}

/**
 * **剪掉空叶子**：既没有回合、也没有子节点的节点，是纯噪声。
 *
 * 使用者裁定："如果某个母枝变空了，那么应该可以直接删掉吧"。
 *
 * ⚠️ **只剪空叶子，绝不碰空容器**：
 * - 空叶子（`t45 清理项目名称与文档 ← （没有回合）`，往往是流水线顺手建的）⇒ 删；
 * - 空容器（`project 个人资料整理… ← （没有回合）`，其子节点持有回合）⇒ **保留**——
 *   流水线的设计就是"父节点是纯容器，散落的回合归子节点"，这种"空"是正常的。
 *   按"没有回合就删"一刀切会把项目根与中间容器全删掉，那是破坏。
 *
 * 纯函数、幂等；不动 `membership`（空叶子本来就没有回合引用它）。
 */
export function pruneEmptyLeaves(graph: TaskGraph): { graph: TaskGraph; pruned: string[] } {
  const parented = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    for (const parent of node.parents) parented.add(parent)
  }
  const hasTurns = new Set<string>()
  for (const list of Object.values(graph.membership)) for (const id of list) hasTurns.add(id)

  const nodes: Record<string, TaskNode> = {}
  const pruned: string[] = []
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (id !== ROOT && !parented.has(id) && !hasTurns.has(id)) {
      pruned.push(id)
      continue
    }
    nodes[id] = node
  }
  return { graph: { nodes, membership: { ...graph.membership } }, pruned }
}

/**
 * **生效结构**：把人工覆盖叠上去，再剪掉空叶子——面板与判定材料都用这一份。
 *
 * 为什么要收成一个函数：**渲染与判定必须看同一份结构**。以前判定材料取的是宿主返回的
 * 原始结构，于是"人工把落点改对了，标记却还按旧结构算"——两处不一致，而且不会报错。
 *
 * 顺序有意义：**先叠覆盖、再剪枝**。反过来的话，人工刚建的空枝会在剪枝时被删掉，
 * 紧接着挂上去的回合就无处可挂（覆盖还没生效）。
 *
 * @param graph - 宿主返回的原始结构（或上一次的生效结构）。
 * @param overrides - 人工覆盖（`validateOverrides` 已校验过的那份）。
 */
export function effectiveStructure(
  graph: TaskGraph,
  overrides: readonly TaskOverrideType[],
): { graph: TaskGraph; applied: number; rejected: OverrideResult['rejected']; pruned: string[] } {
  const withOverrides = applyOverrides(graph, [...overrides])
  const prunedResult = pruneEmptyLeaves(withOverrides.graph)
  return {
    graph: prunedResult.graph,
    applied: withOverrides.applied,
    rejected: withOverrides.rejected,
    pruned: prunedResult.pruned,
  }
}
