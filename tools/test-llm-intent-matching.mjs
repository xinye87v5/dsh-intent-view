#!/usr/bin/env node
/**
 * 值不值得引入外部语义资源——**用模型自己来量**。
 *
 * ## 为什么先量这个
 *
 * `tools/test-semantic-space.mjs` 已经证明：这份语料里**没有**免费午餐——
 * 纯字面跨语言 1.0%，共现扩展更差，看起来像"语义"的 28.3% 其实是
 * **模型在思考里引用了用户的中文原话**（转述，不是理解）。
 *
 * 所以要花外部资源。花之前先回答一个问题：
 *
 * > 大模型做**跨语言意图匹配**，比免费通道强多少？
 *
 * ## 任务与设计
 *
 * 查询 = 一个回合的**英文思考**；候选 = **10 条中文回复**（1 条正确 + 9 条干扰）。
 * 随机水平 **10%**。免费通道在**同一批子集**上重算，保证同口径。
 *
 * 三个防自欺的措施：
 *
 * 1. **位置轮转**：正确答案在第 i 题放到第 i 个位置，避免"总选第一个"。
 * 2. **允许弃权**：`index: 0` 表示"都不匹配"。有一批**故意不放正确答案**，
 *    量它会不会硬选——**宁可它说不知道，也不要它编一个**。
 * 3. **分批**：5 题一批、共 4 批，而不是一题一调（省 token）也不是一次 20 题
 *    （一次失败全废，而且长上下文本身会改变表现）。
 * 4. **`--same-session`：干扰项取自同一会话**。默认的干扰项来自池子里任意回合，
 *    可能一眼就能看出"不是这个会话的风格"。若换成**同会话同话题**的干扰项后
 *    成绩崩掉，那"90%"量的就不是意图匹配，而是**风格/会话归属**。
 *    这条是这个实验里最要紧的对照。
 *
 * 用法：`node tools/test-llm-intent-matching.mjs [查询数=20] [每批题数=5]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns } from './session-log.mjs'
import { complete, usage } from './llm-client.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const QUERIES = Number(process.argv[2] ?? 20)
const BATCH = Number(process.argv[3] ?? 5)
const CANDIDATES = 10
/** 抽样步长：**确定性**，不随机——否则每次跑的数字不可比。 */
const SAMPLE_STEP = 17
/** 干扰项是否取自**同一会话**（更难的对照，见文件头第 4 条）。 */
const SAME_SESSION = process.argv.includes('--same-session')

// ── 载入与取样 ──────────────────────────────────────────────────────────────
const pool = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  for (const turn of usable.turns) {
    const latin = (turn.early.match(/[A-Za-z]/g) ?? []).length
    const han = (turn.response.match(/[\u3400-\u9fff]/g) ?? []).length
    if (latin >= 200 && han >= 40) {
      pool.push({ id: candidate.id.slice(8, 14), turn: turn.turn, reasoning: turn.early, response: turn.response })
    }
  }
  if (pool.length >= 2000) break
}
if (pool.length < QUERIES * 2) {
  console.error(`✗ 可用回合只有 ${pool.length} 个`)
  process.exit(2)
}

/** 每题：1 正确 + 9 干扰，正确答案位置按题号轮转。 */
const questions = []
for (let index = 0; index < QUERIES; index += 1) {
  const queryIndex = (index * SAMPLE_STEP) % pool.length
  const query = pool[queryIndex]
  const distractors = []
  for (let offset = 1; distractors.length < CANDIDATES - 1 && offset < pool.length; offset += 1) {
    let candidate
    if (SAME_SESSION) {
      // 同一会话、相邻回合——**风格与话题都最接近**，这是最难的一档
      candidate = pool[(queryIndex + offset) % pool.length]
      if (candidate.id !== query.id) continue
    } else {
      candidate = pool[(queryIndex + offset * 3) % pool.length]
    }
    if (candidate.response === query.response) continue
    distractors.push(candidate.response)
  }
  if (distractors.length < CANDIDATES - 1) continue
  const options = distractors.slice()
  const correctAt = index % CANDIDATES  // 轮转
  options.splice(correctAt, 0, query.response)
  questions.push({ index, query, options, correctAt })
}
console.log(
  `池 ${pool.length} 个回合 · 抽 ${QUERIES} 题 · 每题 ${CANDIDATES} 个候选（1 正确 + 9 干扰）· ` +
    `随机水平 ${(100 / CANDIDATES).toFixed(0)}% · 干扰项来源：${SAME_SESSION ? '**同一会话相邻回合**' : '池中任意回合'}`,
)

