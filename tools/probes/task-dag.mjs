#!/usr/bin/env node
/**
 * 任务**结构**：不是树、不是划分，而是**允许重叠归属的 DAG**。
 *
 * ## 为什么从树再退一步
 *
 * 使用者六条裁定（`research/agenda-structure-spec.md`）里有两条推翻了"树"：
 *
 * - **"几个任务下都放"** ⇒ 一个回合可以同时属于多个节点（**不是划分**）；
 * - **"零散节点"** ⇒ 插话自成一类节点，不该被丢、也不该塞进某个任务。
 *
 * 再加上"父节点是纯容器"（父不直接拥有散落回合），结构就是：
 *
 *     nodes:      {id, parents: [...], title, kind}
 *     membership: {turn, nodes: [...]}      ← 逐回合，可多值
 *
 * **区间不写死**：由 membership 现算。写死区间就会退回到"连续段"的老毛病——
 * 那是前九段一直失败的原因（拿划分去交重叠归属的卷）。
 *
 * ## 成败标准（事先写死）
 *
 * 拿**合成语料 A** 判（`research/synthetic-session-a.txt`，我预设过答案）：
 *
 * 1. `#25–26`（缓存目录权限 / 日志目录权限）要**同时**出现在「部署」与「缓存」下；
 * 2. `#21`（天气那句）要有**自己的零散节点**（`kind: "aside"`），
 *    而不是消失；
 * 3. 每个回合至少落在一个非容器节点里（不许丢回合）；
 * 4. `#22–26` 要接回「部署」（同一节点多个不连续回合）。
 *
 * 用法：`node tools/probes/task-dag.mjs --turns research/synthetic-session-a.txt`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const SYSTEM = [
  '你在把一段人与 AI 的会话整理成**任务结构**。注意：它不是一条被切开的线，',
  '也不是一棵严格的树，而是一张**允许重叠的图**。',
  '',
  '## 什么是一个节点',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务），不是话题词、不是说话的角度。',
  '- 换了对象或子任务 → 新节点（同一个大任务下的子任务也算新节点）；',
  '- 同一个东西换侧面/换动作（缓存的设计 ↔ 缓存什么时候做）→ 同一个节点；',
  '- 汇总、纠正、确认 → 留在当前节点。',
  '',
  '## 四条硬规则',
  '',
  '1. **一个回合可以同时属于多个节点。** 如果某个回合同时是两条线的内容',
  '   （例如"缓存目录的权限"既属于缓存这件事、也属于这次部署的收尾），',
  '   **就要在几个节点下都放**，不要二选一。',
  '2. **零散节点**：与任何任务都无关的插话/闲话（例如突然聊了一句天气），',
  '   要**自成一个小节点**，kind 写 "aside"。**不要丢掉它。**',
  '3. **父节点是纯容器**：父节点不直接拥有零散的回合；如果一个回合不属于',
  '   任何子节点，就**为它建一个子节点**。子节点可以挂到多个父节点下',
  '   （parents 是数组）。',
  '4. **不要为了整齐而合并节点**：宁可留细——细节点将来还能继续分支。',
  '',
  '## 输出（只回 JSON）',
  '',
  '{"nodes":[{"id":1,"parents":[0],"title":"12 字内","kind":"task"}],',
  ' "membership":[{"turn":1,"nodes":[1]}]}',
  '',
  '- parents=[] 或 [0] 表示根；一个节点可挂在多个父下；',
  '- kind 取 "task" 或 "aside"；',
  '- membership 必须覆盖**每一个**回合，一个回合可对多个节点。',
].join('\n')

const TURNS_FILE = process.argv.includes('--turns') ? process.argv[process.argv.indexOf('--turns') + 1] : null
let turns = []
if (TURNS_FILE !== null) {
  const { readFileSync } = await import('node:fs')
  turns = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^#\d+\s*/, '') }))
} else {
  for (const candidate of collectSessions()) {
    let usable
    try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
    if (usable.turns.length < 20) continue
    turns = usable.turns.map((t) => ({ turn: t.turn, prompt: t.prompt }))
    break
  }
}
if (turns.length === 0) { console.error('✗ 没有回合'); process.exit(2) }

