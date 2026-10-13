#!/usr/bin/env node
/**
 * 第二趟：**增量更新**现有结构——并顺便再试一次**多归属**。
 *
 * ## 使用者新增的要求
 *
 * > "会话的时候应该是**逐渐增加节点**的，要适配"
 *
 * 会话是活的：不能等它结束再算一次结构，只能**在已有结构上长**。
 * 这同时决定了成本形状——每轮重算整场会越来越贵，而增量只处理**新回合**。
 *
 * ## 两趟流程
 *
 * 1. 第一趟（已在 `task-dag.mjs`）：对前 `--cut` 个回合出结构；
 * 2. 第二趟（本脚本）：把结构 + 新回合给模型，只要**增量**：
 *    - `newNodes`：新节点；
 *    - `memberships`：新增或变更的归属（**出现即覆盖**旧归属，用于多归属）；
 *    - `reparent`：已有节点改挂（例如挂到多个父下）。
 *
 * ## 事先写死的四条标准（拿合成语料 A 判）
 *
 * 1. `#21`（天气）→ 新增**零散节点**；
 * 2. `#25–26`（缓存/日志目录权限）→ **多归属**：同时挂到部署与缓存两条线；
 * 3. **已有结构不许重排**：第一趟节点的 id / 标题 / 父子关系保持不变；
 * 4. 新回合**全覆盖**（#21–32 一个不落）。
 *
 * 用法：`node tools/probes/task-dag-incremental.mjs --turns research/synthetic-session-a.txt --cut 20`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const PASS1 = [
  '你在把一段人与 AI 的会话整理成**任务结构**（允许重叠的图，不是划分）。',
  '判据是"正在弄的那个东西"（对象/子任务）：换了对象/子任务 → 新节点；',
  '同一个东西换侧面/换动作 → 同一节点；汇总/纠正/确认 → 留在当前节点。',
  '父节点是纯容器：父不直接拥有散落回合，那些回合各自成子节点。',
  '与任何任务都无关的插话 → 自成一个小节点，kind 写 "aside"。',
  '只回 JSON：{"nodes":[{"id":1,"parents":[0],"title":"12 字内","kind":"task"}],',
  ' "membership":[{"turn":1,"nodes":[1]}]}',
  'parent=0 表示根；membership 必须覆盖每一个回合。',
].join('\n')

const PASS2 = [
  '这是一段会话**已有的任务结构**（JSON），以及**新增加的回合**。',
  '请只输出**增量**，不要重排已有结构。',
  '',
  '## 五条规则（按人工标记修正过，请严格照做）',
  '',
  '1. **同一步工作的前后半段要合成一个节点。** 例如"sudo 为什么写两次"与',
  '   "改成一次并验证"是**同一步**的两半 —— 它们该是**同一个节点**（如 sudo 处理），',
  '   **不要拆成两个并列的兄弟**。（拆开是上一版最大的错。）',
  '2. **单纯的评价、确认、承接不产生节点，也不产生归属。** "跑通了就好"、',
  '   "明白了"、"可以"这类句子自己不是工作内容 —— 它们**不该挂到任何节点上**，',
  '   也不该拉上前面某个旧节点。**只有真正推进工作的那半句算。**',
  '3. **一个回合里若真有两件事，两件都要有落点**（例如同一句里既确认了覆盖率、',
  '   又闲聊了一句天气 → 分别落在"覆盖率"与一个零散节点）。',
  '4. **同一条线的父与子同时命中是允许的**，不必刻意避免。',
  '5. 只推进一件事的回合就**单一归属** —— 不要为了"信息完整"而多挂。',
  '',
  '## 其它',
  '',
  '- 新回合若仍在做原来那件事，接到已有节点下；换了对象/子任务则建新节点；',
  '- 与任务无关的插话 → 新建 kind="aside" 的小节点；',
  '- 只有已有节点确实该改挂时才用 reparent。',
  '',
  '只回 JSON：',
  '{"newNodes":[{"id":"n1","parents":[1],"title":"12 字内","kind":"task"}],',
  ' "memberships":[{"turn":21,"nodes":[1,"n1"]}],',
  ' "reparent":[{"id":3,"parents":[2,4]}]}',
  '',
  '- newNodes 的 id 用字符串（如 "n1"），不要占用已有数字 id；',
  '- memberships 里出现的回合会**覆盖**它原来的归属；',
  '- 只需覆盖**新增加的回合**；空数组可以省略。',
].join('\n')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const TURNS_FILE = arg('--turns', path.join(HERE, '..', '..', 'research', 'synthetic-session-a.txt'))
const CUT = Number(arg('--cut', 20))

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^#\d+\s*/, '') }))
const oldTurns = all.slice(0, CUT)
const newTurns = all.slice(CUT)
const render = (list) => list.map((t) => `#${t.turn} ${t.prompt.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')

console.log(`合成语料 ${path.basename(TURNS_FILE)} · 已有 ${oldTurns.length} 回合 · 新增 ${newTurns.length} 回合\n`)
const raw1 = await complete(PASS1, render(oldTurns), { json: true, maxTokens: 2000, temperature: 0 })
const pass1 = JSON.parse(raw1)
console.log(`第一趟：${pass1.nodes.length} 个节点`)

const raw2 = await complete(
  PASS2,
  `已有结构：\n${JSON.stringify(pass1)}\n\n新增加的回合：\n${render(newTurns)}`,
  { json: true, maxTokens: 3000, temperature: 0 },
)
/**
 * **容错解析**：模型有时把字符串 id 写成裸标识符（`"nodes":[n6]`），
 * 那不是合法 JSON。修一下再解析——但**要说出来**，因为这本身是个发现：
 * 它的输出不是严格 JSON（同一族问题在别处也见过：围栏、夹话）。
 */
const looseJson = (text) => {
  try { return { value: JSON.parse(text), repaired: false } } catch { /* 继续修 */ }
  const repaired = text.replace(/([[,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,\]}])/g, '$1"$2"')
  return { value: JSON.parse(repaired), repaired: repaired !== text }
}

let delta = {}
try {
  const result = looseJson(raw2)
  delta = result.value
  if (result.repaired === true) console.log('（模型输出不是严格 JSON：裸标识符已补引号）')
} catch {
  // **截断要看得出来**：第一版只打了前 300 字，看起来像"模型输出乱"，
  // 其实是 `maxTokens` 不够、JSON 从中间断了。打**尾部**才看得出是截断。
  console.error(`✗ 增量解析失败（长度 ${raw2.length}）`)
  console.error('  头部：', raw2.slice(0, 160))
  console.error('  尾部：', raw2.slice(-160))
  process.exit(1)
}

// ── 合并 ────────────────────────────────────────────────────────────────────
const nodes = new Map(pass1.nodes.map((n) => [n.id, { id: n.id, parents: n.parents ?? [0], title: n.title, kind: n.kind ?? 'task', fresh: false }]))
for (const n of delta.newNodes ?? []) {
  nodes.set(String(n.id), { id: String(n.id), parents: (n.parents ?? [0]).map((p) => (typeof p === 'string' ? p : Number(p))), title: String(n.title ?? ''), kind: String(n.kind ?? 'task'), fresh: true })
}
for (const r of delta.reparent ?? []) {
  const node = nodes.get(r.id) ?? nodes.get(Number(r.id))
  if (node !== undefined) node.parents = (r.parents ?? node.parents).map((p) => (typeof p === 'string' ? p : Number(p)))
}
const membership = new Map()
for (const m of pass1.membership ?? []) membership.set(Number(m.turn), (m.nodes ?? []).map((x) => (typeof x === 'string' ? x : Number(x))).filter((x) => nodes.has(x)))
const changed = new Set()
for (const m of delta.memberships ?? []) {
  const turn = Number(m.turn)
  const ids = (m.nodes ?? []).map((x) => (typeof x === 'string' ? x : Number(x))).filter((x) => nodes.has(x))
  if (Number.isInteger(turn) && ids.length > 0) { membership.set(turn, ids); changed.add(turn) }
}

const newIds = new Set((delta.newNodes ?? []).map((n) => String(n.id)))
const turnsOf = (id) => [...membership].filter(([, ids]) => ids.map(String).includes(String(id))).map(([t]) => t)
const childrenOf = new Map()
for (const node of nodes.values()) for (const parent of node.parents) {
  if (!childrenOf.has(parent)) childrenOf.set(parent, [])
  childrenOf.get(parent).push(node)
}
const spanOf = (id) => {
  const list = turnsOf(id).sort((a, b) => a - b)
  if (list.length === 0) return '—'
  const out = []
  let start = list[0], prev = list[0]
  for (const turn of list.slice(1)) {
    if (turn === prev + 1) { prev = turn; continue }
    out.push(start === prev ? `#${start}` : `#${start}–${prev}`); start = turn; prev = turn
  }
  out.push(start === prev ? `#${start}` : `#${start}–${prev}`)
  return out.join(' , ')
}
console.log('\n=== 合并后的结构（★ = 增量新增，↺ = 挂在多处） ===')
const seen = new Set()
const renderNode = (node, depth) => {
  const multi = node.parents.length > 1 ? ' ↺' : ''
  const mark = seen.has(node.id) ? ' ↩' : ''
  seen.add(node.id)
  console.log(`${'  '.repeat(depth)}${depth === 0 ? '●' : '└'} ${spanOf(node.id).padEnd(24)} ${newIds.has(String(node.id)) ? '★ ' : ''}${node.title}${node.kind === 'aside' ? '   [零散]' : ''}${multi}${mark}`)
  for (const child of (childrenOf.get(node.id) ?? []).sort((a, b) => (turnsOf(a.id)[0] ?? 0) - (turnsOf(b.id)[0] ?? 0))) renderNode(child, depth + 1)
}
const roots = [...nodes.values()].filter((n) => n.parents.some((p) => p === 0 || !nodes.has(p)))
for (const root of roots.sort((a, b) => (turnsOf(a.id)[0] ?? 0) - (turnsOf(b.id)[0] ?? 0))) renderNode(root, 0)

