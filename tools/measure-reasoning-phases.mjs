#!/usr/bin/env node
/**
 * 检验一条关于**思考内部结构**的假设。
 *
 * ## 被检验的主张
 *
 * > 思考不是一坨：**靠前的思考在重申用户的目标意图，并且承接上一轮里 agent
 * > 提到的设计**；靠后的思考是"目标定下之后的执行思路"。
 *
 * 这条主张来自人对会话的阅读（本项目的用户提出）。它是有后果的：
 * 若成立，面板就不该把思考当正文看待，而该**按位置筛**——
 * 靠前的那一段才是"这一段在做什么"的独立佐证，而且是**不来自用户措辞**的佐证。
 *
 * ## 为什么必须测，而不是接着往下做
 *
 * 这个项目已经栽过两次同一类亏：**把机制推断当成结论**
 * （压缩混淆那条被自己的检验否掉；评审 §4 那条前提根本不成立）。
 * 所以这条主张先按本项目的尺子过一遍：**要么测出来，要么降级**。
 *
 * ## 度量用的是插件自己的函数
 *
 * `bigrams` / `overlap` 从 `lib/shared/intent.js` 引入——**同一份实现**。
 * 另写一份会让"两个实现在同一语料上不一致"这个老问题再回来。
 *
 * ## 必须有的对照（没有对照就测了个寂寞）
 *
 * 字符二元组在**无关文本**之间也有约 0.23 的底噪，所以绝对值没有意义。
 * 每个量都比**同位置、跨回合的随机配对**（错配对照），看差值。
 *
 * ## H2 用词面重合测**测不出来**，所以补一个 H4

H2 的错配对照是 0.4025，而"与上一回合思考的重合"是 0.4269——
**两者几乎一样**。也就是说那个 0.43 是**话题底噪**（整段会话的用词本来就高度重叠），
不是"承接"。所以"承接上一轮的设计"这条要换度量：不看整体重合，
看**上一轮提过的具体东西（文件、路径、`#N`、反引号里的标识符）有没有在本轮被接住**。

## 五个量
 *
 * | 量 | 定义 | 假设方向 |
 * |---|---|---|
 * | **H1 重申目标** | `overlap(思考, 本回合 prompt)` | 前 > 后 |
 * | **H2 承接上轮** | `overlap(思考, 上一回合的全部思考)` | 前 > 后 |
 * | **H3 执行痕迹** | `overlap(思考, 本回合的工具调用参数)` | 后 > 前 |
 * | **C 错配对照** | `overlap(思考, **别的**回合的 prompt)` | 前 ≈ 后 |
 *
 * 用法：`node tools/measure-reasoning-phases.mjs [会话数=6]`
 */
import path from 'node:path'
import {
  artifacts,
  buildTurns,
  collectSessions,
  containment,
  EARLY_WINDOW,
  readEvents,
  usableTurns,
} from './session-log.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// `overlap` 已随分组语义从产品侧删除（提交 ④）⇒ 从研究的冻结副本取；
// `bigrams` 仍活着，冻结副本会转发它。
const { bigrams, overlap } = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

/** 每段取样多少字符。与共用载入器的前段思考窗口**必须一致**（断言在下面）。 */
const WINDOW = EARLY_WINDOW
/** 错配对照每个回合抽几次。 */
const PLACEBO_ROUNDS = 3

/** 前 WINDOW 字 / 后 WINDOW 字。取尾部**不能**靠 `bigrams`——它只截头部。 */
const head = (text) => text.slice(0, WINDOW)
const tail = (text) => text.slice(-WINDOW)

const sessions = []
for (const candidate of collectSessions()) {
  let built
  try {
    built = buildTurns(readEvents(candidate.log))
  } catch (error) {
    console.error(`  跳过 ${candidate.id.slice(0, 14)}：${String(error.message).slice(0, 80)}`)
    continue
  }
  const usable = usableTurns(built)
  if (usable.turns.length === 0) continue
  sessions.push({ id: candidate.id.slice(0, 14), turns: usable.turns })
  if (sessions.length >= Number(process.argv[2] ?? 6)) break
}

if (sessions.length === 0) {
  console.error('✗ 没有找到任何可用的会话日志')
  process.exit(2)
}

