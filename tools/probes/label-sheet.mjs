#!/usr/bin/env node
/**
 * 生成**人工标记表**：`research/dag-label-sheet-<日期>.md`。
 *
 * 为什么要有它：现在只有 `#21–#28` 有标记，而流水线的三段都会影响全部回合。
 * 使用者要"标记来优化"，就不能让他对着聊天记录翻——所以这里把
 * **流水线当前输出**逐回合铺开，留两列空着让他填：
 *
 * - `该有几处`：0 / 1 / 2+（0 = 这句不推进任何事）
 * - `正确落点`：节点名，或"该新建一个叫 X 的"
 *
 * 用的就是冻结的 `pipeline.mjs`（三段提示词、两个纯函数），
 * 所以标出来的东西与 `research/task-dag-pipeline.md` 描述的是同一套。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'
import { runPipeline } from './run-pipeline.mjs'
import {
  measure, attachmentShape, ancestorsOf, renderTree,
} from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-session-a.txt'))
const CUT = Number(arg('--cut', 20))
const CHUNK = Number(arg('--chunk', 12))
const CONSOLIDATE_EVERY = Number(arg('--consolidate-every', 0))
const CORPUS = path.basename(TURNS_FILE, path.extname(TURNS_FILE))
const SAVE = arg('--save', '')
const OUT = arg('--out', path.resolve(HERE, '..', '..', 'research', `dag-label-sheet-${CORPUS}-${new Date().toISOString().slice(0, 10)}.md`))

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

const result = await runPipeline({
  turns: all,
  complete,
  firstWindow: CUT,
  chunk: CHUNK,
  consolidateEvery: CONSOLIDATE_EVERY,
  log: (line) => console.log('  ' + line),
})
let state = result.state
const foldedAway = result.foldedAway
const roots = result.roots

const m = measure(state, all.length)
// `--save`：把最终状态落盘，之后可以离线复算/换问法复评，不必重跑整条流水线
if (SAVE !== '') {
  const target = path.resolve(HERE, '.out', SAVE.endsWith('.json') ? SAVE : `${SAVE}.json`)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(state, null, 1))
  console.log(`状态已存到 ${path.relative(process.cwd(), target)}`)
}

const cell = (t) => (state.membership[String(t.turn)] ?? []).map((id) => state.nodes[id]?.title ?? id).join(' + ') || '（无）'
const rows = all.map((t) => `| #${t.turn} | ${t.prompt.replace(/\|/g, '\\|')} | ${cell(t)} |  |  |`).join('\n')
const nodes = Object.entries(state.nodes).map(([id, n]) => `| \`${id}\` | ${n.parents.join('/')} | ${n.title} | ${n.kind ?? 'task'} |`).join('\n')

// 自动挑出要问的几组（**不硬编码回合号**，换一套语料照样成立）
const emptyTurns = all.filter((t) => (state.membership[String(t.turn)] ?? []).length === 0)
const multiTurns = all.filter((t) => (state.membership[String(t.turn)] ?? []).length >= 2)
const byNode = {}
for (const t of all) for (const id of state.membership[String(t.turn)] ?? []) (byNode[id] ??= []).push(t.turn)
const sameRuns = Object.entries(byNode)
  .filter(([, turns]) => turns.length >= 2)
  .map(([id, turns]) => {
    const runs = []
    let run = [turns[0]]
    for (const t of turns.slice(1)) {
      if (t === run[run.length - 1] + 1) run.push(t)
      else { runs.push(run); run = [t] }
    }
    runs.push(run)
    return { id, runs }
  })
  .filter((x) => x.runs.length > 0)
/** (c) 有**连续两行以上**挂在同一节点下。(d) 同一节点下的回合**分成几段**（中间岔开过）。 */
const contiguous = sameRuns.filter((x) => x.runs.some((r) => r.length >= 2))
const spread = sameRuns.filter((x) => x.runs.length >= 2)
const CAP = Number(arg('--cap', 12))
/** 分组限长：139 回合的真实会话里，a/b/c/d 不加限制会各自列几十行，没法读。 */
const bullet = (list) => (list.length === 0
  ? '（没有）'
  : list.slice(0, CAP).map((t) => `- **#${t.turn}** ${t.prompt.slice(0, 60)}`).join('\n') +
    (list.length > CAP ? `\n- …… 其余 ${list.length - CAP} 项见下面第二张表` : ''))
const fmtRuns = (x) => `- \`${x.id}\` ${state.nodes[x.id]?.title ?? '??'}：` + x.runs.map((r) => `#${r.join('、#')}`).join('；')
const capRuns = (list) => (list.length === 0
  ? '（没有）'
  : list.slice(0, CAP).map(fmtRuns).join('\n') + (list.length > CAP ? `\n- …… 其余 ${list.length - CAP} 个节点见上面结构图` : ''))
const sameText = capRuns(contiguous)
const spreadText = capRuns(spread)