// **度量修正**：上一版把"父与子同时命中"也算多归属——那是**结构本身**，
// 不是多归属。真正要数的是**交叉线**：两个节点互不为祖先/后代。
const ancestorsOf = (id) => {
  const out = new Set()
  const walk = (current) => {
    for (const parent of nodes.get(current)?.parents ?? []) {
      const key = typeof parent === 'string' ? parent : Number(parent)
      if (nodes.has(key) && !out.has(key)) { out.add(key); walk(key) }
    }
  }
  walk(id)
  return out
}
const isRelated = (a, b) => ancestorsOf(a).has(b) || ancestorsOf(b).has(a)
const multiTurns = [...membership].filter(([, ids]) => ids.length > 1)
const crossTurns = multiTurns.filter(([, ids]) => {
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
    if (!isRelated(ids[i], ids[j])) return true
  }
  return false
})
console.log(`\n多归属（原始 ${multiTurns.length} 个 · **交叉线 ${crossTurns.length} 个**）：`)
for (const [turn, ids] of multiTurns.sort((a, b) => a[0] - b[0])) {
  const cross = crossTurns.some(([t]) => t === turn)
  console.log(`   ${cross ? '✓交叉' : '  同级'} #${turn} → ${ids.map((id) => nodes.get(id).title).join(' + ')}`)
}
const covered = new Set([...membership.keys()])
const missingNew = newTurns.map((t) => t.turn).filter((turn) => !covered.has(turn))
const asidesNew = [...newIds].map((id) => nodes.get(id)).filter((n) => n.kind === 'aside')

