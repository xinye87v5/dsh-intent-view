#!/usr/bin/env node
/**
 * **离线分析多场扫描结果**（不调模型）：`tools/probes/.out/session-*.json` + `session-sweep.jsonl`。
 *
 * 目的不是再报一遍数，而是**把反复出现的失败模式挑出来**，好决定下一处优化。
 * 现在盯这几类：
 *
 * | 模式 | 判据 | 为什么算问题 |
 * |---|---|---|
 * | 组名是"动作"不是"事情" | 名字含 分组/节点/会话/任务/整理 等 | `会话节点分组` 这种名字对使用者没信息 |
 * | 平铺没被并 | 裁定后仍有 ≥5 条单根线 | 栏目被当成根 |
 * | 覆盖缺口 | 有回合没有归属 | 面板上会"丢行" |
 * | 真 DAG 分支 | 某节点有 ≥2 个父 | 使用者最早的"几个任务下都放"就是这种形状，一直没实测到 |
 * | 层级过深/过浅 | 最大深度 | 面板的可读性 |
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { ancestorsOf, attachmentShape, rootSummary } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.resolve(HERE, '.out')
const META_NAME = /分组|节点|会话|任务整理|整理|清单|杂项/

const jsonl = path.resolve(OUTDIR, 'session-sweep.jsonl')
if (!existsSync(jsonl)) throw new Error('没有扫描汇总——先跑 session-sweep.mjs')
const rows = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
const files = readdirSync(OUTDIR).filter((f) => /^session-[0-9a-f]{8}\.json$/.test(f)).sort()
const states = new Map(files.map((f) => [f.replace('session-', '').replace('.json', ''), JSON.parse(readFileSync(path.join(OUTDIR, f), 'utf8'))]))

console.log('会话        回合   节点  根(前→后)  覆盖    单落点  异支  丢弃  分组名')
for (const r of rows) {
  const id = r.id.replace(/^session-/, '').slice(0, 8)
  console.log(`${id} ${String(r.turns).padStart(6)} ${String(r.nodes).padStart(6)}  ` +
    `${String(r.rootsBefore).padStart(2)} → ${String(r.rootsAfter).padStart(2)}   ` +
    `${String(r.covered).padStart(3)}/${String(r.turns).padEnd(4)} ${String(r.single).padStart(6)} ${String(r.branch).padStart(5)} ${String(r.droppedRefs).padStart(5)}  ` +
    (r.groups.length === 0 ? '（未问）' : r.groups.join(' ｜ ')))
}
console.log('\n=== 失败模式 ===')
for (const r of rows) {
  const flags = []
  const uncovered = r.uncovered.length
  if (uncovered > 0) flags.push(`缺归属 ${uncovered} 回合（${uncovered / r.turns * 100 > 10 ? '超过一成' : '少量'}）`)
  if (r.droppedRefs > 0) flags.push(`丢弃了 ${r.droppedRefs} 个不存在的节点引用`)
  if (r.rootsAfter >= 5) flags.push(`裁定后仍有 ${r.rootsAfter} 条单根线`)
  const meta = r.groups.filter((g) => META_NAME.test(g))
  if (meta.length > 0) flags.push(`组名是"动作"：${meta.join('、')}`)
  if (r.groups.length === 0 && r.rootsBefore >= 2) flags.push('该问裁定但没问/没答出分组')
  console.log(`${r.id.replace(/^session-/, '').slice(0, 8)}  ${flags.length === 0 ? '—' : flags.join('；')}`)
}
console.log('\n（旧的逐节点部分已删：它依赖状态文件，而第一次扫描的文件名写坏了。文件名已修。）')
process.exit(0)

const depthOf = (nodes, id, seen = new Set()) => {
  if (seen.has(id) || nodes[id] === undefined) return 0
  const parents = nodes[id].parents.filter((p) => p !== 'root' && nodes[p] !== undefined)
  if (parents.length === 0) return 1
  return 1 + Math.max(...parents.map((p) => depthOf(nodes, p, new Set([...seen, id]))))
}

console.log('会话      回合  节点  顶层  最大深度  多父节点  覆盖   异支  问题')
const problems = []
for (const f of files) {
  const state = JSON.parse(readFileSync(path.join(OUTDIR, f), 'utf8'))
  const id = f.replace('session-', '').replace('.json', '')
  const turns = Object.keys(state.membership).map(Number)
  const total = Math.max(...turns, 0)
  const shape = attachmentShape(state, total)
  const roots = rootSummary(state, turns.map((t) => ({ turn: t })))
  const maxDepth = Math.max(...Object.keys(state.nodes).map((x) => depthOf(state.nodes, x)))
  const multiParent = Object.entries(state.nodes).filter(([, n]) => n.parents.filter((p) => p !== 'root').length > 1)
  const uncovered = []
  for (let t = 1; t <= total; t += 1) if (!(state.membership[String(t)] ?? []).length) uncovered.push(t)
  const badNames = roots.lines.filter((l) => META_NAME.test(l.title)).map((l) => l.title)
  const flat = roots.projects.length >= 5
  const flags = []
  if (badNames.length > 0) flags.push(`组名是动作：${badNames.join('、')}`)
  if (flat) flags.push(`仍平铺 ${roots.projects.length} 条`)
  if (uncovered.length > 0) flags.push(`缺归属 ${uncovered.length} 回合`)
  if (multiParent.length > 0) flags.push(`真 DAG 分支 ${multiParent.length} 处`)
  console.log(`${id} ${String(total).padStart(6)} ${String(Object.keys(state.nodes).length).padStart(5)} ` +
    `${String(roots.projects.length).padStart(4)} ${String(maxDepth).padStart(8)} ${String(multiParent.length).padStart(8)} ` +
    `${String(total - uncovered.length).padStart(4)}/${String(total).padEnd(4)} ${String(shape.branch).padStart(5)}  ${flags.length === 0 ? '—' : flags.join('；')}`)
  if (flags.length > 0) problems.push({ id, flags, titles: roots.lines.map((l) => `${l.title}(${l.turnCount})`) })
}

console.log('\n=== 逐场的根（看名字与规模）===')
for (const p of problems) {
  console.log(`\n${p.id}：`)
  for (const t of p.titles) console.log('  - ' + t)
}
console.log(`\n共 ${files.length} 场，其中 ${problems.length} 场有可改进项`)