// **与语料无关**的形状统计：多归属要分成"单链"（父子同挂，你裁定允许）
// 与"异支"（同一回合真在推两件事）。上一套语料写死的判据（sudo/#25/#21）
// 换语料就是噪音，所以这里不再打印它们。
const shape = attachmentShape(state, all.length)
const tree = renderTree(state, all)
const nodeCount = Object.keys(state.nodes).length
const of = (t) => state.membership[String(t.turn)] ?? []
const isAncestor = (a, b) => a !== b && ancestorsOf(state.nodes, b).has(a)
const onOneChain = (list) => list.every((a) => list.every((b) => a === b || isAncestor(a, b) || isAncestor(b, a)))
const chainTurns = all.filter((t) => of(t).length >= 2 && onOneChain(of(t)))
const branchTurns = all.filter((t) => of(t).length >= 2 && !onOneChain(of(t)))

let doc = `# 任务结构标记表（${CORPUS} · ${new Date().toISOString().slice(0, 10)}）

**怎么用**：在最后两列填空。\`该有几处\` 填 0 / 1 / 2+（**0 = 这句不推进任何事**）；
\`正确落点\` 填节点名，或写"该新建一个叫 X 的"。不确定的写"不确定"就行，比猜好。

**你在标什么**：\`tools/probes/pipeline.mjs\` 里那三段冻结提示词**这一次运行**的输出
（三段提示词逐字见 \`research/task-dag-pipeline.md\`）。改了哪一句，这张表就会变。

## 一、结构图（**先看这张**，${nodeCount} 个节点）

每个节点后面是**它收的回合号**。标的时候**直接在图的行尾写**：

- \`该合到 nX\` —— 这一支该并到 nX 下（或这几行该合成一个节点）；
- \`该拆\` —— 这一个节点其实是两件事；
- \`名不对\` —— 名字该改成正在弄的那个对象；
- \`该删\` —— 这个节点不该存在（例如只是评价/承接）；
- \`该新建 X\` —— 缺一个节点。

\`\`\`text
${tree.text}
\`\`\`

${tree.unattached.length === 0 ? '（每一行都有归属）' : `**没挂任何节点**：${tree.unattached.map((t) => `#${t}`).join('、')}`}

## 二、逐回合表（每行细节）

| 回合 | 正文 | 模型当前落点 | 该有几处 | 正确落点 |
|---|---|---|---|---|
${rows}

## 三、自查（不用你填，给你参照）

- 结构轴：**${roots.projects.length} 条非插话线（${roots.note}）** · id 解析 ${m.structural.idsResolve ? '✓' : '✗'} · 父节点解析 ${m.structural.parentsResolve ? '✓' : '✗'} · 无归属回合 [${m.structural.uncovered.join(',')}]
- 归属形状（**与语料无关**）：无落点 ${shape.zero} 行 · 单落点 ${shape.single} 行 · **单链多落点 ${shape.chain} 行**（父子同挂，你说过允许）· **异支多落点 ${shape.branch} 行**（真·两件事）

## 我最想问的几行（**按本次运行自动挑出来的**，其余照表填即可）

这三组不是我挑的，是从这次输出里算出来的：

### a) 模型给了 **0 处落点**的回合（它认为这些句子不推进任何事）

$EMPTY

### b-1) **单链**多落点（落点都在一条祖先链上 = 父与子同挂，你裁定**允许**）

$CHAIN

### b-2) **异支**多落点（落点互不为祖先 = 它认为真的在推两件事）

$BRANCH

### c) **相邻几行落在同一个节点下**（同一件事的两个步骤，还是两件事？）

$SAME

### d) 同一个节点下的回合**分成几段**（中间岔开过又回来——该合还是该拆？）

$SPREAD

---

生成命令：\`node tools/probes/label-sheet.mjs --turns research/${CORPUS}.txt --cut ${CUT}\`　|　
本次用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens
`

doc = doc
  .replace('$EMPTY', bullet(emptyTurns))
  .replace('$CHAIN', bullet(chainTurns))
  .replace('$BRANCH', bullet(branchTurns))
  .replace('$SAME', sameText)
  .replace('$SPREAD', spreadText)

writeFileSync(OUT, doc)
console.log(`已写入 ${path.relative(process.cwd(), OUT)}`)
console.log(`结构轴 id ${m.structural.idsResolve ? '✓' : '✗'} · 父 ${m.structural.parentsResolve ? '✓' : '✗'} · 无归属 [${m.structural.uncovered.join(',')}]`)
console.log(`根：${roots.projects.length} 条非插话线（${roots.note}）` +
  roots.forks.map((f) => ` · ${f.title} 起于 #${f.at}`).join(''))
console.log(`分批：建结构 1 次 · 判归属 ${result.calls.assign} 批（每批 ${CHUNK} 回合）· 判整理 ${result.calls.consolidate} 次` +
  (result.droppedRefs.length > 0 ? ` · 丢弃了 ${result.droppedRefs.length} 个不存在的节点引用` : ''))
console.log(`存储形态：折掉 ${foldedAway} 个祖先落点（只留最具体）`)
console.log(`归属形状：无落点 ${shape.zero} · 单落点 ${shape.single} · 单链多落点 ${shape.chain} · 异支多落点 ${shape.branch}`)
console.log(`（上一套语料的判据 sudo/#25/#21 在这里不适用：${m.sem.sudoDetail} / ${m.sem.detail25} / ${m.sem.detail21}）`)
console.log(`用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
