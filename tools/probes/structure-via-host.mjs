#!/usr/bin/env node
/**
 * **走真正发出去的那条路**跑一次任务结构：把材料打给宿主路由 `/api/intent.structure`。
 *
 * ## 为什么需要这个探针（而不是用 `pipeline.mjs`）
 *
 * `pipeline.mjs` / `run-pipeline.mjs` 用的是**它们自己的**提示词与解析，能证明
 * "这套三段/四段流水线有区分力"，**不能证明插件里跑的那条路也对**。
 * 本项目吃过"研究里验证过的 ≠ 插件里跑着的"的亏（见 `research/` 里那几次复查），
 * 所以插件侧的每一处材料来源变化，都要在这条真路上复跑一遍。
 *
 * ## 这次专门盯的那一处变化
 *
 * 弃组之后面板送的材料换了来源：以前是官方 `turnOutline` 的短截断，
 * 现在是**宿主折叠那份**（`intent.turns[].prompt`，`stateVersion` 8 起）。
 * 也就是"第 N 回合：<用户到底说了什么>"从几十字变成了最多 400 字。
 * 这个变化会让批处理的提示词变长，**必须实测**而不是推测。
 *
 * ## 材料是**复刻**的，不是从浏览器里抓的（这一点如实标注）
 *
 * 探针按宿主 `preview()`（`src/host/intentProjection.ts`）的规则复刻原文：
 * 折叠空白 → trim → 超过 399 字截断并补 `…`。与真路径的差别只有两处：
 *
 *   1. 联系方式做了打码（`session-turns.mjs` 的 `maskPrompt`，只影响姓名/电话/邮箱）；
 *   2. 会话日志里如果同一回合有多条用户消息，聚合方式取决于 `session-log.mjs`。
 *
 * 所以它证明的是"**400 字口径的材料能跑通且结果合理**"，不是"字节级等于浏览器送的那份"。
 *
 * 用法：
 *   node tools/probes/structure-via-host.mjs --session c13af336 \
 *     --url http://127.0.0.1:3098 --cookie /tmp/cj.txt [--hash <指纹>] [--max 40]
 *
 * `--hash` 决定宿主缓存键。不给就按时间生成（**冷跑，真花调用**）；
 * 给同一个值再跑一次应当回 `cached: true`（那是缓存那条路的验证）。
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}
const SESSION = arg('--session', 'c13af336')
const URL_BASE = arg('--url', 'http://127.0.0.1:3098')
const COOKIE = arg('--cookie', '/tmp/cj.txt')
const MAX = Number(arg('--max', 0))
/**
 * `--compare <上一份快照>`：断言**已有节点逐一未变**，并报出新增了什么。
 *
 * 这是"增量归属不许重排已有结构"那条标准的实测手段：先跑一次全量（存快照），
 * 再多送几个回合（走增量），然后比两份快照。
 */
const COMPARE = arg('--compare', '')
const HASH = arg('--hash', `probe-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`)

// **材料口径直接 import 宿主那一份**（`preview`），不在探针里重抄规则。
// 抄一份的后果实测过：研究里验证过的提示词/材料，与插件里跑的那份悄悄不同。
const { preview } = await import(path.join(ROOT, 'lib', 'host', 'intentProjection.js'))
const PROMPT_LIMIT = 400

const { loadSessionTurns } = await import('./session-turns.mjs')
const loaded = loadSessionTurns(SESSION, { maxTurns: MAX })
const turns = loaded.turns.map((t) => ({ turn: t.turn, prompt: preview(t.prompt) }))

// 材料自检：任何一条超限都说明复刻与宿主不一致（那会让这次复跑失去意义）。
const over = turns.filter((t) => t.prompt.length > PROMPT_LIMIT)
if (over.length > 0) {
  console.error(`✗ 复刻的原文超过 ${PROMPT_LIMIT} 字：${over.map((t) => t.turn).join(',')}`)
  process.exit(1)
}

console.log(`会话 ${loaded.id}（共 ${loaded.total} 回合，本次送 ${turns.length} 条）`)
console.log(`材料口径：宿主折叠那份（复刻），最长 ${Math.max(...turns.map((t) => t.prompt.length))} 字，` +
  `合计 ${turns.reduce((n, t) => n + t.prompt.length, 0)} 字`)
console.log(`缓存键指纹：${HASH}`)
console.log('前三回合（截断到 60 字）：')
for (const t of turns.slice(0, 3)) console.log(`  #${t.turn} ${t.prompt.slice(0, 60)}`)

const payload = { sessionId: loaded.id, contentHash: HASH, turns }
const bodyFile = path.join('/tmp', `structure-request-${loaded.id.slice(0, 12)}.json`)
writeFileSync(bodyFile, JSON.stringify(payload))
console.log(`请求体 ${(JSON.stringify(payload).length / 1024).toFixed(1)} KB → ${bodyFile}`)

