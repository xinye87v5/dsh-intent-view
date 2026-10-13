#!/usr/bin/env node
/**
 * 任务结构 v2：按调研改形状，并**两轴分开评测**（`research/structured-output-guidance.md`）。
 *
 * ## 改了什么（都有出处）
 *
 * 1. **一切用稳定字符串键，不用数组下标**（JSON Whisperer 的 EASE）：
 *    `nodes` 是字典（`"n1"`）、`membership` 是字典（`"21"` → 节点列表）；
 * 2. **ops 是显式操作列表**，含 **`merge`**——否则"该合并却拆成兄弟"
 *    这个错**在表达层面就修不了**（上一版正是缺它）；
 * 3. **两轴分开量**（arXiv:2609.23742）：结构（能不能解析、id 是否解析得出、覆盖）
 *    与语义（八条人工标记推出的五条规则）**不混着数**；
 * 4. **跑 N 次比分布**，不拿单次结果下结论（我自己前面栽过）。
 *
 * ## 用法
 *
 * `node tools/probes/task-dag-v2.mjs --turns research/synthetic-session-a.txt --cut 20 --runs 3`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-session-a.txt'))
const CUT = Number(arg('--cut', 20))
const RUNS = Number(arg('--runs', 3))

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
  '- membership 的键是回合号（字符串），值是节点 id 的列表；',
  '- membership 必须覆盖每一个回合。',
].join('\n')

const PASS2 = [
  '这是**已有的任务结构**，以及**新增加的回合**。只输出**修改**，不要重写整份。',
  '',
  '可用操作（ops 数组，按需使用）：',
  '- {"op":"newNode","id":"n9","parents":["n1"],"title":"…","kind":"task"}',
  '- {"op":"assign","turn":"25","nodes":["n3","n9"]}      ← 覆盖该回合的归属（这就是多归属）',
  '- {"op":"merge","from":["n3","n7"],"into":"n3","title":"sudo 处理"}  ← 把两个兄弟合成一个',
  '- {"op":"reparent","id":"n3","parents":["n1"]}',
  '- {"op":"retitle","id":"n3","title":"…"}',
  '',
  '判据：',
  '1. **同一步工作的前后半段**（"sudo 为什么写两次"与"改成一次并验证"）',
  '   该是**同一个节点**——用 merge 把它们合成一个（如 sudo 处理）。',
  '2. 单纯的评价/确认/承接**不产生节点、也不产生归属**；',
  '3. 一个回合里若真有两件事，两件都要有落点；',
  '4. 同一条线的父与子同时命中是允许的；',
  '5. 只推进一件事的回合就单一归属。',
  '',
  '只回 JSON：{"ops":[…]}；新回合都要有归属（用 assign 或 newNode+assign）。',
].join('\n')

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^#\d+\s*/, '') }))
const render = (list) => list.map((t) => `#${t.turn} ${t.prompt.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
const oldTurns = all.slice(0, CUT)
const newTurns = all.slice(CUT)

/** 应用 ops（merge 会真的把 from 的归属并进 into）。 */
function applyOps(state, ops) {
  for (const op of ops ?? []) {
    const kind = String(op?.op ?? '')
    if (kind === 'newNode') {
      state.nodes[String(op.id)] = {
        parents: (op.parents ?? ['root']).map(String),
        title: String(op.title ?? ''), kind: String(op.kind ?? 'task'),
      }
      for (const t of op.turns ?? []) state.membership[String(t)] = [String(op.id)]
    } else if (kind === 'assign') {
      const turn = String(op.turn)
      const ids = (op.nodes ?? []).map(String)
      if (ids.length > 0) state.membership[turn] = ids
    } else if (kind === 'merge') {
      const into = String(op.into)
      const from = (op.from ?? []).map(String).filter((id) => id !== into)
      if (state.nodes[into] === undefined) continue
      for (const id of from) delete state.nodes[id]
      const moved = new Set([into, ...from])
      for (const [turn, ids] of Object.entries(state.membership)) {
        const kept = ids.filter((id) => !moved.has(id))
        const hit = ids.some((id) => moved.has(id))
        state.membership[turn] = hit ? [...new Set([...kept, into])] : kept
        if (state.membership[turn].length === 0) delete state.membership[turn]
      }
      if (op.title !== undefined) state.nodes[into].title = String(op.title)
      if (op.parents !== undefined) state.nodes[into].parents = op.parents.map(String)
    } else if (kind === 'reparent') {
      const node = state.nodes[String(op.id)]
      if (node !== undefined && op.parents !== undefined) node.parents = op.parents.map(String)
    } else {
      state.unknownOps = [...(state.unknownOps ?? []), kind]
    }
    if (kind === 'retitle') {
      const node = state.nodes[String(op.id)]
      if (node !== undefined && op.title !== undefined) node.title = String(op.title)
    }
  }
}

/** 结构轴：能不能解析（**不许修**）、id 解析得出、覆盖完整。 */
function structural(state, total) {
  const ids = new Set(Object.keys(state.nodes))
  const idsResolve = Object.values(state.membership).every((list) => list.every((id) => ids.has(id)))
  const parentsResolve = Object.values(state.nodes).every((n) => n.parents.every((p) => p === 'root' || ids.has(p)))
  const uncovered = [...Array(total)].map((_, i) => String(i + 1)).filter((t) => (state.membership[t] ?? []).length === 0)
  return { idsResolve, parentsResolve, uncovered }
}

/** 语义轴：八条人工标记推出的五条，落成四条可判的检查。 */
function semantic(state) {
  const nodesOf = (turn) => (state.membership[String(turn)] ?? []).map((id) => state.nodes[id]).filter(Boolean)
  const titleOf = (turn) => nodesOf(turn).map((n) => n.title).join(' + ')
  const sudo = Object.entries(state.nodes).filter(([, n]) => /sudo/i.test(n.title))
  const sudoOk = sudo.length === 1 && [23, 24].every((t) => state.membership[String(t)]?.includes(sudo[0][0]))
  const stray25 = nodesOf(25).filter((n) => !/权限/.test(n.title))
  const perm25 = nodesOf(25).some((n) => /权限/.test(n.title))
  const idsOf = (turn) => state.membership[String(turn)] ?? []
  const ancestorsOf = (id) => {
    const seen = new Set()
    const queue = [...(state.nodes[id]?.parents ?? [])]
    while (queue.length > 0) {
      const p = queue.pop()
      if (p === 'root' || seen.has(p)) continue
      seen.add(p)
      queue.push(...(state.nodes[p]?.parents ?? []))
    }
    return seen
  }
  const chained = (turn) => idsOf(turn).some((a) => idsOf(turn).some((b) => a !== b && ancestorsOf(b).has(a)))
  const pairs = [22, 26, 27, 28].filter((t) => chained(t)).length
  return {
    sudoMerged: sudoOk, sudoDetail: `sudo 节点 ${sudo.length} 个（${sudo.map(([, n]) => n.title).join('/') || '无'}）`,
    only25: perm25 && stray25.length === 0, detail25: `#25=${titleOf(25)}`,
    pairsKept: pairs, multi21: nodesOf(21).length >= 2, detail21: `#21=${titleOf(21)}`,
  }
}

