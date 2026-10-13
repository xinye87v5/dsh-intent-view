#!/usr/bin/env node
/**
 * 能不能不要模型、不要依赖，就搭出一个**语义框架**？
 *
 * ## 为什么要这个
 *
 * 本项目的判据全建在**字符二元组重合**上。用户连着指出两条：
 *
 * 1. **模型思考是中英混合的**（实测：英文 83% · 混合 15% · 中文 2%），
 *    字面召回跨语言结构性地对不上；
 * 2. **"语言是大量词汇组成的"**——同一个意思换个词就召回不到，
 *    词表覆盖永远追不上。
 *
 * ⇒ 要的是**语义**，不是更大的词表。
 *
 * ## 这个实验的立足点：语料里自带一份**对齐的双语平行数据**
 *
 * 同一个回合里，**思考是英文**、**回复是中文**，说的是同一件事。
 * 所以不需要外部语料、不需要模型：**共现本身就是桥**。
 *
 * > 压缩 / compaction 反复出现在同一批回合里 ⇒ 它们的上下文向量会靠近。
 *
 * ## 任务：跨语言检索（有唯一正确答案，所以可以判对错）
 *
 * 拿一个回合的**英文思考**当查询，从 N 个**中文回复**里挑出它自己那个回合的。
 *
 * - 纯字面（字符二元组）在这上面应当接近随机——**跨语言对不上**；
 * - 共现扩展的向量若真带语义，应当明显高于随机。
 *
 * 三个对照，缺一不可：
 *
 * | 对照 | 作用 |
 * |---|---|
 * | **随机基线** `1/N` | 没有它，任何数字都无法解释 |
 * | **打乱配对** | 查询与答案故意错配——**必须掉回随机**，否则是评测器有 bug |
 * | **不扩展的纯词向量** | 区分"功劳在共现扩展"还是"在词本身" |
 *
 * 用法：`node tools/test-semantic-space.mjs [会话数=7] [查询数=400]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns } from './session-log.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))

const SESSION_LIMIT = Number(process.argv[2] ?? 7)
const QUERY_LIMIT = Number(process.argv[3] ?? 400)

/** 英文停用词。只挡最高频的那些——停用词表越长越容易把语义一起挡掉。 */
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'but', 'not', 'have', 'has',
  'was', 'were', 'will', 'would', 'can', 'could', 'should', 'from', 'they', 'them', 'their',
  'there', 'here', 'what', 'when', 'where', 'which', 'while', 'into', 'than', 'then', 'some',
  'such', 'only', 'also', 'just', 'like', 'more', 'most', 'much', 'very', 'been', 'being',
  'about', 'after', 'before', 'because', 'between', 'both', 'each', 'other', 'over', 'same',
  'does', 'did', 'doing', 'done', 'get', 'got', 'make', 'made', 'use', 'used', 'using',
  'one', 'two', 'all', 'any', 'may', 'might', 'must', 'now', 'new', 'old', 'see', 'seen',
  'let', 'its', "it's", 'i.e', 'e.g', 'etc', 'instead', 'however', 'though', 'still',
])

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/**
 * 取词。
 *
 * 中文没有分词器，所以**用二元字**——但与插件不同的是，这里先把出现太少的
 * 二元字丢掉（语义空间靠共现，噪声词只会稀释）。
 */
function termsOf(text) {
  const out = []
  const source = String(text ?? '')
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_'-]{2,}/g)) {
    const word = match[0].toLowerCase()
    if (!STOP.has(word)) out.push(word)
  }
  // 中文：连续汉字段里取二元字
  for (const run of source.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

// ── 载入 ────────────────────────────────────────────────────────────────────
const loaded = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  if (usable.turns.length < 20) continue
  loaded.push({ id: candidate.id.slice(0, 14), turns: usable.turns })
  if (loaded.length >= SESSION_LIMIT) break
}

/** 每个回合的三段文本，分开留着——查询与候选要用不同语言的那两段。 */
const turns = []
for (const session of loaded) {
  for (const turn of session.turns) {
    const reasoning = turn.early
    const response = turn.response
    const prompt = turn.prompt
    if (reasoning === '' || response === '') continue
    turns.push({ id: session.id, turn: turn.turn, reasoning, response, prompt })
  }
}
console.log(`会话 ${loaded.length} 个 · 回合 ${turns.length} 个`)

