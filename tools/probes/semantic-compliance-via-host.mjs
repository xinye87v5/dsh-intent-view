#!/usr/bin/env node
/**
 * **"agent 有没有偏离用户交办的事"** —— 走真正发出去的那条路（`/api/intent.semantic`）量它。
 *
 * ## 与 `node-check-via-host.mjs` 的区别（两个探针问的不是同一个问题）
 *
 * - `node-check-via-host.mjs`（旧）：材料 = 全部有回合的节点 + **用户原文**当待判文本，
 *   问的是"这条理解与它挂的节点是不是同一件事"——**分类一致性**。它留下的数字
 *   （真 0–25% / 乱 67–92%）记在 `research/group-vs-dag-2026-10-10.md` 里。
 * - 本探针（新）：使用者 2026-10-10 裁定——*"所谓工作偏离是指 agent 行为是否不符合
 *   发布的任务"*。所以材料按 `shared/semantic.ts` 的 `semanticMaterial` 造：
 *   每一条待判 = **用户这一回合发布的指令** + **agent 当时的理解**（从思考里抽的那句）,
 *   外加上下文（任务节点名 + 它名下的代表回合）。问的是**符合不符合**。
 *
 * 材料**直接 import 插件那一份**（`lib/shared/semantic.js`），不在探针里重写——
 * 本项目吃过"研究里验证过的材料 ≠ 插件里跑的"的亏。
 *
 * ## 两个臂
 *
 * - `real`：原样。
 * - `ask-shuffled`：把**指令**在两两之间对调（理解不动）。这就是"agent 在办另一件事"
 *   的合成样本——按使用者的定义，这些应当被判偏离。**它同时是最好的阳性对照**：
 *   如果连它都不被判偏离，那这个判据没有在读者要它读的东西。
 *
 * 两个臂用不同指纹（宿主按指纹缓存；同指纹就等于没跑第二个臂）。
 *
 * 用法：
 *   node tools/probes/semantic-compliance-via-host.mjs \
 *     --snapshot tools/probes/.out/structure-f1cd07a6-<指纹>.json \
 *     --url http://127.0.0.1:3098 --cookie /tmp/cj.txt [--seq 11] [--limit 40]
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}
const SNAPSHOT = arg('--snapshot', '')
const URL_BASE = arg('--url', 'http://127.0.0.1:3098')
const COOKIE = arg('--cookie', '/tmp/cj.txt')
const SEQ = Number(arg('--seq', 11))
const BASE = arg('--hashbase', 'deadbeef')
const LIMIT = Number(arg('--limit', 40))
/**
 * `--mutate <回合号>`：只改**那一条**的理解（末尾加个记号），再打一次同一个指纹。
 *
 * 这是**增量判定的实测手段**：第一次冷跑判完全部；第二次把材料里一条改动，
 * 宿主的逐回合缓存应当只重判那一条、其余全部复用（宿主日志里会写
 * `增量判定：新判 1 条 · 复用 N 条`）。整份指纹缓存的做法在这一点上会重判全部。
 */
const MUTATE = Number(arg('--mutate', 0))
/**
 * `--objective-shuffle`：**对调"agent 的理解"**（指令与回复都不动）。
 *
 * 与 `ask-shuffled` 的分工：
 * - `ask-shuffled` 换的是"用户要什么" ⇒ 检验判据有没有读**指令**那一列；
 * - 本臂换的是"agent 理解成什么" ⇒ 检验判据有没有读**理解**那一列。
 *
 * 使用者提醒之后判据改成"**判理解，回复只作佐证**"，那么这一臂就是它的**直接检验**：
 * 若把理解换成别的回合的、而判据的偏离率没有明显上升，说明它其实还在看回复，
 * 那套改法就成了空话。
 */
const OBJECTIVE_SHUFFLE = process.argv.includes('--objective-shuffle')
if (!/^[0-9a-f]{8}$/.test(BASE)) {
  console.error(`✗ --hashbase 必须是 8 位十六进制（宿主的指纹校验形状），收到 ${JSON.stringify(BASE)}`)
  process.exit(2)
}
if (SNAPSHOT === '') {
  console.error('✗ 需要 --snapshot（structure-via-host.mjs 落盘的那份）')
  process.exit(2)
}

const snap = JSON.parse(readFileSync(path.resolve(SNAPSHOT), 'utf8'))
const structure = snap.structure
const sessionId = String(snap.sessionId)
const short = sessionId.replace(/^session-/, '').slice(0, 8)

// ── 材料：用户指令（日志里的 prompt）+ agent 理解（日志里的思考 → goalStatement）──
const { loadSessionTurns } = await import('./session-turns.mjs')
const { semanticMaterial, semanticKey } = await import(path.join(ROOT, 'lib', 'shared', 'semantic.js'))
const { goalStatement } = await import(path.join(ROOT, 'lib', 'shared', 'intent.js'))

const { turns: logTurns } = loadSessionTurns(short, { withSteps: true })
const turnText = new Map(logTurns.map((t) => [t.turn, t.prompt]))
/**
 * `statement` 的复刻：**每一回合都抽**（使用者 2026-10-10 裁定之后宿主就是这么做的），
 * 抽的是该回合**最后一条带思考的 assistant 消息**（宿主 fold 取的就是 `turn/end` 那条）。
 *
 * 选哪些回合去判由 `semanticMaterial` 决定（简报 / 新增节点起点 / 压缩过），
 * 探针不自己筛——那件事只有一处实现。
 */
const statements = new Map()
for (const turn of logTurns) {
  const last = turn.steps[turn.steps.length - 1]
  if (last === undefined) continue
  const statement = goalStatement(last.reasoning)
  if (statement !== '') statements.set(turn.turn, statement)
}