const lines = turns.map((t) => `#${t.turn} ${t.prompt.trim().replace(/\s+/g, ' ').slice(0, 80)}`)
console.log(`回合 ${turns.length} 个${TURNS_FILE ? `（合成语料 ${TURNS_FILE}）` : ''}\n`)
const raw = await complete(SYSTEM, lines.join('\n'), { json: true, maxTokens: 3000, temperature: 0 })
let parsed = {}
try { parsed = JSON.parse(raw) } catch { console.error('✗ 解析失败：', raw.slice(0, 300)); process.exit(1) }

const nodes = (parsed.nodes ?? []).map((n) => ({
  id: Number(n.id), parents: (Array.isArray(n.parents) ? n.parents : [0]).map(Number),
  title: String(n.title ?? ''), kind: String(n.kind ?? 'task'),
})).filter((n) => Number.isInteger(n.id))
const byId = new Map(nodes.map((n) => [n.id, n]))
const membership = new Map()
for (const m of parsed.membership ?? []) {
  const turn = Number(m.turn)
  const ids = (Array.isArray(m.nodes) ? m.nodes : []).map(Number).filter((id) => byId.has(id))
  if (Number.isInteger(turn) && ids.length > 0) membership.set(turn, ids)
}

// ── 渲染：树形（一个节点挂多处就重复出现，标 “↺”） ─────────────────────────
const childrenOf = new Map()
for (const node of nodes) for (const parent of node.parents) {
  if (!childrenOf.has(parent)) childrenOf.set(parent, [])
  childrenOf.get(parent).push(node)
}
const turnsOf = (id) => [...membership].filter(([, ids]) => ids.includes(id)).map(([turn]) => turn)
const spanOf = (id) => {
  const list = turnsOf(id)
  if (list.length === 0) return '—'
  const spans = []
  let start = list[0], prev = list[0]
  for (const turn of list.slice(1)) {
    if (turn === prev + 1) { prev = turn; continue }
    spans.push(start === prev ? `#${start}` : `#${start}–${prev}`)
    start = turn; prev = turn
  }
  spans.push(start === prev ? `#${start}` : `#${start}–${prev}`)
  return spans.join(' , ')
}
const roots = nodes.filter((n) => n.parents.some((p) => p === 0 || !byId.has(p)))
console.log('=== 任务结构（DAG）===')
const seen = new Set()
const render = (node, depth) => {
  const mark = seen.has(node.id) ? ' ↺' : ''
  seen.add(node.id)
  console.log(`${'  '.repeat(depth)}${depth === 0 ? '●' : '└'} ${spanOf(node.id).padEnd(24)} ${node.title}${node.kind === 'aside' ? '   [零散]' : ''}${mark}`)
  for (const child of (childrenOf.get(node.id) ?? []).sort((a, b) => (turnsOf(a.id)[0] ?? 0) - (turnsOf(b.id)[0] ?? 0))) render(child, depth + 1)
}
for (const root of roots.sort((a, b) => (turnsOf(a.id)[0] ?? 0) - (turnsOf(b.id)[0] ?? 0))) render(root, 0)

const multi = [...membership].filter(([, ids]) => ids.length > 1)
console.log(`\n多归属的回合（${multi.length} 个）：`)
for (const [turn, ids] of multi.sort((a, b) => a[0] - b[0])) {
  console.log(`   #${turn} → ${ids.map((id) => byId.get(id).title).join(' + ')}`)
}
const covered = new Set([...membership.keys()])
const missing = turns.map((t) => t.turn).filter((turn) => !covered.has(turn))
console.log(`\n覆盖：${covered.size}/${turns.length}${missing.length > 0 ? ` · **没覆盖的回合** ${missing.slice(0, 12).join(',')}` : ' ✓'}`)
const asides = nodes.filter((n) => n.kind === 'aside')
console.log(`零散节点：${asides.length}${asides.length > 0 ? `（${asides.map((n) => n.title).join(' / ')}）` : ''}`)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