/** 免费通道在同一批候选上重算——**同口径**才有可比性。 */
const latinOf = (text) => (String(text).match(/[A-Za-z][A-Za-z0-9_'-]{2,}/g) ?? []).join(' ').toLowerCase()
const hanOf = (text) => (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []).join(' ')
function freeChannel(pick) {
  let correct = 0
  for (const question of questions) {
    const scores = question.options.map((option) => pick(question.query, option))
    let best = 0
    for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[best]) best = i
    if (best === question.correctAt) correct += 1
  }
  return correct / questions.length
}
const jaccard = (left, right) => {
  if (left.length === 0 || right.length === 0) return 0
  const a = new Set(left.split(' '))
  const b = new Set(right.split(' '))
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}
const channels = {
  '纯字面（字符二元组）': freeChannel(
    (query, option) => shared.overlap(shared.bigrams(query.reasoning), shared.bigrams(option)),
  ),
  '拉丁记号（路径/标识符）': freeChannel((query, option) => jaccard(latinOf(query.reasoning), latinOf(option))),
  '引用通道（思考里的汉字）': freeChannel((query, option) => jaccard(hanOf(query.reasoning), hanOf(option))),
}

// ── 问模型 ──────────────────────────────────────────────────────────────────
const SYSTEM = `你在做一个**跨语言意图匹配**评测。
每题给你一段英文的模型思考（reasoning），以及若干条中文的用户可见回复。
其中**恰好一条**与那段思考出自同一个回合；其余是别的回合的干扰项。
按语义判断哪一条与思考讲的是同一件事，不要靠"哪条更长"或"哪条看起来更完整"。
如果没有任何一条匹配，就选 0——**宁可说不知道，也不要硬选**。
只回 JSON：{"answers":[{"q":题号,"index":你选的编号}]}`

function renderBatch(batch) {
  const lines = []
  for (const question of batch) {
    lines.push(`### 第 ${question.index + 1} 题`)
    lines.push(`思考（英文）：${question.query.reasoning.slice(0, 700).replace(/\s+/g, ' ')}`)
    lines.push('候选回复（中文）：')
    question.options.forEach((option, index) => {
      lines.push(`  ${index + 1}. ${option.slice(0, 260).replace(/\s+/g, ' ')}`)
    })
  }
  lines.push('输出 JSON：{"answers":[{"q":1,"index":3}, ...]}；不确定就 index 填 0。')
  return lines.join('\n')
}

/** 抽掉正确答案那一批：**量弃权**用。 */
const withoutAnswer = questions.map((question) => ({
  ...question,
  options: question.options.map((option, index) =>
    index === question.correctAt ? question.options[(question.correctAt + 1) % CANDIDATES] : option,
  ),
}))

let correct = 0
let abstained = 0
let answered = 0
for (let start = 0; start < questions.length; start += BATCH) {
  const batch = questions.slice(start, start + BATCH)
  const raw = await complete(SYSTEM, renderBatch(batch), { json: true, maxTokens: 800 })
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.log(`  第 ${start / BATCH + 1} 批：返回不是 JSON——跳过（${raw.slice(0, 80)}）`)
    continue
  }
  const answers = new Map((parsed.answers ?? []).map((item) => [Number(item.q) - 1, Number(item.index)]))
  for (const question of batch) {
    const picked = answers.get(question.index)
    if (picked === undefined) continue
    answered += 1
    if (picked === 0) abstained += 1
    else if (picked - 1 === question.correctAt) correct += 1
  }
  console.log(`  第 ${start / BATCH + 1} 批完成（累计正确 ${correct}）`)
}

// ── 弃权那一批 ──────────────────────────────────────────────────────────────
let abstainBatchCorrect = 0
let abstainBatchTotal = 0
let abstainBatchAbstained = 0
for (let start = 0; start < withoutAnswer.length; start += BATCH) {
  const batch = withoutAnswer.slice(start, start + BATCH)
  const raw = await complete(SYSTEM, renderBatch(batch), { json: true, maxTokens: 800 })
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    continue
  }
  const answers = new Map((parsed.answers ?? []).map((item) => [Number(item.q) - 1, Number(item.index)]))
  for (const question of batch) {
    abstainBatchTotal += 1
    const picked = answers.get(question.index)
    if (picked === 0 || picked === undefined) abstainBatchAbstained += 1
    else if (picked - 1 === question.correctAt) abstainBatchCorrect += 1
  }
}

const accuracy = correct / questions.length
console.log('\n=== 跨语言意图匹配（10 选 1）===')
for (const [label, value] of Object.entries(channels)) {
  console.log(`  ${label.padEnd(24)} ${(value * 100).toFixed(1)}%`)
}
console.log(`  ${'随机水平'.padEnd(24)} ${(100 / CANDIDATES).toFixed(1)}%`)
console.log(`  ${'★ 大模型'.padEnd(24)} ${(accuracy * 100).toFixed(1)}%   （作答 ${answered}/${QUERIES}，弃权 ${abstained}）`)
console.log(
  `\n  弃权对照（该批**没有**正确答案，所以它选任何一条都是硬选）：` +
    `弃权 ${abstainBatchAbstained}/${abstainBatchTotal}` +
    `${abstainBatchCorrect > 0 ? `，硬选且命中干扰项当作正确的要求下不可能命中（命中 ${abstainBatchCorrect}）` : ''}`,
)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} tokens · 输出 ${usage.completionTokens} tokens`)
console.log('（密钥从 ~/.dsh/.credentials.yaml 读取，未落盘；花的是使用者的额度，故报账。）')