// ── 共现空间 ────────────────────────────────────────────────────────────────
//
// ## 为什么要**两遍**（第一版一遍就把内存打爆了）
//
// 一遍的写法是"边抽词边建共现"。中文没有分词器，只能用二元字，于是每个回合
// 抽出来的词里有大量长尾垃圾（`的第`、`1章`、`的是`…），词表轻松上百万；
// 再对每个回合做 n² 的配对，Node 直接 OOM（实测 4 GB 堆打爆、core dump）。
//
// 所以先量 `df`（一个词出现在多少个回合里），**只留反复出现的词**，
// 再建共现。语义本来就靠"反复共现"，长尾垃圾除了稀释什么也做不了。
//
// 上下文 = **一个回合的全部文本**（提问 + 回复 + 思考）。桥正在这一层：
// 同一个回合里英文思考与中文回复共现，于是两种语言的词被拉到一起。
console.log('第一遍：统计词频（df）…')
const df = new Map() // term -> 出现在多少个回合里
for (const turn of turns) {
  for (const term of new Set(termsOf(`${turn.prompt}\n${turn.response}\n${turn.reasoning}`))) {
    df.set(term, (df.get(term) ?? 0) + 1)
  }
  // 中途剪枝：只出现一次的词不可能长成高频词，先扔掉，免得撑爆内存
  if (df.size > 400_000) {
    for (const [term, count] of df) if (count < 2) df.delete(term)
  }
}
console.log(`  原始词表 ${df.size}`)

/** 只留出现 ≥`MIN_DF` 个回合的词，并且**取前 `VOCAB_LIMIT` 个**。 */
const MIN_DF = 4
const VOCAB_LIMIT = 8000
const ranked = [...df].filter(([, n]) => n >= MIN_DF).sort((a, b) => b[1] - a[1])
const vocabulary = new Map(ranked.slice(0, VOCAB_LIMIT))
console.log(`  出现 ≥${MIN_DF} 个回合的 ${ranked.length} 个，取前 ${vocabulary.size} 个建空间`)

/** 每个回合最多用多少个词——按 df 取前若干个，砍掉长尾。 */
const TERMS_PER_TURN = 100

console.log('第二遍：建共现…')
const cooc = new Map() // term -> Map(term -> count)
for (const turn of turns) {
  const unique = [...new Set(termsOf(`${turn.prompt}\n${turn.response}\n${turn.reasoning}`))]
    .filter((term) => vocabulary.has(term))
    .sort((a, b) => vocabulary.get(b) - vocabulary.get(a))
    .slice(0, TERMS_PER_TURN)
  for (let i = 0; i < unique.length; i += 1) {
    let row = cooc.get(unique[i])
    if (row === undefined) {
      row = new Map()
      cooc.set(unique[i], row)
    }
    for (let j = 0; j < unique.length; j += 1) {
      if (i === j) continue
      row.set(unique[j], (row.get(unique[j]) ?? 0) + 1)
    }
  }
}
const neighboursTotal = [...cooc.values()].reduce((sum, row) => sum + row.size, 0)
console.log(`  词表 ${cooc.size} · 平均每词共现邻居 ${(neighboursTotal / Math.max(1, cooc.size)).toFixed(0)}`)

/**
 * 一个文本的向量 = 它自己的词 + 每个词的**共现邻居**（按关联强度加权）。
 *
 * 这就是"语义框架"的最小形态：不查同义词表，靠**用词环境**把
 * 「压缩」和「compaction」拉到一起。
 *
 * @param expand - 扩展几个邻居。0 = 不扩展（消融对照）。
 */
function vectorOf(text, expand = 40) {
  const vector = new Map()
  const terms = termsOf(text).filter((term) => vocabulary.has(term))
  const add = (key, weight) => {
    if (weight <= 0) return
    vector.set(key, (vector.get(key) ?? 0) + weight)
  }
  for (const term of terms) {
    // 自己的词权重更高（原词总比邻居更可靠）
    add(term, 1)
    if (expand === 0) continue
    const row = cooc.get(term)
    if (row === undefined) continue
    const neighbours = [...row]
      .map(([other, count]) => [other, count / Math.sqrt((df.get(term) ?? 1) * (df.get(other) ?? 1))])
      .sort((a, b) => b[1] - a[1])
      .slice(0, expand)
    for (const [other, strength] of neighbours) {
      if (!vocabulary.has(other)) continue
      add(other, 0.35 * strength)
    }
  }
  // L2 归一化
  let norm = 0
  for (const value of vector.values()) norm += value * value
  norm = Math.sqrt(norm)
  if (norm > 0) for (const [key, value] of vector) vector.set(key, value / norm)
  return vector
}

