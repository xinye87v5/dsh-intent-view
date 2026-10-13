#!/usr/bin/env node
/**
 * **话题组（划分）与任务结构（重叠归属）到底冲突到什么程度**——离线量，不调模型。
 *
 * 使用者指出："就算现在 dag 的方式，原来话题组的组合就不太对了"。这句话是结构性的：
 * 话题组是**划分**（每回合恰好一组、边界是连续区间），DAG 允许**重叠**（一个回合挂多个
 * 节点、节点可有多个父）。划分表达不了重叠，所以两者迟早对不上。
 *
 * 这个脚本把"对不上"量出来，好决定怎么改：
 *
 * 1. **节点被切碎**：一个节点的回合落在几个话题组里（理想是 1）；
 * 2. **组被切碎**：一个话题组横跨几个顶层线（理想是 1，否则"组"没有单一任务含义）；
 * 3. **重叠归属与划分的冲突**：有多个落点的回合，落在同一组里的比例。
 *
 * 用法：`node tools/probes/group-vs-dag.mjs [--state session-xxxx.json]`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
// 分组/转向语义已从产品侧删除（提交 ④），研究的冻结副本在 `./grouping.mjs`；
// 它同时转发还活着的 `bigrams` 等，所以这里只 import 这一个文件。
import { bigrams, groupTurns, LOCAL_FLOOR } from './grouping.mjs'
import { loadSessionTurns } from './session-turns.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.resolve(HERE, '.out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const only = arg('--state', '')

const files = readdirSync(OUTDIR).filter((f) => /^session-[0-9a-f]{8}\.json$/.test(f)).sort()
const targets = only === '' ? files : files.filter((f) => f.includes(only))
if (targets.length === 0) throw new Error('没有可用的状态文件（先跑 session-sweep）')

console.log('会话        回合  组  节点  节点落在多组  组横跨多线  多落点回合(同组/跨组)  组纯度')
for (const file of targets) {
  const state = JSON.parse(readFileSync(path.join(OUTDIR, file), 'utf8'))
  const short = file.replace('session-', '').replace('.json', '')
  let turns
  try {
    turns = loadSessionTurns(short).turns
  } catch {
    console.log(`${short}  （本机没有这场会话的日志，跳过）`)
    continue
  }
  const ids = turns.map((t) => t.turn)
  const termSets = turns.map((t) => bigrams(t.prompt))
  const layout = groupTurns(termSets)
  const groupOf = new Map()
  layout.forEach((group, index) => group.forEach((i) => groupOf.set(ids[i], index + 1)))

  // 顶层线：每个节点归到它所属的顶层根
  const nodes = state.nodes
  const rootOf = (id) => {
    const seen = new Set()
    let cur = id
    while (true) {
      const parents = (nodes[cur]?.parents ?? []).filter((p) => p !== 'root' && nodes[p] !== undefined)
      if (parents.length === 0) return cur
      if (seen.has(cur)) return cur
      seen.add(cur)
      cur = parents[0]
    }
  }
  const turnsOfNode = new Map()
  for (const [turn, list] of Object.entries(state.membership)) {
    for (const id of list) {
      if (nodes[id] === undefined) continue
      const set = turnsOfNode.get(id) ?? new Set()
      set.add(Number(turn))
      turnsOfNode.set(id, set)
    }
  }

  let splitNodes = 0
  let pureSum = 0
  let nodeCount = 0
  /** 节点 → 它多数回合所在的组（多落点判断要用）。 */
  const majorityOfNode = new Map()
  for (const [nodeId, set] of turnsOfNode) {
    const groups = new Set([...set].map((t) => groupOf.get(t)).filter((g) => g !== undefined))
    if (groups.size > 1) splitNodes += 1
    // 纯度：节点里回合落在"该节点最常见的那个组"的比例
    const counts = new Map()
    for (const t of set) {
      const g = groupOf.get(t)
      if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    const top = counts.size === 0 ? 0 : Math.max(...counts.values())
    pureSum += set.size === 0 ? 0 : top / set.size
    nodeCount += 1
    if (counts.size > 0) {
      majorityOfNode.set(nodeId, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0])
    }
  }
  const linesPerGroup = new Map()
  for (const [id, set] of turnsOfNode) {
    const line = rootOf(id)
    for (const g of new Set([...set].map((t) => groupOf.get(t)).filter((x) => x !== undefined))) {
      const s = linesPerGroup.get(g) ?? new Set()
      s.add(line)
      linesPerGroup.set(g, s)
    }
  }
  const groupsAcrossLines = [...linesPerGroup.values()].filter((s) => s.size > 1).length
  // **多落点与划分的正面冲突**：一个回合的两个落点若在**不同的组**里，
  // 划分（每回合恰好一组）在表达上就装不下它——这正是使用者说的"组合不太对"。
  let multiSame = 0
  let multiAcross = 0
  for (const [turnKey, list] of Object.entries(state.membership)) {
    if (list.length < 2) continue
    const groups = new Set(list.map((id) => majorityOfNode.get(id)).filter((g) => g !== undefined))
    if (groups.size > 1) multiAcross += 1
    else multiSame += 1
  }
  const pure = (pureSum / Math.max(1, nodeCount) * 100).toFixed(0)
  console.log(
    `${short} ${String(turns.length).padStart(6)} ${String(layout.length).padStart(3)} ${String(nodeCount).padStart(5)} ` +
      `${String(splitNodes).padStart(11)} ${String(groupsAcrossLines).padStart(10)} ` +
      `${String(multiSame).padStart(12)}/${String(multiAcross).padEnd(4)} ${String(pure).padStart(6)}%`,
  )
}