const rows = []
const samples = []
for (const session of sessions) {
  const turns = session.turns
  const usable = turns.filter((t) => t.steps.length >= 2)
  const skipped = turns.filter((t) => t.steps.length < 2).length
  const perSession = { id: session.id, turns: turns.length, usable: usable.length, skipped, rows: [] }

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn.steps.length < 2) continue
    const early = head(turn.steps[0].reasoning)
    const mid = head(turn.steps[Math.floor((turn.steps.length - 1) / 2)].reasoning)
    const late = tail(turn.steps[turn.steps.length - 1].reasoning)
    const prev = turns[index - 1]
    const prevReasoning = prev === undefined ? '' : prev.steps.map((s) => s.reasoning).join('\n')
    const toolArgs = turn.toolArgs.join('\n')

    // 错配对照：本回合的思考 vs **别的**回合的 prompt / 思考
    let placebo = 0
    let placeboCount = 0
    let placeboReasoning = 0
    let placeboReasoningCount = 0
    for (let k = 1; k <= PLACEBO_ROUNDS; k += 1) {
      const other = turns[(index + k * 7) % turns.length]
      if (other === turn || other.prompt === '') continue
      placebo += overlap(bigrams(early), bigrams(head(other.prompt)))
      placeboCount += 1
      const otherReasoning = other.steps.map((s) => s.reasoning).join('\n')
      if (otherReasoning !== '') {
        placeboReasoning += overlap(bigrams(early), bigrams(head(otherReasoning)))
        placeboReasoningCount += 1
      }
    }

    const prompts = bigrams(head(turn.prompt))
    const prevTerms = prevReasoning === '' ? null : bigrams(head(prevReasoning))
    const toolTerms = toolArgs === '' ? null : bigrams(head(toolArgs))
    const row = {
      session: perSession.id,
      turn: turn.turn,
      steps: turn.steps.length,
      reasoningChars: turn.steps.reduce((sum, s) => sum + s.reasoning.length, 0),
      h1Early: overlap(bigrams(early), prompts),
      h1Mid: overlap(bigrams(mid), prompts),
      h1Late: overlap(bigrams(late), prompts),
      h2Early: prevTerms === null ? null : overlap(bigrams(early), prevTerms),
      h2Mid: prevTerms === null ? null : overlap(bigrams(mid), prevTerms),
      h2Late: prevTerms === null ? null : overlap(bigrams(late), prevTerms),
      h3Early: toolTerms === null ? null : overlap(bigrams(early), toolTerms),
      h3Mid: toolTerms === null ? null : overlap(bigrams(mid), toolTerms),
      h3Late: toolTerms === null ? null : overlap(bigrams(late), toolTerms),
      earlyTerms: bigrams(early).size,
      midTerms: bigrams(mid).size,
      lateTerms: bigrams(late).size,
      earlyShort: turn.steps[0].reasoning.length < WINDOW ? 1 : 0,
      midShort: turn.steps[Math.floor((turn.steps.length - 1) / 2)].reasoning.length < WINDOW ? 1 : 0,
      lateShort: turn.steps[turn.steps.length - 1].reasoning.length < WINDOW ? 1 : 0,
      placebo: placeboCount === 0 ? null : placebo / placeboCount,
      placeboReasoning: placeboReasoningCount === 0 ? null : placeboReasoning / placeboReasoningCount,
    }

    // H4：本轮思考有没有接住**上一回合**提过的具体产物
    //
    // **这一项不能用 400 字窗口**：产物是稀疏的（路径、`#N`、反引号标识符），
    // 400 字里经常一个都没有——第一版这么写，只有 107/769 个回合算得出值，
    // 而那个子集的走势还被"哪一段恰好提到路径"决定了。所以 H4 取**整段**思考。
    const fullEarly = turn.steps[0].reasoning
    const fullMid = turn.steps[Math.floor((turn.steps.length - 1) / 2)].reasoning
    const fullLate = turn.steps[turn.steps.length - 1].reasoning
    const prevArtifacts = artifacts(prevReasoning + ' ' + (prev?.toolArgs.join(' ') ?? ''))
    const far = turns[(index + 7) % turns.length]
    const farArtifacts = artifacts(far?.steps.map((s) => s.reasoning).join(' ') ?? '')
    row.h4Early = containment(artifacts(fullEarly), prevArtifacts)
    row.h4Mid = containment(artifacts(fullMid), prevArtifacts)
    row.h4Late = containment(artifacts(fullLate), prevArtifacts)
    row.h4Placebo = containment(artifacts(fullEarly), farArtifacts)
    perSession.rows.push(row)
    rows.push(row)
    if (samples.length < 2 && turn.steps.length >= 3) {
      samples.push({
        session: perSession.id,
        turn: turn.turn,
        steps: turn.steps.length,
        prompt: head(turn.prompt).replace(/\s+/g, ' ').slice(0, 170),
        early: early.replace(/\s+/g, ' ').slice(0, 300),
        late: late.replace(/\s+/g, ' ').slice(0, 300),
      })
    }
  }
  session.rows = perSession
}

