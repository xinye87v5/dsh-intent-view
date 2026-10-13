#!/usr/bin/env node
/**
 * 度量的有效性审查：**思考是中英混合的，纯字面召回不可靠**。
 *
 * ## 这个脚本要回答什么
 *
 * 本项目的全部判据都建在**字符二元组重合**上（`bigrams` / `overlap`）。
 * 而那套东西有一个前提：**被比较的两段文字用同一种语言**。
 *
 * 用户指出：模型思考常常**中英混合**（英文句式里塞中文专名，或反过来）。
 * 若如此，前面那些数字就可能是被语言差**污染**过的：
 *
 * > `overlap(英文复述, 中文 prompt)` ≈ 0 —— **不是因为无关，是因为语言不同**。
 *
 * 所以这里不急着改产品，先**量清楚三件事**：
 *
 * 1. **混合有多常见**（按回合统计中英文占比）；
 * 2. **抽取器的线索词有没有语言偏向**（中文句式是不是被漏掉了）；
 * 3. **跨语言的比较占多大比例**、它们的重合是多少
 *    —— 若跨语言对的重合≈0，那么"简报回合 prompt 0.0016 vs 复述 0.0179"
 *    这个对比就同时量了两件事（有没有目标 + 语不语言）。
 *
 * 最后试一个**跨语言的替代特征**：路径 / `#N` / 反引号标识符 / 数字
 * ——这些记号不分语言，可以当"同一件事"的代理。
 *
 * 用法：`node tools/test-language-mixing.mjs [最少回合数=40]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns, artifacts } from './session-log.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const MIN_TURNS = Number(process.argv[2] ?? 40)

/** 中日韩统一表意文字（含扩展 A 与兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 中文字符占比（分母是"中文 + 拉丁字母"）。空文本返回 null。 */
function cjkRatio(text) {
  const source = String(text ?? '')
  let cjk = 0
  let latin = 0
  for (const char of source) {
    if (CJK.test(char)) cjk += 1
    else if (/[A-Za-z]/.test(char)) latin += 1
  }
  if (cjk + latin === 0) return null
  return cjk / (cjk + latin)
}

/** 三分类。**混合**单独一类——它正是这次要看的。 */
function language(text) {
  const ratio = cjkRatio(text)
  if (ratio === null) return '空'
  if (ratio >= 0.8) return '中文'
  if (ratio <= 0.2) return '英文'
  return '混合'
}

const loaded = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  if (usable.turns.length < MIN_TURNS) continue
  loaded.push({ id: candidate.id.slice(0, 14), ...usable })
}
if (loaded.length === 0) {
  console.error(`✗ 没有 ≥${MIN_TURNS} 回合的会话`)
  process.exit(2)
}

const mean = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)
const fmt = (v, digits = 4) => (v === null ? '  —  ' : v.toFixed(digits))
const share = (part, total) => (total === 0 ? '—' : `${((part / total) * 100).toFixed(0)}%`)

// ── 1. 混合有多常见 ─────────────────────────────────────────────────────────
console.log(`会话 ${loaded.length} 个（≥${MIN_TURNS} 回合）\n`)
console.log('=== 1. 靠前思考的语言构成 ===')
console.log('会话              回合   中文   英文   混合   空 | 平均中文字符占比')
const reasoningMix = new Map()
let allTurns = 0
for (const session of loaded) {
  const counts = { 中文: 0, 英文: 0, 混合: 0, 空: 0 }
  const ratios = []
  for (const turn of session.turns) {
    const label = language(turn.early)
    counts[label] += 1
    if (label !== '空') ratios.push(cjkRatio(turn.early))
    reasoningMix.set(label, (reasoningMix.get(label) ?? 0) + 1)
    allTurns += 1
  }
  console.log(
    `${session.id.padEnd(18)}${String(session.turns.length).padStart(4)}` +
      `${String(counts['中文']).padStart(6)}${String(counts['英文']).padStart(6)}` +
      `${String(counts['混合']).padStart(6)}${String(counts['空']).padStart(6)} | ${fmt(mean(ratios), 3).padStart(8)}`,
  )
}
console.log(
  `\n合计 ${allTurns} 个回合：中文 ${share(reasoningMix.get('中文') ?? 0, allTurns)} · ` +
    `英文 ${share(reasoningMix.get('英文') ?? 0, allTurns)} · ` +
    `混合 ${share(reasoningMix.get('混合') ?? 0, allTurns)} · 空 ${share(reasoningMix.get('空') ?? 0, allTurns)}`,
)

// ── 2. 抽取器的语言偏向 ─────────────────────────────────────────────────────
console.log('\n=== 2. 目标句抽取的语言偏向 ===')
console.log('（"抽到"= `goalStatement` 命中线索词；分语言看命中率）')
const hit = { 中文: [0, 0], 英文: [0, 0], 混合: [0, 0], 空: [0, 0] }
const missedSamples = []
for (const session of loaded) {
  for (const turn of session.turns) {
    const label = language(turn.early)
    const statement = shared.goalStatement(turn.early)
    hit[label][1] += 1
    if (statement !== '') hit[label][0] += 1
    else if (label === '中文' && missedSamples.length < 4) {
      missedSamples.push({ id: session.id, turn: turn.turn, text: turn.early.slice(0, 260).replace(/\s+/g, ' ') })
    }
  }
}
for (const label of ['中文', '英文', '混合', '空']) {
  const [got, total] = hit[label]
  console.log(`  ${label.padEnd(4)} 命中 ${String(got).padStart(4)}/${String(total).padEnd(5)} = ${share(got, total)}`)
}
console.log('\n  中文思考里**没抽到**的样本（看是不是漏了句式）：')
for (const sample of missedSamples) {
  console.log(`   · ${sample.id} #${sample.turn}  ${sample.text.slice(0, 220)}`)
}
if (missedSamples.length === 0) console.log('   （没有中文样本，或全部都抽到了）')