function cosine(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let dot = 0
  for (const [key, value] of small) {
    const other = large.get(key)
    if (other !== undefined) dot += value * other
  }
  return dot
}

// ── 检索评测 ────────────────────────────────────────────────────────────────
//
// 查询 = 英文思考；候选 = 中文回复。**同一个回合的那条才是正确答案。**
// 只留有真英文思考、且回复里真有汉字的回合——否则这题不成立。
const pairs = turns
  .map((turn, index) => ({ index, ...turn }))
  .filter((turn) => {
    const latin = (turn.reasoning.match(/[A-Za-z]/g) ?? []).length
    const han = (turn.response.match(/[\u3400-\u9fff]/g) ?? []).length
    return latin >= 200 && han >= 40
  })
  .slice(0, QUERY_LIMIT)
console.log(`\n可用于跨语言检索的回合 ${pairs.length} 个（英文思考 ≥200 字母、中文回复 ≥40 汉字）`)
if (pairs.length < 20) {
  console.error('✗ 样本太少，无法评测')
  process.exit(2)
}

const candidates = pairs.map((pair) => vectorOf(pair.response))
const candidateBigrams = pairs.map((pair) => shared.bigrams(pair.response))
const chance = 1 / pairs.length

function evaluate(label, queryVectorFor, queryBigramsFor, correctOffset = 0) {
  let hit1 = 0
  let hit10 = 0
  let reciprocal = 0
  for (let index = 0; index < pairs.length; index += 1) {
    // `correctOffset` 非 0 时**故意错配**——打乱配对的对照必须掉回随机
    const answer = (index + correctOffset) % pairs.length
    const query = queryVectorFor(pairs[index])
    const queryBigrams = queryBigramsFor(pairs[index])
    const scored = candidates.map((candidate, candidateIndex) => ({
      candidateIndex,
      score:
        query === null
          ? shared.overlap(queryBigrams, candidateBigrams[candidateIndex])
          : cosine(query, candidate),
    }))
    scored.sort((a, b) => b.score - a.score)
    const rank = scored.findIndex((item) => item.candidateIndex === answer) + 1
    if (rank === 1) hit1 += 1
    if (rank <= 10) hit10 += 1
    reciprocal += 1 / rank
  }
  const n = pairs.length
  console.log(
    `  ${label.padEnd(26)} R@1 ${((hit1 / n) * 100).toFixed(1)}%` +
      `   R@10 ${((hit10 / n) * 100).toFixed(1)}%` +
      `   MRR ${(reciprocal / n).toFixed(3)}`,
  )
  return { hit1: hit1 / n, hit10: hit10 / n, mrr: reciprocal / n }
}

console.log(`\n=== 跨语言检索（随机基线 R@1 = ${(chance * 100).toFixed(2)}%）===`)
const lexical = evaluate('纯字面（字符二元组）', () => null, (pair) => shared.bigrams(pair.reasoning))
const plain = evaluate('词向量（不扩展）', (pair) => vectorOf(pair.reasoning, 0), () => new Set())
const semantic = evaluate('共现扩展（40 邻居）', (pair) => vectorOf(pair.reasoning, 40), () => new Set())
// **错配要跨得远**：第一版用 +1（相邻回合），而相邻回合本来就高度相似，
// 于是"打乱"对照拿到 2.5%（基线 0.25%）——那不是评测器坏了，是零假设选错了。
const semanticShuffled = evaluate('共现扩展 + 错配（远处）', (pair) => vectorOf(pair.reasoning, 40), () => new Set(), 137)

