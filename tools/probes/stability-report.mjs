#!/usr/bin/env node
/**
 * 把 `pipeline-stability.mjs` 存下的几次运行渲染成**对比文档**（离线，不调模型）。
 *
 * 要回答的问题只有一个：使用者认可了"细"的那一档（27 节点），
 * 而流水线有时给出"粗"的一档（18 节点）——**粗的那档他也认吗？**
 * 认 ⇒ 方差无害，可以按"两种粒度都可接受"结案；
 * 不认 ⇒ 先压方差，再谈别的优化。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { attachmentShape, renderTree, ancestorsOf, closeUnderAncestors, isAncestorClosed, mostSpecific } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-fairytale.txt'))
const PREFIX = arg('--prefix', 'fairytale-run')
const OUT = arg('--out', path.resolve(HERE, '..', '..', 'research', 'fairytale-stability-2026-10-09.md'))
const OUTDIR = path.resolve(HERE, '.out')

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

const files = readdirSync(OUTDIR).filter((f) => f.startsWith(PREFIX) && f.endsWith('.json')).sort()
if (files.length < 2) throw new Error(`需要至少两份运行状态（${OUTDIR}/${PREFIX}*.json）`)
/** `--closure`：先做祖先闭包再比——用它验证"确定性补齐能不能消掉风格跳动"。 */
const CLOSURE = process.argv.includes('--closure')
const raw = files.map((f) => ({ tag: f.replace('.json', ''), state: JSON.parse(readFileSync(path.join(OUTDIR, f), 'utf8')) }))
const states = CLOSURE ? raw.map((r) => ({ ...r, state: closeUnderAncestors(r.state) })) : raw
if (CLOSURE) console.log(`祖先闭包：闭包前 ${raw.filter((r) => !isAncestorClosed(r.state)).length}/${raw.length} 份未闭合 → 闭包后全部为 ${
  states.every((r) => isAncestorClosed(r.state))}`)

/**
 * **最具体落点**：去掉"被同一回合里另一个落点包含"的祖先。
 *
 * 这是做跨运行比较必须的规范化：一旦每个回合都挂上项目根，
 * "两个回合是否同挂一个节点"就恒为真（度量饱和）——闭包会让它更严重。
 * 取最具体落点之后，闭包前后完全一样，比的就真是"落在哪个任务上"。
 */
const specific = mostSpecific

const summary = (state) => {
  const shape = attachmentShape(state, all.length)
  const { unattached } = renderTree(state, all)
  const roots = Object.keys(state.nodes).filter((id) => state.nodes[id].parents.includes('root'))
  return { nodes: Object.keys(state.nodes).length, shape, unattached, roots: roots.map((id) => state.nodes[id].title) }
}
const rows = states.map(({ tag, state }) => ({ tag, ...summary(state) }))

/** 回合对 → 是否共现（挂在同一个节点下）。 */
function coPairs(input) {
  const state = specific(input)
  const sets = {}
  for (const [turn, ids] of Object.entries(state.membership)) sets[turn] = new Set(ids)
  const pairs = new Map()
  const turns = all.map((t) => String(t.turn))
  for (let i = 0; i < turns.length; i += 1) {
    for (let j = i + 1; j < turns.length; j += 1) {
      const a = sets[turns[i]] ?? new Set()
      const b = sets[turns[j]] ?? new Set()
      pairs.set(`${turns[i]}-${turns[j]}`, [...a].some((id) => b.has(id)))
    }
  }
  return pairs
}
const pairs = states.map(({ state }) => coPairs(state))
const agreements = []
for (let i = 0; i < states.length; i += 1) {
  for (let j = i + 1; j < states.length; j += 1) {
    let same = 0
    for (const [key, value] of pairs[i]) if (pairs[j].get(key) === value) same += 1
    agreements.push({ a: i, b: j, same, total: pairs[i].size, rate: same / pairs[i].size })
  }
}
const mean = agreements.reduce((s, a) => s + a.rate, 0) / agreements.length

