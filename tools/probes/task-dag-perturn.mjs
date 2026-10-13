#!/usr/bin/env node
/**
 * 任务分解版：**不给它一次 12 个新回合**，而是**一个回合一次**问
 * （`research/structured-output-guidance.md` §三 第 4 条：一次一小步、每步可校验）。
 *
 * 与 `task-dag-v2.mjs` 共用第一趟与同一套两轴检查，唯一变量是
 * **第二趟的粒度**：整批 12 回合 vs 逐回合。这样才能说"是粒度的问题"。
 *
 * `--again 21` 可以把**同一个回合**问 N 次，专门看它在 #21 上稳不稳。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-session-a.txt'))
const CUT = Number(arg('--cut', 20))
const REPEAT = arg('--again', '')

const PASS1 = [
  '把一段人与 AI 的会话整理成**任务结构**（允许重叠的图，不是划分，也不是严格的树）。',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务）：',
  '- 换了对象/子任务 → 新节点（同一个大任务下的子任务也算）；',
  '- 同一个东西换侧面/换动作（缓存的设计 ↔ 缓存什么时候做）→ 同一个节点；',
  '- **同一步工作的前后半段要合成一个节点**，不要拆成两个并列的兄弟；',
  '- 单纯的评价/确认/承接（"跑通了就好"）→ 既不是节点，也不该有归属；',
  '- 与任务无关的插话 → 新建 kind="aside" 的小节点；',
  '- 父节点是**纯容器**：父不直接拥有散落回合，那些回合各自成子节点。',
  '',
  '**只回一个 JSON 对象**，形状（务必照这个写，不要用数组装 id）：',
  '{"nodes":{"n1":{"parents":["root"],"title":"12 字内","kind":"task"},',
  '          "n2":{"parents":["n1"],"title":"…","kind":"task"}},',
  ' "membership":{"1":["n1"],"2":["n1","n2"]}}',
  '',
  '- 所有 id 都是**字符串**；根的 parents 写 ["root"]；',
  '- membership 的键是回合号（字符串），值是节点 id 的**列表**——一个回合可以挂多个；',
  '- membership 必须覆盖每一个回合。',
].join('\n')

const SYS = '\u4f60\u662f\u4efb\u52a1\u7ed3\u6784\u6807\u6ce8\u5668\u3002\u53ea\u56de JSON\uff0c\u4e0d\u8981\u89e3\u91ca\u3002'

/** \u9010\u56de\u5408\u90a3\u4e00\u95ee\u3002\u53ea\u7ed9\u8282\u70b9\u6e05\u5355\uff08\u4e0d\u5e26 membership\uff09\uff0c\u95ee\u8fd9\u4e2a\u56de\u5408\u843d\u5728\u54ea\u3002 */
const oneTurn = (nodes, turn, text) => [
  '已有任务结构的**节点清单**：',
  Object.entries(nodes).map(([id, n]) => `${id} [父 ${n.parents.join('/')}] ${n.title}`).join('\n'),
  '',
  `现在来了**一个**新回合：`,
  `#${turn} ${text}`,
  '',
  '问它**在推进哪些东西**（1–3 个落点）：',
  '- 若挂在已有节点上，直接给那些 id；**同一个回合若确实同时在推进两件事，两个 id 都要给**；',
  '- 若在推进的是新东西，用 newNode 建一个（id 用 "n' + turn + '"），并把它算作落点；',
  '- 单纯的评价/确认/承接 → 落点为空数组；',
  '- 只给落点，不要给区间。',
  '',
  '只回 JSON：{"placements":["n3"],"newNode":{"id":"n25","parents":["n10"],"title":"…","kind":"task"}}',
  '（不需要新节点时省略 newNode；落点为空时 placements 给 []）',
].join('\n')

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^#\d+\s*/, '') }))
const render = (list) => list.map((t) => `#${t.turn} ${t.prompt.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
const oldTurns = all.slice(0, CUT)
const newTurns = all.slice(CUT)
const textOf = (t) => t.prompt.replace(/\s+/g, ' ').slice(0, 140)

function ancestorsOf(nodes, id) {
  const seen = new Set(); const queue = [...(nodes[id]?.parents ?? [])]
  while (queue.length > 0) {
    const p = queue.pop()
    if (p === 'root' || seen.has(p)) continue
    seen.add(p); queue.push(...(nodes[p]?.parents ?? []))
  }
  return seen
}
/** 两轴检查（与 v2 同一套，便于逐条对比）。 */
function check(nodes, membership, total) {
  const ids = new Set(Object.keys(nodes))
  const structural = {
    idsResolve: Object.values(membership).every((l) => l.every((id) => ids.has(id))),
    parentsResolve: Object.values(nodes).every((n) => n.parents.every((p) => p === 'root' || ids.has(p))),
    uncovered: [...Array(total)].map((_, i) => String(i + 1)).filter((t) => (membership[t] ?? []).length === 0),
  }
  const of = (t) => membership[String(t)] ?? []
  const chained = (t) => of(t).some((a) => of(t).some((b) => a !== b && ancestorsOf(nodes, b).has(a)))
  const sudo = Object.entries(nodes).filter(([, n]) => /sudo/i.test(n.title))
  return {
    structural,
    sem: {
      sudoMerged: sudo.length === 1 && [23, 24].every((t) => of(t).includes(sudo[0][0])),
      sudoDetail: `sudo 节点 ${sudo.length} 个`,
      only25: of(25).some((id) => /权限/.test(nodes[id]?.title ?? '')) && of(25).every((id) => /权限/.test(nodes[id]?.title ?? '')),
      detail25: of(25).map((id) => nodes[id]?.title).join('+') || '(无)',
      pairs: [22, 26, 27, 28].filter((t) => chained(t)).length,
      multi21: of(21).length >= 2,
      detail21: of(21).map((id) => `${id}:${nodes[id]?.title}`).join(' + ') || '(无)',
    },
  }
}

const raw1 = await complete(SYS, PASS1 + '\n\n' + render(oldTurns), { json: true, maxTokens: 2500 })
const p1 = JSON.parse(raw1)
const nodes = p1.nodes ?? {}
const membership = p1.membership ?? {}

const report = []
for (const t of newTurns) {
  const ask = oneTurn(nodes, t.turn, textOf(t))
  if (!ask.includes(textOf(t))) throw new Error(`\u63d0\u793a\u8bcd\u91cc\u6ca1\u6709\u8fd9\u4e2a\u56de\u5408\u7684\u6b63\u6587\uff08#${t.turn}\uff09`)
  const raw = await complete(SYS, ask, { json: true, maxTokens: 400 })
  let reply; let parseOk = true
  try { reply = JSON.parse(raw) } catch { parseOk = false }
  const created = parseOk && reply.newNode !== undefined && reply.newNode !== null
  if (created) {
    const id = String(reply.newNode.id ?? `n${t.turn}`)
    nodes[id] = { parents: (reply.newNode.parents ?? ['root']).map(String), title: String(reply.newNode.title ?? ''), kind: String(reply.newNode.kind ?? 'task') }
  }
  const placed = parseOk ? (reply.placements ?? []).map(String) : []
  if (placed.length > 0) membership[String(t.turn)] = placed
  report.push({ turn: t.turn, parseOk, placed: placed.length, titles: placed.map((id) => nodes[id]?.title ?? id) })
}
// 逐回合这一趟，落点为空是**回答**（纯评价），不是漏——所以结构轴只看解析与 id
const { structural, sem } = check(nodes, membership, all.length)
const perTurnParse = report.filter((r) => r.parseOk).length
console.log(`逐回合版 · 新增 ${newTurns.length} 回合 · 每回合一次调用`)
for (const r of report) console.log(`  #${r.turn} ${r.parseOk ? '✓' : '✗'} 落点 ${r.placed}：${r.titles.join(' + ') || '(空)'}`)
console.log('\n=== 两轴 ===')
console.log(`结构轴 逐回合解析 ${perTurnParse}/${report.length} · id 解析 ${structural.idsResolve ? '✓' : '✗'} · 父节点解析 ${structural.parentsResolve ? '✓' : '✗'} · 无归属 [${structural.uncovered.join(',')}]`)
console.log(`语义轴 sudo 合并 ${sem.sudoMerged ? '✓' : '✗'}(${sem.sudoDetail}) · #25 只挂权限 ${sem.only25 ? '✓' : '✗'}(${sem.detail25}) · 父子链双命中 ${sem.pairs}/4 · #21 两处 ${sem.multi21 ? '✓' : '✗'}(${sem.detail21})`)

if (REPEAT !== '') {
  const t = all.find((x) => String(x.turn) === REPEAT)
  console.log(`\n=== 只把 #${REPEAT} 问 3 次（看它自己稳不稳） ===`)
  for (let i = 1; i <= 3; i += 1) {
    const raw = await complete(SYS, oneTurn(nodes, t.turn, textOf(t)), { json: true, maxTokens: 400 })
    let r; try { r = JSON.parse(raw) } catch { console.log(`  第 ${i} 次：解析失败`); continue }
    const ids = (r.placements ?? []).map(String)
    console.log(`  第 ${i} 次 落点 ${ids.length}：${ids.map((id) => nodes[id]?.title ?? id).join(' + ') || '(空)'}`)
  }
}
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