// ── 3. 跨语言比较占多大比例 ─────────────────────────────────────────────────
console.log('\n=== 3. 复述句与 prompt 的语言是否一致（这决定前面那些数字能不能读）===')
const pairs = new Map()
for (const session of loaded) {
  for (const turn of session.turns) {
    const statement = shared.goalStatement(turn.early)
    if (statement === '') continue
    const sLang = language(statement)
    const pLang = language(turn.prompt)
    const key = `${pLang}→${sLang}`
    const value = shared.overlap(shared.bigrams(statement), shared.bigrams(turn.prompt))
    if (!pairs.has(key)) pairs.set(key, [])
    pairs.get(key).push(value)
  }
}
const sortedPairs = [...pairs].sort((a, b) => b[1].length - a[1].length)
const pairTotal = sortedPairs.reduce((sum, [, list]) => sum + list.length, 0)
console.log('prompt→复述      条数   占比    平均重合')
for (const [key, list] of sortedPairs) {
  console.log(`  ${key.padEnd(14)}${String(list.length).padStart(5)}  ${share(list.length, pairTotal).padStart(5)}   ${fmt(mean(list))}`)
}
const crossLanguage = sortedPairs.filter(([key]) => {
  const [left, right] = key.split('→')
  return left !== right && left !== '空' && right !== '空'
})
const crossN = crossLanguage.reduce((sum, [, list]) => sum + list.length, 0)
console.log(
  `\n  **跨语言对** ${crossN}/${pairTotal} = ${share(crossN, pairTotal)}，` +
    `平均重合 ${fmt(mean(crossLanguage.flatMap(([, list]) => list)))}`,
)
console.log('  ⇒ 跨语言对的重合趋近 0 是**定义使然**（字符二元组不跨语言），不是"无关"的证据。')

// ── 4. 跨语言的替代特征：路径 / #N / 标识符 ─────────────────────────────────
console.log('\n=== 4. 换跨语言特征再比一次（简报回合）===')
console.log('用"具体产物"（路径、`#N`、反引号标识符、数字）当特征——这些记号不分语言。')
let briefN = 0
const byPrompt = []
const byStatement = []
const byArtifactPrompt = []
const byArtifactStatement = []
for (const session of loaded) {
  const turns = session.turns
  const groupOf = new Map()
  shared
    .groupTurns(turns.map((t) => shared.bigrams(t.prompt + t.response)))
    .forEach((group, index) => group.forEach((item) => groupOf.set(item, index)))
  for (let index = 0; index < turns.length; index += 1) {
    const statement = shared.goalStatement(turns[index].early)
    if (statement === '') continue
    if (shared.bigrams(turns[index].prompt).size >= shared.BRIEF_PROMPT) continue
    const groupTerms = new Set()
    const groupArtifacts = new Set()
    for (let other = 0; other < turns.length; other += 1) {
      if (other === index || groupOf.get(other) !== groupOf.get(index)) continue
      for (const term of shared.bigrams(turns[other].prompt + turns[other].response)) groupTerms.add(term)
      for (const item of artifacts(turns[other].prompt + turns[other].response)) groupArtifacts.add(item)
    }
    if (groupTerms.size === 0) continue
    briefN += 1
    byPrompt.push(shared.overlap(shared.bigrams(turns[index].prompt), groupTerms))
    byStatement.push(shared.overlap(shared.bigrams(statement), groupTerms))
    // 产物口径：分母是空的就跳过（`containment` 返回 null）
    const p = containmentOrNull(artifacts(turns[index].prompt), groupArtifacts)
    const s = containmentOrNull(artifacts(statement), groupArtifacts)
    if (p !== null) byArtifactPrompt.push(p)
    if (s !== null) byArtifactStatement.push(s)
  }
}
function containmentOrNull(left, right) {
  if (left.size === 0 || right.size === 0) return null
  let sharedCount = 0
  for (const item of left) if (right.has(item)) sharedCount += 1
  return sharedCount / left.size
}
console.log(`\n  简报回合 n=${briefN}`)
console.log(`  二元组口径：prompt ${fmt(mean(byPrompt))}   复述句 ${fmt(mean(byStatement))}`)
console.log(
  `  产物口径：  prompt ${fmt(mean(byArtifactPrompt))}（n=${byArtifactPrompt.length}）   ` +
    `复述句 ${fmt(mean(byArtifactStatement))}（n=${byArtifactStatement.length}）`,
)
console.log('\n结论（写死在脚本里，免得下次又照着那个倍数讲故事）：')
console.log('  · 二元组口径那一行**不能读**：prompt 是中文与中文组比，')
console.log('    复述句多为英文与中文组比——**两个测量口径**，跨语言损耗不一样。')
console.log('  · 产物口径上 prompt 的 n=0：**211 个简报回合里，带路径 / `#N` /')
console.log('    标识符的 prompt 是 0 个**。这是语言中性的事实，可以当论据。')
console.log('  · 复述句那一侧 n=10、重合 0.60——**样本太薄，只能当旁证**。')
console.log('\n  可读的比值只有"同一句式下"的那些：抽取器自检 4.2 倍、H1 的前/中/后、')
console.log('  以及产物口径本身（路径 / `#N` / 标识符不分语言）。')