const titlesOf = (state, turn) => (state.membership[String(turn)] ?? []).map((id) => state.nodes[id]?.title ?? id)
const titlesOfSpecific = (state, turn) => {
  const s = specific(state)
  return (s.membership[String(turn)] ?? []).map((id) => state.nodes[id]?.title ?? id)
}
const specificRows = all.map((t) => `| #${t.turn} | ${t.prompt.slice(0, 24)} | ` +
  states.map(({ state }) => titlesOfSpecific(state, t.turn).join(' + ') || '（无）').join(' | ') + ' |').join('\n')

const perTurn = all.map((t) => `| #${t.turn} | ${t.prompt.slice(0, 26)} | ` +
  states.map(({ state }) => titlesOf(state, t.turn).join(' + ') || '（无）').join(' | ') + ' |').join('\n')

const trees = states.map(({ tag, state }) => {
  const { text, unattached } = renderTree(state, all)
  return `### ${tag}（${Object.keys(state.nodes).length} 节点）\n\n\`\`\`text\n${text}\n\`\`\`\n\n` +
    (unattached.length === 0 ? '（每一行都有归属）' : `**没挂任何节点**：${unattached.map((t) => `#${t}`).join('、')}`)
}).join('\n\n')

const isAncestor = (state, a, b) => a !== b && ancestorsOf(state.nodes, b).has(a)
const chainCount = (state) => Object.values(state.membership)
  .filter((ids) => ids.length >= 2 && ids.every((a) => ids.every((b) => a === b || isAncestor(state, a, b) || isAncestor(state, b, a)))).length

const doc = `# 冻结流水线的**稳定性**（${states.length} 次，同一份语料）

问题：使用者认可了"细"那一档（27 节点），但流水线有时给出"粗"的一档（18 节点）。
**粗的那档也认吗？** 认 ⇒ 方差无害；不认 ⇒ 先压方差。

## 一、三次的形状

| 运行 | 节点数 | **顶层节点数** | 顶层是谁 | 无落点 | 单落点 | 单链多落点 | 异支多落点 |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.tag} | ${r.nodes} | **${r.roots.length}** | ${r.roots.join('、')} | ${r.shape.zero} | ${r.shape.single} | ${r.shape.chain} | ${r.shape.branch} |`).join('\n')}

⚠️ **顶层数就是那个"跳档"**：${rows.map((r) => r.roots.length).join(' / ')}。
**有项目根**（2 个顶层：项目 + 插话）与**平铺**（8 个顶层、没有项目根）
是两种结构，不是同一结构的粗细差别。

## 二、两两一致率（回合对的"**最具体落点**是否相同"，共 ${agreements[0].total} 对）

${agreements.map((a) => `- ${states[a.a].tag} vs ${states[a.b].tag}：**${(a.rate * 100).toFixed(1)}%**（相同 ${a.same}/${a.total}）`).join('\n')}

**平均 ${(mean * 100).toFixed(1)}%** —— 但这不是"整体 88% 稳"，而是**两种粒度之间在跳**：
细的那档两次几乎逐对一致，另一档整体更粗。差异全在"父子要不要都挂"上：
单链多落点分别是 ${rows.map((r) => r.shape.chain).join(' / ')} 行。

## 二之二、逐回合的**最具体落点**对照

只差在**叫法**的（\`结局设计\` vs \`结局改编\` 这类）不算结构差异——
下面这张表是给你看"真差异落在哪几行"的：

| 回合 | 正文 | ${states.map((s) => s.tag).join(' | ')} |
|---|---|---|
${specificRows}

## 三、逐回合对照（**含祖先**，看层级用）

| 回合 | 正文 | ${states.map((s) => s.tag).join(' | ')} |
|---|---|---|
${perTurn}

## 四、三次的结构图

${trees}

---

生成：\`node tools/probes/pipeline-stability.mjs --runs 3\` 然后
\`node tools/probes/stability-report.mjs\`（后者**不调模型**，读 \`tools/probes/.out/\` 里的状态）。
`

writeFileSync(OUT, doc)
console.log(`已写入 ${path.relative(process.cwd(), OUT)}`)
console.log(`平均一致率 ${(mean * 100).toFixed(1)}% · 节点数 ${rows.map((r) => r.nodes).join('/')} · 单链多落点 ${rows.map((r) => r.shape.chain).join('/')}`)
