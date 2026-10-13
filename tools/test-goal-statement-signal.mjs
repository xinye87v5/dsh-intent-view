#!/usr/bin/env node
/**
 * 换一个**表示**再试一次：从靠前的思考里抽出"目标句"，看它是不是真的在变。
 *
 * ## 为什么要换表示
 *
 * `tools/test-early-reasoning-signal.mjs` 的结论是否证：把"前段思考与当前组的
 * **词面重合度**"当第二个切分判据，**边际效果 ≤0.012 且安慰剂一样好**。
 * 机制上也说得通——它和连续性判据是**同一族**（都是"这段文字的词有多少在组里"），
 * 只是换了段文字来算。同族的东西加不進独立信息。
 *
 * 所以要换一个**不同族**的表示：不是"这段文字有多少词在组里"，
 * 而是"**这一回合把用户要什么说成了什么**"——一句被归一化的话。
 *
 * > 靠前的思考里通常有一句 `The user asks two things: …` / `The user wants…`。
 * > 如果这句话在组内稳定、在分界处改变，那它就是一个**可显示的、短的目标**，
 * > 而且与词面重合度不同族。
 *
 * ## 三个量（每个都配对照）
 *
 * 1. **抽取器自检**：抽出的目标句与**本回合 prompt** 的重合，须显著高于与
 *    **别的回合 prompt** 的重合。抽错了这一关就过不去。
 * 2. **组内稳定 / 分界改变**：`overlap(目标句_N, 目标句_{N-1})`
 *    在"$N-1$ 与 $N$ 同组"与"$N$ 是新组开头"两种情形下的差。
 * 3. **安慰剂**：`overlap(目标句_N, 目标句_{N-7})`——跨 7 个回合，与本回合无关。
 *
 * 抽取率必须一起报：一个只覆盖三成回合的信号，无论多准都不够用。
 *
 * ## 抽取器现在住在插件里
 *
 * `goalStatement` 已移进 `src/shared/intent.ts`（宿主 fold 要用同一份），
 * 本脚本从 `lib/shared/intent.js` 引入——**语义只有一处**。
 *
 * 用法：`node tools/test-goal-statement-signal.mjs [最少回合数=40]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, usableTurns, readEvents } from './session-log.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// 这个脚本既用还活着的 `goalStatement`，也用已删的 `groupTurns`/`overlap`，
// 所以整份走冻结模块（它转发活语义 + 提供冻结的那部分）。
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const MIN_TURNS = Number(process.argv[2] ?? 40)
/** 目标句上限。它要能显示，不能是一段话。 */
const STATEMENT_LIMIT = 200
/** 安慰剂跨度（回合）。 */
const PLACEBO_SHIFT = 7

/** 目标句抽取**就是插件本体那一份**（`src/shared/intent.ts` 的 `goalStatement`）。
 *
 * 这里曾经抄过一份带 CUES 的本地实现——那就成了"两个实现在同一语料上算同一件事"，
 * 而本项目为这个模式吃过亏（TS 与 Python 的 bigram 实现漂移过 1–2 个话题组）。
 * 研究脚本的价值是**量**，不是**另写一份语义**。
 */
const goalStatement = shared.goalStatement

const loaded = []
for (const candidate of collectSessions()) {
  let built
  try {
    built = buildTurns(readEvents(candidate.log))
  } catch {
    continue
  }
  const usable = usableTurns(built)
  if (usable.turns.length < MIN_TURNS) continue
  loaded.push({ id: candidate.id.slice(0, 14), ...usable })
}

if (loaded.length === 0) {
  console.error(`✗ 没有 ≥${MIN_TURNS} 回合的会话`)
  process.exit(2)
}

const mean = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)
const fmt = (v) => (v === null ? '  —  ' : v.toFixed(4))

const rows = []
console.log(`会话 ${loaded.length} 个（≥${MIN_TURNS} 回合）\n`)
console.log('会话              回合   抽到目标句   占比 | 句子↔本回合prompt  句子↔别回合prompt | 同组相邻  跨分界  安慰剂')
for (const session of loaded) {
  const turns = session.turns
  const terms = turns.map((t) => shared.bigrams(t.prompt + t.response))
  const groups = shared.groupTurns(terms)
  // 每个下标属于哪一组
  const groupOf = new Map()
  groups.forEach((group, index) => group.forEach((item) => groupOf.set(item, index)))

  const statements = turns.map((t) => goalStatement(t.early))
  const found = statements.filter((s) => s !== '').length

  const own = []
  const other = []
  const same = []
  const cross = []
  const placebo = []
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    if (statement === '') continue
    const termsOf = shared.bigrams(statement)
    own.push(shared.overlap(termsOf, shared.bigrams(turns[index].prompt)))
    const far = turns[(index + PLACEBO_SHIFT) % turns.length]
    other.push(shared.overlap(termsOf, shared.bigrams(far.prompt)))

    const prev = index - 1
    if (prev >= 0 && statements[prev] !== '') {
      const pair = shared.overlap(termsOf, shared.bigrams(statements[prev]))
      if (groupOf.get(index) === groupOf.get(prev)) same.push(pair)
      else cross.push(pair)
    }
    const placeboTurn = index - PLACEBO_SHIFT
    if (placeboTurn >= 0 && statements[placeboTurn] !== '') {
      placebo.push(shared.overlap(termsOf, shared.bigrams(statements[placeboTurn])))
    }
  }

  const row = {
    id: session.id,
    turns: turns.length,
    groups: groups.length,
    found,
    rate: found / turns.length,
    own: mean(own),
    other: mean(other),
    same: mean(same),
    cross: mean(cross),
    placebo: mean(placebo),
    sameN: same.length,
    crossN: cross.length,
  }
  rows.push(row)
  console.log(
    `${row.id.padEnd(18)}${String(row.turns).padStart(4)}${String(row.found).padStart(10)}` +
      `${(row.rate * 100).toFixed(0).padStart(7)}% | ${fmt(row.own).padStart(14)}  ${fmt(row.other).padStart(16)} | ` +
      `${fmt(row.same)}  ${fmt(row.cross)}  ${fmt(row.placebo)}`,
  )
}

