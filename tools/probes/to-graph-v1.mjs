#!/usr/bin/env node
/**
 * 把任务结构状态转成 **`graph-v1`**（`~/graph-view` 那套协议），交给它的渲染器出图。
 *
 * 为什么用它：自己手写的 HTML 只能给我自己看形状，而 `graphview.py render`
 * 有真正的布局（layered/banded）、能出 SVG，还是这个工作区里现成的工具。
 *
 * 图里有两类节点：
 *
 * - **任务节点**（`kind: task|aside`）：就是结构里的那些节点，标签是标题；
 * - **回合节点**（`kind: turn`）：每个回合一个，标签是 `#N 正文`。
 *
 * 边：父子用 `contains`；回合到落点用 `advances`。
 * 于是"闭包"在这张图上就是**回合节点多出几条 `advances` 边**——
 * 原样一两条，闭包后到根的整条链都在。
 *
 * ⚠️ 注意同名不同义：`graph-v1` 里 `closure` 是**边的属性**
 * （`closed/open/pending`，表示伏笔是否收束），跟这里说的"祖先闭包"无关。
 *
 * 用法：
 *   node tools/probes/to-graph-v1.mjs --run travel-run3                 → graph-v1 JSON
 *   node tools/probes/to-graph-v1.mjs --run travel-run3 --closure
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { closeUnderAncestors, mostSpecific, treeRows } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const RUN = arg('--run', 'travel-run3')
const TURNS_FILE = arg('--turns', path.resolve(ROOT, 'research', 'synthetic-travel.txt'))
const CLOSURE = process.argv.includes('--closure')
const SPECIFIC = process.argv.includes('--specific')

const turns = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

const state0 = JSON.parse(readFileSync(path.resolve(HERE, '.out', `${RUN}.json`), 'utf8'))
const state = CLOSURE ? closeUnderAncestors(state0) : SPECIFIC ? mostSpecific(state0) : state0
const used = new Set(Object.values(state.membership).flat())

const nodes = []
const edges = []
for (const [id, node] of Object.entries(state.nodes)) {
  nodes.push({
    id,
    label: node.title,
    kind: node.kind === 'aside' ? 'aside' : 'task',
    detail: (state.membership !== undefined
      ? turns.filter((t) => (state.membership[String(t.turn)] ?? []).includes(id)).map((t) => `#${t.turn}`).join(' ')
      : ''),
    severity: used.has(id) ? 'none' : 'warn',
    provenance: 'derived',
    observed: true,
  })
}
for (const [id, node] of Object.entries(state.nodes)) {
  for (const parent of node.parents) {
    if (parent === 'root' || state.nodes[parent] === undefined) continue
    edges.push({ from: parent, to: id, relation: 'contains', closure: 'n/a', provenance: 'derived', severity: 'none' })
  }
}
const raw = mostSpecific(state0).membership
for (const t of turns) {
  const ids = state.membership[String(t.turn)] ?? []
  if (ids.length === 0) continue
  nodes.push({
    id: `turn${t.turn}`,
    label: `#${t.turn} ${t.prompt.slice(0, 22)}`,
    kind: 'turn',
    detail: t.prompt,
    severity: 'none',
    provenance: 'derived',
    observed: true,
  })
  // 只有"闭包那一版"才把补出来的边记成 inferred（虚线）；
  // 原样那一版所有边都是模型给的，一律 derived（实线）。
  const before = CLOSURE ? new Set(raw[String(t.turn)] ?? []) : new Set(ids)
  for (const id of ids) {
    // 渲染器把 `derived` 画实线、`inferred` 画虚线
    // （`kernel/graph_render.py`: "An inferred edge is drawn dashed and muted"）。
    // 于是：**模型给的落点 = 实线，闭包补出来的祖先边 = 虚线**。
    edges.push({
      from: `turn${t.turn}`,
      to: id,
      relation: before.has(id) ? 'advances' : 'advances-via-ancestor',
      closure: 'n/a',
      provenance: before.has(id) ? 'derived' : 'inferred',
      severity: 'none',
    })
  }
}

/**
 * 排布：**左列放回合**（按时间顺序），右边各列按层级深度放任务节点。
 *
 * 不交给渲染器自己排——它的默认行为是"没有规格就按给定顺序叠成一列"
 * （`_place_axis(wrap=1)`），41 个节点会变成 296×7061 的一根柱子。
 * 这里只给 `columns`/`rows` 两张索引表（不写像素），像素交给它。
 */
const depthOf = (id, seen = new Set()) => {
  const node = state.nodes[id]
  if (node === undefined || seen.has(id)) return 0
  const parents = node.parents.filter((p) => p !== 'root' && state.nodes[p] !== undefined)
  if (parents.length === 0) return 1
  return 1 + Math.max(...parents.map((p) => depthOf(p, new Set([...seen, id]))))
}
const columns = {}
const rows = {}
for (const t of turns) {
  if ((state.membership[String(t.turn)] ?? []).length === 0) continue
  columns[`turn${t.turn}`] = 0
  rows[`turn${t.turn}`] = t.turn
}
const order = []
const visit = (id) => {
  order.push(id)
  for (const child of Object.keys(state.nodes).filter((c) => state.nodes[c].parents.includes(id))) visit(child)
}
for (const id of Object.keys(state.nodes)) {
  if (state.nodes[id].parents.includes('root')) visit(id)
}
for (const id of Object.keys(state.nodes)) if (!order.includes(id)) order.push(id)
order.forEach((id, i) => {
  columns[id] = 1 + depthOf(id)
  rows[id] = i
})

const graph = {
  $protocol: 'graph-v1',
  $version: '0.1.0',
  $producer: `dsh-intent-view/tools/probes/to-graph-v1.mjs (${RUN}${CLOSURE ? ' · 闭包后' : SPECIFIC ? ' · 只留最具体' : ' · 原样'})`,
  title: `${CLOSURE ? '闭包后' : SPECIFIC ? '只留最具体落点' : '原样'}：${RUN}`,
  summary: `${Object.keys(state.nodes).length} 个任务节点 · ${turns.length} 个回合 · ` +
    (CLOSURE ? '每个落点都带上了它的全部祖先' : SPECIFIC ? '每个回合只留最具体的落点' : '模型原样给的落点'),
  nodes,
  edges,
  layout: { kind: 'layered', columns, rows },
}
process.stdout.write(JSON.stringify(graph, null, 1))
