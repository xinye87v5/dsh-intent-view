#!/usr/bin/env node
/**
 * **多场真实会话扫描**：导出 → 跑流水线 → 存状态 + 汇总一行。
 *
 * 为什么要这个 harness：合成语料只有两套（32 回合），而真实会话的形态差很多
 * （45 / 82 / 139 / 213 / 377 回合；单线 vs 平铺；有没有真 DAG 分支）。
 * 要"基于更多实测会话改进"，就得先有一张能横着比的表。
 *
 * 用法：
 * ```bash
 * node tools/probes/session-sweep.mjs --list                      # 列会话
 * node tools/probes/session-sweep.mjs --ids 302cfe26,afd7a9b6     # 跑指定的几场
 * node tools/probes/session-sweep.mjs --ids 302cfe26 --max-turns 60
 * ```
 *
 * 每场产出：
 * - `tools/probes/.out/session-<id>.json`     最终状态（可离线复算）
 * - `tools/probes/.out/session-sweep.jsonl`   一行一场的汇总（追加写）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'
import { runPipeline } from './run-pipeline.mjs'
import { attachmentShape, rootSummary } from './pipeline.mjs'
import { listSessions, loadSessionTurns } from './session-turns.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.resolve(HERE, '.out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }

if (process.argv.includes('--list')) {
  const rows = listSessions()
  console.log(`会话 ${rows.length} 场（≥1 回合）：`)
  for (const r of rows) console.log(`  ${r.id.slice(0, 22)} ${String(r.count).padStart(4)} 回合 · ${r.first}`)
  process.exit(0)
}

const IDS = arg('--ids', '').split(',').map((x) => x.trim()).filter((x) => x !== '')
if (IDS.length === 0) throw new Error('给 --ids（逗号分隔），或先 --list 看看有哪些')
const CHUNK = Number(arg('--chunk', 12))
const FIRST = Number(arg('--first', 20))
const MAX_TURNS = Number(arg('--max-turns', 0))
const ADJ_ROUNDS = Number(arg('--adjudication-rounds', 1))

mkdirSync(OUTDIR, { recursive: true })
const summaryPath = path.resolve(OUTDIR, 'session-sweep.jsonl')
const rows = []

for (const id of IDS) {
  const { id: fullId, turns, total } = loadSessionTurns(id, { maxTurns: MAX_TURNS })
  console.log(`\n===== ${fullId}（${total} 回合${turns.length < total ? `，本次取前 ${turns.length}` : ''}）=====`)
  const result = await runPipeline({
    turns,
    complete,
    firstWindow: FIRST,
    chunk: CHUNK,
    adjudicationRounds: ADJ_ROUNDS,
    log: (line) => console.log('  ' + line),
  })
  const state = result.state
  const shape = attachmentShape(state, turns.length)
  const roots = rootSummary(state, turns)
  const row = {
    tag: arg('--tag', ''),
    at: new Date().toISOString().slice(0, 16),
    id: fullId,
    turns: turns.length,
    ofTotal: total,
    nodes: Object.keys(state.nodes).length,
    rootsBefore: result.adjudication.asked ? result.adjudication.groups.reduce((s, g) => s + g.roots, 0) : roots.projects.length,
    groups: result.adjudication.groups.map((g) => `${g.name}(${g.roots})`),
    merged: result.adjudication.merged.map((m) => `${m.title}(${m.count})`),
    adjudicationRounds: result.adjudication.rounds,
    rootsAfter: roots.projects.length,
    single: shape.single,
    chain: shape.chain,
    branch: shape.branch,
    uncovered: result.uncovered,
    coverage: result.coverage,
    covered: turns.length - result.uncovered.length,
    droppedRefs: result.droppedRefs.length,
    unknownOps: result.unknownOps.length,
    foldedAway: result.foldedAway,
    calls: result.calls,
  }
  rows.push(row)
  // ⚠️ 文件名要用**去掉 `session-` 前缀后的前 8 位**：我第一次写的是 fullId.slice(0,8)，
  // 它是字符串 "session-"，五场于是全覆写到同一个文件、只剩最后一场（我踩过）。
  const shortId = fullId.replace(/^session-/, '').slice(0, 8)
  writeFileSync(path.resolve(OUTDIR, `session-${shortId}.json`), JSON.stringify(state, null, 1))
  appendFileSync(summaryPath, JSON.stringify(row) + '\n')
  console.log(`  根：${row.rootsBefore} → ${row.rootsAfter} · 节点 ${row.nodes} · 覆盖 ${row.covered}/${row.turns} · 异支 ${row.branch} · 丢弃引用 ${row.droppedRefs}`)
  console.log(`  覆盖细节：初缺 ${result.coverage.missing}（承接语 ${result.coverage.continuations}）· 补问 ${result.coverage.reasked} · 继承 ${result.coverage.inherited} · 仍缺 ${result.coverage.stillMissing}`)
}

console.log('\n===== 横向对比 =====')
console.log('会话        回合  节点  根(前→后)  覆盖   单落点  异支  分组')
for (const r of rows) {
  console.log(`${r.id.slice(8, 16)} ${String(r.turns).padStart(5)} ${String(r.nodes).padStart(5)}  ` +
    `${String(r.rootsBefore).padStart(2)} → ${String(r.rootsAfter).padStart(2)}   ` +
    `${String(r.covered).padStart(3)}/${String(r.turns).padEnd(3)} ${String(r.single).padStart(6)} ${String(r.branch).padStart(5)}  ` +
    (r.groups.length === 0 ? '（未问）' : r.groups.join(' ｜ ')))
}
console.log(`\n汇总逐行已追加到 ${path.relative(process.cwd(), summaryPath)}`)
console.log(`用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