console.log('\n=== 四条标准 ===')
console.log(`  1. #21 有零散节点            ${asidesNew.some((n) => n.title.includes('雨') || n.title.includes('闲')) ? '✓' : (asidesNew.length > 0 ? '~（有零散节点，标题不是天气）' : '✗')}  ${asidesNew.map((n) => n.title).join('/')}`)
// **标准换成人工标记推出的四条。** 上一版的"交叉线多归属"是**我自己的假设**，
// 八个标记里没有一条支持它——它还会**误杀**使用者判对的那四条（父与子双命中）。
const nodesOf = (turn) => (membership.get(turn) ?? []).map((id) => nodes.get(id)).filter(Boolean)
const titleOf = (turn) => nodesOf(turn).map((n) => n.title).join(' + ') || '（无）'

// 标准 1：#23/#24 落在**一个** sudo 节点下（不是两个兄弟）
const sudoNodes = [...nodes.values()].filter((n) => /sudo/i.test(n.title))
const sudoOk =
  sudoNodes.length === 1 &&
  [23, 24].every((turn) => nodesOf(turn).some((n) => n.id === sudoNodes[0].id))
console.log(
  `  1. #23/#24 落在**一个** sudo 节点下  ${sudoOk ? '✓' : '✗'}  ` +
    `sudo 节点 ${sudoNodes.length} 个（${sudoNodes.map((n) => n.title).join(' / ') || '无'}）` +
    `  #23=${titleOf(23)}  #24=${titleOf(24)}`,
)

// 标准 2：#25 **只**挂在缓存目录权限（不挂到"缓存选型"这类旧节点）
const perm = nodesOf(25).filter((n) => /权限/.test(n.title))
const stray25 = nodesOf(25).filter((n) => !/权限/.test(n.title))
console.log(
  `  2. #25 只挂缓存目录权限          ${perm.length > 0 && stray25.length === 0 ? '✓' : '✗'}  ` +
    `#25=${titleOf(25)}${stray25.length > 0 ? `  ← 多挂到：${stray25.map((n) => n.title).join('/')}` : ''}`,
)

// 标准 3：父与子双命中**保留**（使用者判对的四条，不许被我的旧标准误杀）
const pairOk = [22, 26, 27, 28].filter((turn) => nodesOf(turn).length >= 2)
console.log(
  `  3. 父子双命中保留（22/26/27/28） ${pairOk.length === 4 ? '✓' : `~（${pairOk.length}/4）`}  ` +
    pairOk.map((turn) => `#${turn}`).join(' '),
)

// 标准 4：#21 保持两处落点（确认 + 零散）
const multi21 = nodesOf(21).length >= 2
console.log(`  4. #21 两处落点                  ${multi21 ? '✓' : '✗'}  #21=${titleOf(21)}`)

console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
