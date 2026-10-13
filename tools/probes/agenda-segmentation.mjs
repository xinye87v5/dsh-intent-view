#!/usr/bin/env node
/**
 * 让模型**直接给议题分段**，拿使用者的话语标记当锚来评。
 *
 * ## 为什么走这条（文献指引）
 *
 * - 词面凝聚力（TextTiling 这一族）在会议语料上测不出议题——本项目已实测：
 *   **任何阈值下精确率 ≤5.2%**，粗到接近议题量级时召回变 0；
 * - "话语标记"单用有**歧义**（Hirschberg & Litman 的标题就叫
 *   *Disambiguation of Cue Phrases*）；
 * - 无人监督的当前最佳是**语义变化**（[Solbiati et al. 2021](https://arxiv.org/abs/2106.12978)，
 *   会议语料上比既有无人监督方法**降 15.5% 错误率**），而它有监督版本因标注成本
 *   "不可行"。
 *
 * 但 **DeepSeek 没有 embeddings 端点**（使用者已确认），所以"语义变化"只能走
 * 对话通道：**让模型自己把会话切成议题**。本脚本就是量它到底行不行。
 *
 * ## 预先写死的成败标准（先定反证，再算数字）
 *
 *     **精确率 ≥ 20%** 才算通过。
 *
 * 理由：真实议题切换的基准率约 **1%**。标记率高于 8% 的检测器精确率到不了一半；
 * 而 20% 已经是很宽的门槛了——**低于它就不该进产品**，我会直接建议撤掉这条功能。
 *
 * 锚是**使用者的话**（"接下来/另外/回到…"），与任何词面算法**不同族**，
 * 所以这次不是自证。⚠️ 锚只有 12 个上下，逐会话都抖；看的是量级不是小数位。
 *
 * ## 第一版**没有通过**，但它没隔离出想问的东西
 *
 * 第一版提示词只说"谈同一件事的连续回合归为一段"，模型于是按**话题级**切：
 * 377 回合切了 **38 段**（≈10 回合一段），而锚只有 **5 个**（≈75 回合一个）。
 * 粒度差十倍 ⇒ 精确率那个数**同时量了"切得准不准"和"切得细不细"**，
 * 而我只想问前者。所以加一句粒度约束重跑（**同一把尺子、只改这一处**）：
 * 议程级、一场通常 3–8 段。
 *
 * 用法：`node tools/probes/agenda-segmentation.mjs [最多会话=6]`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
import { complete, usage } from '../llm-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const SESSION_LIMIT = Number(process.argv[2] ?? 6)
const TOLERANCE = 1

const SWITCH_CUES = [
  /^接下来/, /^下一个/, /^下一项/, /^另外/, /^再说/, /^顺便/,
  /^(换|换个|换一个)(话题|问题|方向)/, /^现在(看|说|来|讨论|处理)/,
  /^另(一个|一项)(问题|事|议题)/, /^然后是/, /^第二(个|项)/, /^回到/,
  /^(咱们|我们)(来|看|说)(看|下)/, /^(先|暂)不(说|管)/,
]

const SYSTEM = `你在把一段人与 AI 的会话按**议题**分段——像整理一份会议记录：
把"在谈同一件事"的连续回合归为一段，换了一件事就另起一段。
议题是**谈的是什么**，不是"用了哪些词"。常见的切换点是使用者说
「接下来」「另外」「回到」「换个话题」这类话的地方，但**不限于**这些词。
**粒度是议程级的，不是话题级的**：一段典型覆盖**几十个回合**，
整场通常只有 **3–8 段**。"同一个话题下换个具体问题"不算新议题；
只有"整件事换了"才算。
只回 JSON：{"segments":[{"from":起始回合号,"to":结束回合号,"title":"这个议题是什么，12 字内"}]}
要求：覆盖全部回合、不重叠、按序。`

const picked = []
for (const candidate of collectSessions()) {
  let usable
  try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
  const turns = usable.turns
  if (turns.length < 40 || turns.length > 400) continue
  const anchors = []
  for (let i = 0; i < turns.length; i += 1) {
    const p = turns[i].prompt.trim()
    if (p !== '' && SWITCH_CUES.some((c) => c.test(p))) anchors.push(i)
  }
  if (anchors.length < 2) continue
  picked.push({ id: candidate.id.slice(8, 14), turns, anchors, terms: turns.map((t) => shared.bigrams(t.prompt + t.response)) })
  if (picked.length >= SESSION_LIMIT) break
}
if (picked.length === 0) { console.error('✗ 没有找到带锚点的会话'); process.exit(2) }

/** ±容差内算命中。 */
const near = (index, set) => {
  for (let d = -TOLERANCE; d <= TOLERANCE; d += 1) if (set.has(index + d)) return true
  return false
}

