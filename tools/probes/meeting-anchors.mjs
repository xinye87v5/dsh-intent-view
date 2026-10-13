#!/usr/bin/env node
/**
 * 会议室框架：**议题切换**与**跑题**是两件事，而两者在用户的话里都有痕迹。
 *
 * > 用户："一个会议有多个议题，我们如何判断讨论内容是否跑题，
 * > 又在什么时候切换了议题"
 *
 * 这个框架比之前的口径好，因为它把两件事分开了：
 *
 * - **切换**是正常事件（议程推进），**跑题**才是问题；
 * - 跑题只能**相对当前议题**判，不能相对整场会话判
 *   （上一段实测：参考文本一宽，偏离率就飙到 91%，量的其实是"像不像那段话"）；
 * - 而**两者都不需要先信模型**：你说"接下来看 X"就是切换，说"不对/我说的是"就是跑题。
 *
 * ## 这个脚本量三件事（**不花模型钱**）
 *
 * 1. **显式切换率**：多少个回合的提问里带议程推进的措辞；
 * 2. **纠正率**：多少个回合后面跟着一次纠正（跑题的行为真值，上一段量到 2.2%）；
 * 3. **面板现在的"话题组"边界 vs 显式切换点**：命中多少、漏多少、多切多少。
 *
 * 第 3 条最要紧：**它用一个外部的、来自使用者行为的锚，
 * 去检验那个一直只有自定真值的分词算法**（`scripts/segment-quality.mjs` 的真值
 * 与算法同族同窗口，有自我循环成分——这一条是独立来源）。
 *
 * 用法：`node tools/probes/meeting-anchors.mjs [容差回合=1]`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const TOLERANCE = Number(process.argv[2] ?? 1)

/** 议程推进的措辞。**只看句首**——句中出现"另一个"多半不是切换。 */
const SWITCH_CUES = [
  /^接下来/, /^下一个/, /^下一项/, /^另外/, /^再说/, /^顺便/,
  /^(换|换个|换一个)(话题|问题|方向)/, /^现在(看|说|来|讨论|处理)/,
  /^另(一个|一项)(问题|事|议题)/, /^然后是/, /^第二(个|项)/, /^回到/,
  /^(咱们|我们)(来|看|说)(看|下)/, /^(先|暂)不(说|管)/,
]
/** 跑题/纠正的措辞（与 `corrections.mjs` 同一套）。 */
const CORRECTION_CUES = [
  /^不对/, /^不是/, /^错了/, /^停/, /^别/, /^我说的是/, /^我说过/, /^你搞错/,
  /^跑偏/, /^偏离/, /^回到/, /^重新/, /^我刚才(说|要)的/,
  /^(no|nope|wrong|stop|not what|i said|that's not)/i,
]

let turnsTotal = 0
let switchTurns = 0
const switchSamples = []
let corrections = 0
/** 命中/漏/多切：以"显式切换点"为参考，看面板的分组边界 */
let hit = 0
let missed = 0
let extra = 0
const missedSamples = []

for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  const turns = usable.turns
  if (turns.length < 20) continue
  const terms = turns.map((t) => shared.bigrams(t.prompt + t.response))
  const groups = shared.groupTurns(terms)
  /** 分组边界落在哪些下标上（即"新组的第一个回合"）。 */
  const boundaries = new Set()
  let cursor = 0
  for (const group of groups) {
    if (cursor !== 0) boundaries.add(cursor)
    cursor += group.length
  }

  const anchors = new Set()
  for (let index = 0; index < turns.length; index += 1) {
    const prompt = turns[index].prompt.trim()
    if (prompt === '') continue
    turnsTotal += 1
    if (SWITCH_CUES.some((cue) => cue.test(prompt))) {
      switchTurns += 1
      anchors.add(index)
      if (switchSamples.length < 6) switchSamples.push(prompt.slice(0, 70))
    }
    if (CORRECTION_CUES.some((cue) => cue.test(prompt))) corrections += 1
  }

  const near = (index, set) => {
    for (let delta = -TOLERANCE; delta <= TOLERANCE; delta += 1) if (set.has(index + delta)) return true
    return false
  }
  for (const index of anchors) {
    if (near(index, boundaries)) hit += 1
    else {
      missed += 1
      if (missedSamples.length < 6) missedSamples.push(turns[index].prompt.slice(0, 70))
    }
  }
  for (const index of boundaries) if (!near(index, anchors)) extra += 1
}