const structRuns = []
const semRuns = []
console.log(`合成语料 ${path.basename(TURNS_FILE)} · 已有 ${oldTurns.length} · 新增 ${newTurns.length} · 跑 ${RUNS} 次\n`)
for (let run = 1; run <= RUNS; run += 1) {
  const raw1 = await complete(PASS1, render(oldTurns), { json: true, maxTokens: 2500, temperature: 0 })
  let p1
  try { p1 = JSON.parse(raw1) } catch { console.log(`第 ${run} 次：第一趟解析失败（**结构轴**）`); structRuns.push({ parse: false }); continue }
  const state = { nodes: p1.nodes ?? {}, membership: p1.membership ?? {} }
  const raw2 = await complete(PASS2, `已有结构：\n${JSON.stringify({ nodes: state.nodes, membership: state.membership })}\n\n新回合：\n${render(newTurns)}`, { json: true, maxTokens: 2500, temperature: 0 })
  let delta
  let parseOk = true
  try { delta = JSON.parse(raw2) } catch { parseOk = false }
  if (parseOk) applyOps(state, delta.ops)
  const s = structural(state, all.length)
  if (process.argv.includes('--dump')) {
    const of = (t) => (state.membership[String(t)] ?? []).map((id) => `${id}:${state.nodes[id]?.title ?? '??'}`).join(' | ') || '(\u65e0\u5f52\u5c5e)'
    console.log('  \u8282\u70b9\uff1a' + Object.entries(state.nodes).map(([id, n]) => `${id}(${n.parents.join('/')})=${n.title}`).join('  '))
    for (const t of [20, 21, 22, 23, 24, 25, 26, 27, 28]) console.log(`  #${t} -> ${of(t)}`)
    console.log('  \u65e0\u5f52\u5c5e\uff1a' + s.uncovered.join(','))
  }
  const sem = parseOk ? semantic(state) : null
  structRuns.push({ parse: parseOk, ...s })
  if (sem !== null) semRuns.push(sem)
  console.log(
    `第 ${run} 次  结构：解析 ${parseOk ? '✓' : '✗'} · id ${s.idsResolve ? '✓' : '✗'} · ` +
      `父 ${s.parentsResolve ? '✓' : '✗'} · 无归属 [${s.uncovered.join(',')}]` +
      (sem === null ? '' : `  语义：sudo 合并 ${sem.sudoMerged ? '✓' : '✗'}(${sem.sudoDetail}) · #25 只挂权限 ${sem.only25 ? '✓' : '✗'} · 父子链双命中 ${sem.pairsKept}/4 · 未实现的 op [${(state.unknownOps ?? []).join(',')}] · #21 两处 ${sem.multi21 ? '✓' : '✗'}`),
  )
}

const rate = (key) => `${structRuns.filter((r) => r[key] === true).length}/${structRuns.length}`
const semRate = (key) => `${semRuns.filter((r) => r[key] === true).length}/${semRuns.length}`
console.log('\n=== 两轴分开报（这次不混着数） ===')
console.log(`结构轴 解析 ${rate('parse')} · id 解析 ${rate('idsResolve')} · 父节点解析 ${rate('parentsResolve')} · 每次无归属回合 ${
  structRuns.map((r) => (r.uncovered ?? []).length).join('/')}`)
console.log(`语义轴 sudo 合并 ${semRate('sudoMerged')} · #25 只挂权限 ${semRate('only25')} · #21 两处 ${semRate('multi21')}` +
  ` · 父子链双命中 平均 ${(semRuns.reduce((sum, r) => sum + r.pairsKept, 0) / Math.max(1, semRuns.length)).toFixed(1)}/4`)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