let hitAll = 0, missAll = 0, extraAll = 0
let lexHit = 0, lexMiss = 0, lexExtra = 0
console.log(`会话 ${picked.length} 个\n`)
for (const session of picked) {
  const lines = session.turns.map((t, i) => `#${i + 1} ${t.prompt.replace(/\s+/g, ' ').slice(0, 70)}`)
  const raw = await complete(SYSTEM, lines.join('\n'), { json: true, maxTokens: 1500, temperature: 0 })
  let segments = []
  try { segments = JSON.parse(raw).segments ?? [] } catch { /* 解析失败当作没分段 */ }
  // 只认合法段（回合号在范围内、按序）
  const clean = segments
    .map((s) => ({ from: Number(s.from), to: Number(s.to), title: String(s.title ?? '') }))
    .filter((s) => Number.isInteger(s.from) && Number.isInteger(s.to) && s.from >= 1 && s.to <= session.turns.length && s.from <= s.to)
    .sort((a, b) => a.from - b.from)
  const modelBounds = new Set(clean.slice(1).map((s) => s.from - 1))
  const anchorSet = new Set(session.anchors)

  let h = 0, m = 0, e = 0
  for (const a of anchorSet) { if (near(a, modelBounds)) h += 1; else m += 1 }
  for (const b of modelBounds) if (!near(b, anchorSet)) e += 1
  hitAll += h; missAll += m; extraAll += e

  // 同一批会话上的词面基线
  const groups = shared.groupTurns(session.terms)
  const lexBounds = new Set()
  let cursor = 0
  for (const g of groups) { if (cursor !== 0) lexBounds.add(cursor); cursor += g.length }
  let lh = 0, lm = 0, le = 0
  for (const a of anchorSet) { if (near(a, lexBounds)) lh += 1; else lm += 1 }
  for (const b of lexBounds) if (!near(b, anchorSet)) le += 1
  lexHit += lh; lexMiss += lm; lexExtra += le

  const prec = h + e === 0 ? 0 : h / (h + e)
  console.log(
    `${session.id}  ${session.turns.length} 回合 · 锚 ${anchorSet.size} 个\n` +
      `   模型：切 ${modelBounds.size} 段 → 命中 ${h} 漏 ${m} 多 ${e}` +
      `  召回 ${((h / Math.max(1, h + m)) * 100).toFixed(0)}%  精确 ${(prec * 100).toFixed(1)}%\n` +
      `   词面：切 ${lexBounds.size} 段 → 命中 ${lh} 漏 ${lm} 多 ${le}` +
      `  召回 ${((lh / Math.max(1, lh + lm)) * 100).toFixed(0)}%  精确 ${((lh / Math.max(1, lh + le)) * 100).toFixed(1)}%`,
  )
  if (clean.length > 0) {
    console.log(`   议题标题：${clean.map((s) => s.title).slice(0, 8).join(' / ')}`)
  }
}

const pr = (h, e) => (h + e === 0 ? 0 : h / (h + e))
const rc = (h, m) => (h + m === 0 ? 0 : h / (h + m))
console.log(`\n=== 合计 ===`)
console.log(`  模型  召回 ${(rc(hitAll, missAll) * 100).toFixed(0)}%  精确 ${(pr(hitAll, extraAll) * 100).toFixed(1)}%  （命中 ${hitAll} 漏 ${missAll} 多 ${extraAll}）`)
console.log(`  词面  召回 ${(rc(lexHit, lexMiss) * 100).toFixed(0)}%  精确 ${(pr(lexHit, lexExtra) * 100).toFixed(1)}%  （命中 ${lexHit} 漏 ${lexMiss} 多 ${lexExtra}）`)
console.log(`\n预定的成败标准：**精确率 ≥ 20%**。`)
console.log(`  ⇒ 模型 ${pr(hitAll, extraAll) >= 0.2 ? '**通过**（可以进产品）' : '**不通过**（建议撤掉这条功能，别继续调）'}`)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
