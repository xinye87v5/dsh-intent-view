#!/usr/bin/env node
/**
 * **稳定性**：同一份冻死水线、同一份语料，连跑 N 次，结构会不会变？
 *
 * ## 为什么必须量这个
 *
 * 使用者对童话语料某一次输出的裁定是"分类没问题"。但 `temperature: 0`
 * 只让**第二、三段**确定；**第一趟每次都重新采样**。所以"没问题"能不能外推，
 * 取决于这份数。
 *
 * ## 怎么比（不靠 id，也不靠标题逐字相同）
 *
 * 两次运行之间的节点 id 与措辞都会变，没法直接比对。所以比**回合之间的共现关系**：
 *
 * > 对每一对回合 (i, j)，它们在这次运行里**有没有挂在同一个节点下**。
 *
 * 这是结构的一个不变量（换一套 id、换个名字都还在），32 个回合共 496 对。
 * 报告的"一致率"就是这 496 对里判断相同的比例。随机结构的期望值不接近 100%，
 * 所以这个数读起来很直接。
 *
 * 另外报：节点数、每回合落点数分布、无归属回合集合、以及**与你认可的那次样本**
 * 相同的几个行级特征（祖先链行数等）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'
import { attachmentShape, renderTree, rootSummary } from './pipeline.mjs'
import { runPipeline } from './run-pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-fairytale.txt'))
const CUT = Number(arg('--cut', 20))
const RUNS = Number(arg('--runs', 3))
const CHUNK = Number(arg('--chunk', 12))
const CONSOLIDATE_EVERY = Number(arg('--consolidate-every', 0))
const OUTDIR = path.resolve(HERE, '.out')
const PREFIX = arg('--prefix', 'fairytale-run')

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

async function runOnce(tag) {
  const result = await runPipeline({ turns: all, complete, firstWindow: CUT, chunk: CHUNK,
    consolidateEvery: CONSOLIDATE_EVERY, log: (line) => console.log('    ' + line) })
  const state = result.state
  mkdirSync(OUTDIR, { recursive: true })
  writeFileSync(path.join(OUTDIR, `${tag}.json`), JSON.stringify(state, null, 1))
  return state
}

/** 回合对 → 是否共现（挂在同一个节点下）。 */
function coPairs(state) {
  const sets = {}
  for (const [turn, ids] of Object.entries(state.membership)) sets[turn] = new Set(ids)
  const pairs = new Map()
  const turns = all.map((t) => String(t.turn))
  for (let i = 0; i < turns.length; i += 1) {
    for (let j = i + 1; j < turns.length; j += 1) {
      const a = sets[turns[i]] ?? new Set()
      const b = sets[turns[j]] ?? new Set()
      const shared = [...a].some((id) => b.has(id))
      pairs.set(`${turns[i]}-${turns[j]}`, shared)
    }
  }
  return pairs
}

const states = []
for (let i = 1; i <= RUNS; i += 1) {
  const state = await runOnce(`${PREFIX}${i}`)
  const shape = attachmentShape(state, all.length)
  const { unattached } = renderTree(state, all)
  states.push(state)
  console.log(
    `第 ${i} 次  节点 ${String(Object.keys(state.nodes).length).padStart(2)} · 顶层 ${rootSummary(state, all).projects.length} 个非插话` +
      ` · 无落点 ${shape.zero} · 单落点 ${shape.single} · 单链多落点 ${shape.chain} · 异支多落点 ${shape.branch}` +
      ` · 无归属回合 [${unattached.join(',')}]`,
  )
}

const pairs = states.map(coPairs)
console.log('\n=== 两两一致率（回合对的"是否同挂一个节点"，共 496 对）===')
let sum = 0
let n = 0
for (let i = 0; i < states.length; i += 1) {
  for (let j = i + 1; j < states.length; j += 1) {
    let same = 0
    for (const [key, value] of pairs[i]) if (pairs[j].get(key) === value) same += 1
    const rate = same / pairs[i].size
    sum += rate
    n += 1
    console.log(`第 ${i + 1} 次 vs 第 ${j + 1} 次：${(rate * 100).toFixed(1)}%（相同 ${same}/${pairs[i].size} 对）`)
  }
}
const mean = sum / Math.max(1, n)
console.log(`\n平均一致率 ${(mean * 100).toFixed(1)}%`)
console.log(
  mean >= 0.9
    ? '⇒ 高：一次采样被认可，大致可以外推到整条流水线。'
    : mean >= 0.75
      ? '⇒ 中：形状大体一致，但落的节点会换，认可只部分可外推。'
      : '⇒ 低：**认可只覆盖那一个样本**，得先压方差再谈优化。',
)
console.log(`状态已存到 ${path.relative(process.cwd(), OUTDIR)}/${PREFIX}*.json`)
console.log(`用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