const pct = (part, total) => (total === 0 ? '—' : `${((part / total) * 100).toFixed(1)}%`)
console.log(`回合 ${turnsTotal} 个\n`)
console.log(`1. 显式议程推进（"接下来/另外/换个话题/回到…"）  ${switchTurns} 个 = ${pct(switchTurns, turnsTotal)}`)
for (const text of switchSamples) console.log(`     · ${text}`)
console.log(`\n2. 纠正（跑题的行为真值）                        ${corrections} 个 = ${pct(corrections, turnsTotal)}`)
console.log(`\n3. 面板的"话题组"边界 vs 显式切换点（容差 ±${TOLERANCE} 回合）`)
console.log(`     命中 ${hit} · 漏 ${missed} · 多切 ${extra}`)
console.log(`     召回 ${pct(hit, hit + missed)} · 精确 ${pct(hit, hit + extra)}`)
if (missedSamples.length > 0) {
  console.log(`     漏掉的切换点（分组没在那里断开）：`)
  for (const text of missedSamples) console.log(`       · ${text}`)
}
// ── 阈值扫描：用这个**独立锚**去调分词 ──────────────────────────────────────
//
// 这是本项目第一次拿到**与算法不同族**的分段参考。此前 `segment-quality.mjs` 的
// 真值是自己定义的局部谷底（同族同窗口，有自我循环成分），所以只能证明
// "比朴素基线好"，不能证明"切在语义上对"。
//
// ⚠️ 只有 12 个锚，所以每一格都**抖**。这里给的是**趋势**，不是最优点。
console.log(`\n4. 阈值扫描（SPLIT_AT 越大越不容易切）`)
console.log(`   阈值    组数/会话   命中  漏  多切   召回    精确`)
for (const splitAt of [0.04, 0.06, 0.08, 0.12, 0.16, 0.2, 0.3]) {
  let h = 0; let m = 0; let e = 0; let groupsSum = 0; let sessions = 0
  for (const candidate of collectSessions()) {
    let usable
    try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
    const turns = usable.turns
    if (turns.length < 20) continue
    sessions += 1
    const terms = turns.map((t) => shared.bigrams(t.prompt + t.response))
    const groups = shared.groupTurns(terms, splitAt)
    groupsSum += groups.length
    const boundaries = new Set()
    let cursor = 0
    for (const group of groups) { if (cursor !== 0) boundaries.add(cursor); cursor += group.length }
    const anchorsHere = new Set()
    for (let index = 0; index < turns.length; index += 1) {
      const prompt = turns[index].prompt.trim()
      if (prompt !== '' && SWITCH_CUES.some((cue) => cue.test(prompt))) anchorsHere.add(index)
    }
    const near = (index, set) => {
      for (let d = -TOLERANCE; d <= TOLERANCE; d += 1) if (set.has(index + d)) return true
      return false
    }
    for (const index of anchorsHere) { if (near(index, boundaries)) h += 1; else m += 1 }
    for (const index of boundaries) if (!near(index, anchorsHere)) e += 1
  }
  const recall = h + m === 0 ? 0 : h / (h + m)
  const precision = h + e === 0 ? 0 : h / (h + e)
  console.log(
    `   ${String(splitAt).padEnd(8)}${(groupsSum / Math.max(1, sessions)).toFixed(1).padStart(9)}` +
      `${String(h).padStart(7)}${String(m).padStart(5)}${String(e).padStart(7)}` +
      `   ${(recall * 100).toFixed(0).padStart(3)}%   ${(precision * 100).toFixed(1).padStart(5)}%`,
  )
}

console.log(`\n读法：`)
console.log(`  · 第 1 行是"切换有多频繁"——它是**正常事件**，不该被当成问题报警。`)
console.log(`  · 第 2 行是"跑题有多频繁"，2% 上下量级。`)
console.log(`  · 第 3 行用**使用者行为**当锚检验分词算法——这个锚与算法不同族，`)
console.log(`    是本项目第一次拿到**独立来源**的分段参考（此前的真值是自己定义的局部谷底）。`)
console.log(`  · 第 4 行看趋势：**精确率大概率一直很低**——因为"显式宣布"只是真切换的`)
console.log(`    一个子集，没人宣布的切换一样是真切换。所以精确率有天花板，`)
console.log(`    该读的是**"组数降到多少才与议题量级相当"**（1.1% 的回合宣布了切换）。`)