const mean = (values) => {
  const list = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v))
  if (list.length === 0) return null
  return list.reduce((a, b) => a + b, 0) / list.length
}
const fmt = (value) => (value === null ? '  —  ' : value.toFixed(4))

console.log(`会话 ${sessions.length} 个，可用回合 ${rows.length} 个（回合内 ≥2 步带思考）\n`)
console.log('会话              回合  可用  跳过 |    H1 前/中/后          |    H2 前/中/后          |    H3 前/中/后          |   H4 前/中/后')
for (const session of sessions) {
  const per = session.rows
  if (per === undefined) continue
  const own = (key) => mean(per.rows.map((r) => r[key]))
  const triple = (prefix) => `${fmt(own(prefix + 'Early'))}/${fmt(own(prefix + 'Mid'))}/${fmt(own(prefix + 'Late'))}`
  console.log(
    `${per.id.padEnd(18)}${String(per.turns).padStart(4)}${String(per.usable).padStart(6)}` +
      `${String(per.skipped).padStart(6)} | ${triple('h1')} | ${triple('h2')} | ${triple('h3')} | ${triple('h4')}`,
  )
}

const pick = (key) => mean(rows.map((r) => r[key]))
console.log('\n合计（769 个可用回合的平均）')
const profiles = [
  ['H1 重申目标   overlap(思考, 本回合 prompt)', 'h1'],
  ['H2 承接上轮   overlap(思考, 上回合思考)', 'h2'],
  ['H3 执行痕迹   overlap(思考, 本回合工具参数)', 'h3'],
  ['H4 接住上轮产物   |产物(思考) ∩ 产物(上回合)| / |产物(思考)|', 'h4'],
]
for (const [label, prefix] of profiles) {
  const e = pick(prefix + 'Early')
  const m = pick(prefix + 'Mid')
  const l = pick(prefix + 'Late')
  const n = rows.filter((r) => r[prefix + 'Early'] !== null && r[prefix + 'Late'] !== null).length
  const down = rows.filter((r) => r[prefix + 'Early'] !== null && r[prefix + 'Late'] !== null && r[prefix + 'Early'] > r[prefix + 'Late']).length
  console.log(
    `  ${label}\n    前 ${fmt(e)}   中 ${fmt(m)}   后 ${fmt(l)}` +
      `   | 单调下降 ${down}/${n} (${n === 0 ? '—' : ((down / n) * 100).toFixed(0)}%)`,
  )
}
console.log(`\n  错配对照（前思考 vs 别回合 prompt）  ${fmt(pick('placebo'))}`)
console.log(`  错配对照（前思考 vs 别回合思考）      ${fmt(pick('placeboReasoning'))}`)
console.log(`  H4 错配对照（前思考产物 vs 远处回合产物）  ${fmt(pick('h4Placebo'))}`)
console.log('  对照的作用：字符二元组在无关文本间底噪约 0.23，所以**只有相对差值有意义**。')

// **先堵一个最容易被提的质疑**：会不会"前"那段本来就更长/更短，于是重合度天然不同？
const sizes = (key) => mean(rows.map((r) => r[key]))
console.log('\n取样规模（二元组个数，用来排除"前/后窗口大小不等造成的假差"）')
console.log(`  思考步数 前段 ${fmt(sizes('earlyTerms'))} 中段 ${fmt(sizes('midTerms'))} 后段 ${fmt(sizes('lateTerms'))}`)
console.log(`  未截断（<${WINDOW} 字）的比例 前 ${fmt(sizes('earlyShort'))} 中 ${fmt(sizes('midShort'))} 后 ${fmt(sizes('lateShort'))}`)

console.log('\n样本（看人话，别看数）')
for (const sample of samples) {
  console.log(`\n  ── ${sample.session} 第 ${sample.turn} 回合（${sample.steps} 步）`)
  console.log(`  prompt : ${sample.prompt}`)
  console.log(`  前思考 : ${sample.early}`)
  console.log(`  后思考 : ${sample.late}`)
}