const started = Date.now()
let raw
try {
  raw = execFileSync(
    'curl',
    ['-s', '-b', COOKIE, '-X', 'POST', `${URL_BASE}/api/intent.structure`,
      '-H', 'content-type: application/json', '--data-binary', `@${bodyFile}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900_000 },
  )
} catch (error) {
  console.error(`✗ curl 失败：${error.message}`)
  process.exit(1)
}
const elapsed = Date.now() - started

let payloadOut
try {
  payloadOut = JSON.parse(raw)
} catch {
  console.error('✗ 响应不是 JSON，前 400 字：')
  console.error(raw.slice(0, 400))
  process.exit(1)
}

if (payloadOut.ok !== true) {
  console.error(`✗ 宿主回了失败：${JSON.stringify(payloadOut).slice(0, 400)}`)
  process.exit(1)
}

const { structure, roots, meta } = payloadOut

// **把响应落盘**（`tools/probes/.out/`，与别的探针一致）：形状问题——多少节点、
// 多深、多少个"一个回合一个节点"——都是事后离线才算得出来的，不落盘就只能重花钱。
const outDir = path.join(HERE, '.out')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `structure-${loaded.id.replace(/^session-/, '').slice(0, 8)}-${HASH}.json`)
writeFileSync(outFile, JSON.stringify({
  sessionId: loaded.id, hash: HASH, meta, structure, roots,
  turns: turns.map((t) => ({ turn: t.turn, prompt: t.prompt })),
  // 压缩回合（宿主 fold 的真值）。结构响应里没有，命令行可以补：`--compactions 62`
  compactionTurns: (arg('--compactions', '') === '' ? [] : arg('--compactions', '').split(',').map(Number)),
  elapsedMs: elapsed, cached: payloadOut.cached === true,
}, null, 0))
console.log(`响应已存 ${outFile}`)
const nodes = Object.keys(structure.nodes ?? {})
const membership = structure.membership ?? {}
const covered = turns.filter((t) => (membership[String(t.turn)] ?? []).length > 0)
const missing = turns.filter((t) => (membership[String(t.turn)] ?? []).length === 0)
// 多归属（真 DAG）与多父（真分支）各数一遍
const multiMember = turns.filter((t) => (membership[String(t.turn)] ?? []).length > 1)
const multiParent = nodes.filter((id) => (structure.nodes[id].parents ?? []).length > 1)

console.log(`\n耗时 ${(elapsed / 1000).toFixed(1)} 秒`
  + (payloadOut.cached === true ? '（cached：宿主缓存命中，没花调用）' : '')
  + (payloadOut.shared === true ? '（shared：与在飞的那次共用）' : ''))
console.log(`meta: ${JSON.stringify(meta)}${meta?.mode === 'incremental' ? '  ← 增量' : ''}`)
console.log(`节点 ${nodes.length} 个 · 线 ${roots?.projects?.length ?? 0} 条（${roots?.note ?? ''}）`)
console.log(`覆盖 ${covered.length}/${turns.length}`
  + (missing.length > 0 ? ` · **没挂任何节点**：${missing.map((t) => '#' + t.turn).join('、')}` : ' · 全覆盖'))
console.log(`多归属回合 ${multiMember.length} 个` +
  (multiMember.length > 0 ? `（#${multiMember.map((t) => t.turn).join('、#')}）` : '') +
  ` · 多父节点 ${multiParent.length} 个` +
  (multiParent.length > 0 ? `（${multiParent.map((id) => `${id}:${structure.nodes[id].title}`).join('、')}）` : ''))
console.log(`分叉点：${(roots?.forks ?? []).map((f) => `${f.title} 起于 #${f.at}`).join(' · ') || '（无）'}`)

// 树用**插件里那一份**渲染（`shared/taskPipeline.ts`，与研究工具逐字交叉校验过）
const P = await import(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
const { text } = P.renderTree(structure, turns.map((t) => ({ turn: t.turn, prompt: t.prompt })))
console.log('\n' + text)

// 判据（写死在这里，免得"看着像对"就过）：结构不能是空的、覆盖不能低于 90%。
const checks = [
  ['结构里有节点', nodes.length > 0, String(nodes.length)],
  ['有根（线）', (roots?.projects?.length ?? 0) > 0, String(roots?.projects?.length ?? 0)],
  [`覆盖 ≥ 90%（实测 ${covered.length}/${turns.length}）`, covered.length >= turns.length * 0.9],
  ['每个节点都有标题', nodes.every((id) => String(structure.nodes[id].title ?? '').trim() !== '')],
  ['归属里的节点 id 都存在', Object.values(membership).every((list) => list.every((id) => structure.nodes[id] !== undefined))],
]
// ── 与上一份快照对照：已有结构必须逐字未变 ──────────────────────────────
if (COMPARE !== '') {
  const before = JSON.parse(readFileSync(path.resolve(COMPARE), 'utf8')).structure
  const changed = []
  for (const [id, node] of Object.entries(before.nodes)) {
    const now = structure.nodes[id]
    if (now === undefined) changed.push(`${id} 不见了`)
    else if (JSON.stringify(now) !== JSON.stringify(node)) changed.push(`${id} 被改动`)
  }
  const addedNodes = Object.keys(structure.nodes).filter((id) => before.nodes[id] === undefined)
  const beforeTurns = new Set(Object.keys(before.membership))
  const addedTurns = turns.filter((t) => !beforeTurns.has(String(t.turn))).map((t) => t.turn)
  checks.push(
    [`已有 ${Object.keys(before.nodes).length} 个节点逐字未变`, changed.length === 0, changed.slice(0, 4).join('、')],
    ['这次是增量接上去的（meta.mode）', meta?.mode === 'incremental', String(meta?.mode)],
  )
  console.log(`\n对照上一份快照：新增节点 ${addedNodes.length} 个（${addedNodes.slice(0, 6).join('、')}…）`
    + ` · 新增回合 ${addedTurns.length} 个 · 继承 ${meta?.inherited ?? 0} 条`)
}

let bad = 0
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) bad += 1
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`)
process.exit(bad === 0 ? 0 : 1)