const compactionTurns = snap.compactionTurns ?? []
// **"agent 实际做了什么"**：判据要判"有没有按用户交办的任务做事"，这一列不能缺。
const didText = new Map(logTurns.filter((t) => t.response !== '').map((t) => [t.turn, t.response]))
const material = semanticMaterial(structure, turnText, statements, compactionTurns, didText)
if (material.turns.length === 0) {
  console.error('✗ 材料里没有待判回合（这个会话抽不到 agent 理解）——换一个会话或看 goalStatement 的抽取率')
  process.exit(1)
}
const judged = material.turns.slice(0, LIMIT)
console.log(`会话 ${sessionId}`)
console.log(`材料：${material.tasks.length} 个节点 · ${material.turns.length} 条待判（本次送 ${judged.length} 条）`)
console.log(`压缩回合：${compactionTurns.length === 0 ? '（这一场没有）' : compactionTurns.join('、')}`)
for (const t of judged.slice(0, 2)) {
  console.log(`例：#${t.turn} 指令「${t.ask.slice(0, 40)}」 ← 理解「${t.objective.slice(0, 60)}」`)
}

/** 指令对调：把第 i 条的指令换成第 i+half 条的（理解不动）。 */
const shuffled = judged.map((turn, index) => ({
  ...turn,
  ask: judged[(index + Math.floor(judged.length / 2)) % judged.length].ask,
}))

const post = (arm, turns) => {
  /**
   * 三个臂用**三个不同指纹**。原因：宿主先查"整份材料的指纹缓存"，
   * 命中就直接返回——**同指纹撞不出逐回合缓存的效果**（那只会验到第一层）。
   * 改一条 ⇒ 指纹变 ⇒ 第一层不中 ⇒ 逐回合切分：新判 1 条、复用其余。
   */
  const offset = arm === 'real' ? 0 : arm === 'mutate-1' ? 2 : arm === 'obj-shuffled' ? 3 : 1
  const hash = `${BASE}-${SEQ + offset}`
  const body = { sessionId, hash, tasks: material.tasks, turns }
  const file = path.join('/tmp', `semantic-compliance-${arm}.json`)
  writeFileSync(file, JSON.stringify(body))
  const out = execFileSync('curl', [
    '-s', '-b', COOKIE, '-X', 'POST', `${URL_BASE}/api/intent.semantic`,
    '-H', 'content-type: application/json', '--data-binary', `@${file}`, '--max-time', '300',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const parsed = JSON.parse(out)
  if (parsed.error !== undefined) {
    console.log(`${arm.padEnd(13)} 失败：${parsed.error}`)
    return undefined
  }
  const verdicts = parsed.verdicts ?? []
  const flagged = verdicts.filter((v) => v.match === false)
  console.log(`${arm.padEnd(13)} ${parsed.status} · 判出 ${verdicts.length} 条 · 被标偏离 ${flagged.length}`
    + `（${((flagged.length / Math.max(1, verdicts.length)) * 100).toFixed(0)}%）· ${parsed.votes ?? '?'} 票`
    + (typeof parsed.judged === 'number' ? ` · 新判 ${parsed.judged} 条 / 复用 ${parsed.reused ?? 0} 条` : ''))
  for (const v of flagged.slice(0, 3)) console.log(`                #${v.turn} ${String(v.reason).slice(0, 70)}`)
  return { hash, verdicts }
}

const real = post('real', judged)
let objectiveOut
if (OBJECTIVE_SHUFFLE) {
  const rotated = judged.map((turn, index) => ({
    ...turn,
    objective: judged[(index + Math.floor(judged.length / 2)) % judged.length].objective,
  }))
  objectiveOut = post('obj-shuffled', rotated)
}
if (MUTATE > 0) {
  const mutated = judged.map((turn) => (turn.turn === MUTATE ? { ...turn, objective: `${turn.objective}（改动）` } : turn))
  if (!mutated.some((turn) => turn.turn === MUTATE)) {
    console.log(`（--mutate ${MUTATE}：这次送出去的 ${judged.length} 条里没有这一条，跳过）`)
  } else {
    // 用同一个指纹再打一次：材料只变了一条 ⇒ 期望"新判 1 条 · 复用其余"
    post('mutate-1', mutated)
  }
}
const shuffledOut = post('ask-shuffled', shuffled)

console.log('')
const checks = [
  ['两臂都判成了', real !== undefined && shuffledOut !== undefined],
  ['两臂指纹不同（否则第二臂吃缓存）', real?.hash !== shuffledOut?.hash],
  ['材料不超宿主上限（节点 ≤200、待判 ≤200）', material.tasks.length <= 200 && material.turns.length <= 200,
    `${material.tasks.length}/${material.turns.length}`],
  ['材料指纹非空（调用方据此缓存）', semanticKey(material) !== ''],
]
if (real !== undefined && shuffledOut !== undefined) {
  const rate = (out) => out.verdicts.filter((v) => v.match === false).length / Math.max(1, out.verdicts.length)
  const realRate = rate(real)
  const shufRate = rate(shuffledOut)
  checks.push([`对调指令后的偏离率更高（真 ${(realRate * 100).toFixed(0)}% → 乱 ${(shufRate * 100).toFixed(0)}%）`, shufRate > realRate])
  if (objectiveOut !== undefined) {
    const objRate = rate(objectiveOut)
    checks.push([
      `对调"理解"后偏离率也明显更高（真 ${(realRate * 100).toFixed(0)}% → 乱 ${(objRate * 100).toFixed(0)}%）`,
      objRate > realRate + 0.15,
    ])
  }
}
let bad = 0
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) bad += 1
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`)
process.exit(bad === 0 ? 0 : 1)