const agg = (key) => mean(rows.map((r) => r[key]))
console.log('\n合计（各会话等权）')
console.log(`  抽取率                  ${((agg('rate') ?? 0) * 100).toFixed(0)}%`)
console.log(`  句子 ↔ 本回合 prompt     ${fmt(agg('own'))}`)
console.log(`  句子 ↔ 别回合 prompt     ${fmt(agg('other'))}   ← 对照：抽错了这一项就会追平上一项`)
console.log(`  同组相邻的句子重合       ${fmt(agg('same'))}   (n=${rows.reduce((s, r) => s + r.sameN, 0)})`)
console.log(`  跨分界的句子重合         ${fmt(agg('cross'))}   (n=${rows.reduce((s, r) => s + r.crossN, 0)})`)
console.log(`  安慰剂（跨 ${PLACEBO_SHIFT} 回合）        ${fmt(agg('placebo'))}`)

// ── 关键追问：简报回合上，它是不是提供了 prompt 提供不了的信息？ ──────────────
//
// 这是这条线**唯一可能有价值的地方**。`BRIEF_PROMPT` 那条实测早就写了：
// 26% 的 prompt 是 `同意`/`继续吧`/`帮我重启`——**承接与指令，没有目标**。
// 那种回合里，用户的话里根本没有目标；而 agent 的前段思考里有。
// 所以要看的是：**只在这些回合上**，目标句是不是比 prompt 更贴当前组。
let briefN = 0
const briefPromptFit = []
const briefStatementFit = []
for (const session of loaded) {
  const turns = session.turns
  const groupOf = new Map()
  shared.groupTurns(turns.map((t) => shared.bigrams(t.prompt + t.response)))
    .forEach((group, index) => group.forEach((item) => groupOf.set(item, index)))
  const statements = turns.map((t) => goalStatement(t.early))
  for (let index = 0; index < turns.length; index += 1) {
    if (statements[index] === '') continue
    if (shared.bigrams(turns[index].prompt).size >= shared.BRIEF_PROMPT) continue
    // 当前组**除本回合外**的全部词——拿它当"这一段在做什么"
    const groupTerms = new Set()
    for (let other = 0; other < turns.length; other += 1) {
      if (other === index || groupOf.get(other) !== groupOf.get(index)) continue
      for (const term of shared.bigrams(turns[other].prompt + turns[other].response)) groupTerms.add(term)
    }
    if (groupTerms.size === 0) continue
    briefN += 1
    briefPromptFit.push(shared.overlap(shared.bigrams(turns[index].prompt), groupTerms))
    briefStatementFit.push(shared.overlap(shared.bigrams(statements[index]), groupTerms))
  }
}
console.log('\n简报回合（prompt 短于 ' + shared.BRIEF_PROMPT + ' 个二元组）上，谁更贴当前组：')
if (briefN === 0) {
  console.log('  （没有样本）')
} else {
  const p = mean(briefPromptFit)
  const q = mean(briefStatementFit)
  console.log(`  n=${briefN}   prompt ${fmt(p)}   目标句 ${fmt(q)}   ${q > p ? '→ 目标句更贴' : '→ prompt 更贴'}`)
  console.log('  ⚠️ prompt 极短时 `overlap` 的分母很小，这个比较对被比者不完全公平——只作方向参考。')
}

console.log('\n判定：')
const own = agg('own') ?? 0
const other = agg('other') ?? 0
const same = agg('same')
const cross = agg('cross')
const placebo = agg('placebo')
console.log(`  抽取器有效（本回合 ≫ 别回合）：${own > other * 1.5 ? '✓' : '✗'}（${fmt(own)} vs ${fmt(other)}）`)
if (same === null || cross === null) {
  console.log('  组内/跨分界：样本不足，无法判定')
} else {
  console.log(
    `  分界处确实换了目标（同组 > 跨分界）：${same > cross * 1.2 ? '✓' : '✗'}（${fmt(same)} vs ${fmt(cross)}）`,
  )
  console.log(
    `  且不只是"离得近就重合"（同组 > 安慰剂）：${placebo === null ? '—' : same > placebo * 1.2 ? '✓' : '✗'}（${fmt(same)} vs ${fmt(placebo)}）`,
  )
}