// ── 拆分：那 18.5% 到底是"语义"还是"共享的标识符" ────────────────────────────
//
// 中英两段文本之间唯一**天然共享**的东西是拉丁记号：路径、工具名、标识符
// （`docs/44`、`dsh-intent-view`、`session`…）。若只留这层就有 18%，
// 那"语义框架"这个说法就是虚的——它量的其实是**标识符召回**。
const latinOnly = (text) => (String(text).match(/[A-Za-z][A-Za-z0-9_'-]{2,}/g) ?? []).join(' ')
const hanOnly = (text) =>
  (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g) ?? []).join(' ')

const latinVectors = pairs.map((pair) => vectorOf(latinOnly(pair.response), 0))
function evaluateLatin() {
  let hit1 = 0
  let hit10 = 0
  let reciprocal = 0
  for (let index = 0; index < pairs.length; index += 1) {
    const query = vectorOf(latinOnly(pairs[index].reasoning), 0)
    const scored = latinVectors.map((candidate, candidateIndex) => ({
      candidateIndex,
      score: cosine(query, candidate),
    }))
    scored.sort((a, b) => b.score - a.score)
    const rank = scored.findIndex((item) => item.candidateIndex === index) + 1
    if (rank === 1) hit1 += 1
    if (rank <= 10) hit10 += 1
    reciprocal += 1 / rank
  }
  const n = pairs.length
  console.log(
    `  ${'只有拉丁记号（路径/标识符）'.padEnd(26)} R@1 ${((hit1 / n) * 100).toFixed(1)}%` +
      `   R@10 ${((hit10 / n) * 100).toFixed(1)}%   MRR ${(reciprocal / n).toFixed(3)}`,
  )
}
evaluateLatin()

// ── 再拆一层：英文思考里**本来就夹着中文**（引用用户原话） ────────────────
//
// 混合思考的样本长这样：`The user says: "重启了，继续任务"`。
// 若"只拿思考里的汉字"去检索中文回复就能拿到十几分，那所谓的跨语言桥
// **不是语义，是引用**——思考把你自己的话原样抄进去了。
//
// 这条必须单独量：它决定"语义框架"这个说法成不成立。
let queriesWithHan = 0
let hanBigramsTotal = 0
const hanOnlyVectors = pairs.map((pair) => vectorOf(hanOnly(pair.response), 0))
for (const pair of pairs) {
  const han = hanOnly(pair.reasoning)
  if (han !== '') queriesWithHan += 1
  hanBigramsTotal += (han.match(/[\u3400-\u4dbf\u4e00-\u9fff]{2}/g) ?? []).length
}
function evaluateHanOnly() {
  let hit1 = 0
  let hit10 = 0
  let reciprocal = 0
  let scored_count = 0
  for (let index = 0; index < pairs.length; index += 1) {
    const query = vectorOf(hanOnly(pairs[index].reasoning), 0)
    if (query.size === 0) continue
    scored_count += 1
    const scored = hanOnlyVectors.map((candidate, candidateIndex) => ({
      candidateIndex,
      score: cosine(query, candidate),
    }))
    scored.sort((a, b) => b.score - a.score)
    const rank = scored.findIndex((item) => item.candidateIndex === index) + 1
    if (rank === 1) hit1 += 1
    if (rank <= 10) hit10 += 1
    reciprocal += 1 / rank
  }
  console.log(
    `  ${'只有思考里的汉字（引用通道）'.padEnd(26)} R@1 ${((hit1 / scored_count) * 100).toFixed(1)}%` +
      `   R@10 ${((hit10 / scored_count) * 100).toFixed(1)}%   MRR ${(reciprocal / scored_count).toFixed(3)}` +
      `  （有汉字的查询 ${scored_count}/${pairs.length}）`,
  )
}
evaluateHanOnly()
console.log(
  `  思考里平均夹着 ${(hanBigramsTotal / pairs.length).toFixed(0)} 个中文二字组，` +
    `${((queriesWithHan / pairs.length) * 100).toFixed(0)}% 的思考里含中文`,
)

// ── 直接看桥有没有搭起来 ────────────────────────────────────────────────────
console.log('\n=== 桥的抽样：某个中文词，最相近的英文词是谁 ===')
const probes = ['压缩', '目标', '回合', '工具', '插件', '测试', '文档', '日志']
for (const probe of probes) {
  const row = cooc.get(probe)
  if (row === undefined) {
    console.log(`  ${probe}: 词表里没有`)
    continue
  }
  const neighbours = [...row]
    .map(([other, count]) => [
      other,
      count / Math.sqrt((df.get(probe) ?? 1) * (df.get(other) ?? 1)),
    ])
    .filter(([other]) => /^[a-z][a-z0-9_'-]+$/.test(other) && vocabulary.has(other))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  console.log(`  ${probe} → ${neighbours.map(([word, score]) => `${word}(${score.toFixed(2)})`).join(' ')}`)
}

console.log('\n读法：')
console.log('  · 纯字面若接近随机基线，就坐实了"跨语言字面召回不成立"。')
console.log('  · 共现扩展若明显高于纯字面与随机，**而且打乱配对掉回随机**，语义框架就是成立的。')
console.log('  · 词向量（不扩展）那一行用来分工：涨的是"词本身"还是"共现扩展"。')
