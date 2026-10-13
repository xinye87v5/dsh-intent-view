#!/usr/bin/env node
/**
 * 把**归属**与**合并**拆成两次调用（假设：ops 词汇表把模型偏置成"一个回合一个落点"）。
 *
 * 从两轮实测倒推出来的假设：
 * - `task-dag-v2.mjs`（整批 + 显式 ops）结构 3/3，但多归属掉到 1.7/4；
 * - `task-dag-perturn.mjs`（逐回合、无 ops）多归属 0/4，而且**合并能力整个消失**
 *   （`sudo 节点 3 个`）。
 *
 * ⇒ **拆解（一次一小步）与修订（合并/改名）是两种操作**：
 *   逐回合那一问只能*新增*，永远没法把两个兄弟合成一个；
 *   而带 ops 的整批那一问，例子里的 `assign` 只挂一个节点，等于示范了"单一归属"。
 *   这次分成两问，且**合并那一问只看节点、不看回合**。
 *
 * ## 跑法（**3 次分布必须让第一趟也重跑**）
 *
 * `node tools/probes/task-dag-split.mjs --runs 3`           ← 默认：第一趟每次重跑
 * `node tools/probes/task-dag-split.mjs --reuse-base`       ← 复用同一份基础结构，只测 A/B 的稳定性
 * `node tools/probes/task-dag-split.mjs --parent-ok`        ← 换"父子都要挂"那句措辞（实测更差）
 *
 * ⚠️ 我第一版默认复用第一趟，于是拿到一个**假性的 3/3**：A/B 在 temperature 0 下
 * 完全确定，复用同一份基础结构时"三次一致"只证明 A/B 稳，不证明结论可复现。
 * 去掉复用后同一配置变成 1/3。详见 `research/structured-output-attempt.md` 第三节第 4 条。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-session-a.txt'))
const CUT = Number(arg('--cut', 20))
const RUNS = Number(arg('--runs', 3))

const SYS = '你是任务结构标注器。只回 JSON，不要解释。'

const PARENT_OK = process.argv.includes('--parent-ok')

/**
 * 两条措辞只在"父节点能不能同时命中"上不同，而实测它们**把分数打反了**，所以留成开关。
 *
 * - 默认（`纯容器`）：sudo 合并 3/3、#21 两处 3/3（3 次完全一致）；
 * - `--parent-ok`（`父子都要挂`）：sudo 1/3 与 2/3（两次各自 3 次）、#21 两处 0/3 与 0/3。
 *
 * ⚠️ 两种配置的**第一趟各只跑了一次**（三次复用同一份基础结构），
 * 所以这个差**不能当成纯效应**——只有 A/B 两问有 3 次分布。
 */
const PARENT_RULE = PARENT_OK
  ? [
      '- 父节点是**容器**，但**不是空壳**：一个回合若同时在推进"父所指的那件事"和"子所指的那一步"，',
      '  **父与子都要挂**（这是允许且常见的）；只有当父只是个大类、回合实际在弄某个子节点时才只挂子。',
    ]
  : ['- 父节点是**纯容器**：父不直接拥有散落回合，那些回合各自成子节点。']

const BUILD = [
  '把一段人与 AI 的会话整理成**任务结构**（允许重叠的图，不是划分，也不是严格的树）。',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务）：',
  '- 换了对象/子任务 → 新节点；同一个东西换侧面/换动作 → 同一个节点；',
  '- 单纯的评价/确认/承接（"跑通了就好"）→ 既不是节点，也不该有归属；',
  '- 与任务无关的插话 → 新建 kind="aside" 的小节点；',
  ...PARENT_RULE,
  '',
  '**只回一个 JSON 对象**：',
  '{"nodes":{"n1":{"parents":["root"],"title":"12 字内","kind":"task"}},' +
    ' "membership":{"1":["n1"],"2":["n1","n2"]}}',
  'id 用字符串；根的 parents 写 ["root"]；membership 的键是回合号，值是节点 id 的**列表**；',
  'membership 必须覆盖每一个回合。',
].join('\n')

/** A：只判归属。**不提供任何 ops 词汇表**——问的是"推进了哪几件事"。 */
const ASSIGN = [
  '已有节点清单：',
  '$NODES',
  '',
  '下面是**新增的回合**。逐个回答：这个回合**在推进哪几件事**？',
  '- 每件事给一个落点：已有节点的 id，或在 newNode 里建一个新节点（id 用 "t<回合号>"）；',
  '- **一个回合推进两件事就给两个落点，三件就给三个**；只推进一件就给一个；',
  '- 单纯的评价/确认/承接、"好的/收到"、闲聊**不算推进**，但闲聊若有自己的节点也算一个落点；',
  '- 不要输出区间，不要解释。',
  '',
  '$TURNS',
  '',
  '只回 JSON，形状：{"placements":{"21":["n5","n9"],"22":["n3"]},' +
    ' "newNodes":{"t22":{"parents":["n3"],"title":"12 字内"}}}',
  '（某回合没有落点就给它空数组；newNodes 里声明的 id 才算存在）',
].join('\n')

/** B：只判**节点**层面的整理。合并只能在这一问里发生。 */
const CONSOLIDATE = [
  '下面是任务结构的**节点清单**（只列节点，不含回合归属）：',
  '$NODES',
  '',
  '只做**节点层面的整理**，输出 ops 数组：',
  '- 若两个（或更多）节点其实是**同一步工作的前后半段**、或同一件事的两种说法，',
  '  用 {"op":"merge","from":["n7","n9"],"into":"n7","title":"合并后的名字"} 合掉；',
  '- 若某个节点的名字只是**临时描述**、不代表正在弄的东西，用',
  '  {"op":"retitle","id":"n7","title":"..."} 改成对象的说法；',
  '- 只改必要的，**不要为了少而合并**；同一件事的上下级**不要**合并（父是容器）。',
  '',
  '只回 JSON：{"ops":[...]}（没有要改的就回 {"ops":[]}）',
].join('\n')

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))
const render = (list) => list.map((t) => `#${t.turn} ${t.prompt.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n')
const nodeList = (nodes) => Object.entries(nodes).map(([id, n]) => `${id} [父 ${n.parents.join('/')}] ${n.title}`).join('\n')

function applyConsolidation(nodes, membership, ops) {
  const unknown = []
  for (const op of ops ?? []) {
    const kind = String(op?.op ?? '')
    if (kind === 'merge') {
      const into = String(op.into)
      const from = (op.from ?? []).map(String).filter((id) => id !== into)
      if (nodes[into] === undefined) continue
      for (const id of from) delete nodes[id]
      const moved = new Set([into, ...from])
      for (const [turn, ids] of Object.entries(membership)) {
        const hit = ids.some((id) => moved.has(id))
        if (!hit) continue
        membership[turn] = [...new Set([...ids.filter((id) => !moved.has(id)), into])]
      }
      if (op.title !== undefined) nodes[into].title = String(op.title)
      if (op.parents !== undefined) nodes[into].parents = op.parents.map(String)
    } else if (kind === 'retitle') {
      const n = nodes[String(op.id)]
      if (n !== undefined && op.title !== undefined) n.title = String(op.title)
    } else if (kind === 'reparent') {
      const n = nodes[String(op.id)]
      if (n !== undefined && op.parents !== undefined) n.parents = op.parents.map(String)
    } else unknown.push(kind)
  }
  return unknown
}

function ancestorsOf(nodes, id) {
  const seen = new Set()
  const queue = [...(nodes[id]?.parents ?? [])]
  while (queue.length > 0) {
    const p = queue.pop()
    if (p === 'root' || seen.has(p)) continue
    seen.add(p)
    queue.push(...(nodes[p]?.parents ?? []))
  }
  return seen
}

function measure(nodes, membership, total, turns) {
  const ids = new Set(Object.keys(nodes))
  const of = (t) => membership[String(t)] ?? []
  const title = (id) => nodes[id]?.title ?? '??'
  const chained = (t) => of(t).some((a) => of(t).some((b) => a !== b && ancestorsOf(nodes, b).has(a)))
  const sudo = Object.entries(nodes).filter(([, n]) => /sudo/i.test(n.title))
  const perm = of(25).filter((id) => /权限/.test(title(id)))
  return {
    structural: {
      idsResolve: Object.values(membership).every((l) => l.every((id) => ids.has(id))),
      parentsResolve: Object.values(nodes).every((n) => n.parents.every((p) => p === 'root' || ids.has(p))),
      uncovered: [...Array(total)].map((_, i) => String(i + 1)).filter((t) => of(t).length === 0),
    },
    sem: {
      sudo: sudo.length === 1 && [23, 24].every((t) => of(t).includes(sudo[0][0])),
      sudoDetail: `${sudo.length} 个(${sudo.map(([, n]) => n.title).join('/') || '无'})`,
      only25: perm.length > 0 && perm.length === of(25).length,
      detail25: of(25).map((id) => title(id)).join(' + ') || '(空)',
      multi21: of(21).length >= 2,
      detail21: of(21).map((id) => title(id)).join(' + ') || '(空)',
      multi: [22, 26, 27, 28].filter((t) => of(t).length >= 2).length,
      chain: [22, 26, 27, 28].filter((t) => chained(t)).length,
      multiDetail: [22, 26, 27, 28].map((t) => `#${t}:${of(t).length}`).join(' '),
    },
    nodes, membership,
  }
}

const REUSE = process.argv.includes('--reuse-base')
console.log(`父节点措辞：${PARENT_OK ? '父子可同时命中(--parent-ok)' : '纯容器(默认)'}｜第一趟：${REUSE ? '复用同一份(--reuse-base)' : '每次重跑'}`)

/** 第一趟也每次重跑——否则"3 次"只是在同一个基础结构上重复 A/B，分布会假性一致。 */
let frozen = null
async function buildBase() {
  if (REUSE && frozen !== null) return frozen
  const raw = await complete(SYS, `${BUILD}\n\n${render(all.slice(0, CUT))}`, { json: true, maxTokens: 2500 })
  frozen = JSON.parse(raw)
  return frozen
}

const runs = []
for (let run = 1; run <= RUNS; run += 1) {
  const base = await buildBase()
  const nodes = structuredClone(base.nodes ?? {})
  const membership = structuredClone(base.membership ?? {})
  const rawA = await complete(SYS, ASSIGN.replace('$NODES', nodeList(nodes)).replace('$TURNS', render(all.slice(CUT))), { json: true, maxTokens: 1600 })
  let a; let parseA = true
  try { a = JSON.parse(rawA) } catch { parseA = false }
  if (parseA) {
    for (const [id, n] of Object.entries(a.newNodes ?? {})) {
      nodes[String(id)] = { parents: (n.parents ?? ['root']).map(String), title: String(n.title ?? ''), kind: String(n.kind ?? 'task') }
    }
    for (const [turn, list] of Object.entries(a.placements ?? {})) {
      const keep = (list ?? []).map(String).filter((id) => nodes[id] !== undefined)
      if (keep.length > 0) membership[String(turn)] = keep
    }
  }
  const rawB = await complete(SYS, CONSOLIDATE.replace('$NODES', nodeList(nodes)), { json: true, maxTokens: 1200 })
  let b; let parseB = true
  try { b = JSON.parse(rawB) } catch { parseB = false }
  const unknown = parseB ? applyConsolidation(nodes, membership, b.ops) : []
  const m = measure(nodes, membership, all.length, all)
  runs.push({ parseA, parseB, unknown, ...m })
  console.log(`第 ${run} 次  基础 ${Object.keys(base.nodes ?? {}).length} 节点 · A 解析 ${parseA ? '✓' : '✗'} · B 解析 ${parseB ? '✓' : '✗'} · 未实现 op [${unknown.join(',')}]`)
  console.log(`         结构：id ${m.structural.idsResolve ? '✓' : '✗'} · 父 ${m.structural.parentsResolve ? '✓' : '✗'} · 无归属 [${m.structural.uncovered.join(',')}]`)
  console.log(`         语义：sudo ${m.sem.sudo ? '✓' : '✗'}${m.sem.sudoDetail} · #25 只挂权限 ${m.sem.only25 ? '✓' : '✗'}(${m.sem.detail25}) · #21 两处 ${m.sem.multi21 ? '✓' : '✗'}(${m.sem.detail21}) · 22/26/27/28 两处 ${m.sem.multi}/4 ${m.sem.multiDetail} · 其中父子链 ${m.sem.chain}/4`)
  if (process.argv.includes('--dump')) {
    const show = (t) => (membership[String(t)] ?? []).map((id) => `${id}:${nodes[id]?.title}`).join(' + ') || '(空)'
    console.log(`         #22 ${show(22)}\n         #25 ${show(25)}\n         #26 ${show(26)}\n         #27 ${show(27)}\n         #28 ${show(28)}`)
    console.log('         节点：' + Object.entries(nodes).map(([id, n]) => `${id}(${n.parents.join('/')})=${n.title}`).join('  '))
  }
}

const rate = (f) => `${runs.filter(f).length}/${runs.length}`
console.log('\n=== 两轴（3 次分布） ===')
console.log(`结构轴 A 解析 ${rate((r) => r.parseA)} · B 解析 ${rate((r) => r.parseB)} · id 解析 ${rate((r) => r.structural.idsResolve)} · 父节点 ${rate((r) => r.structural.parentsResolve)}`)
console.log(`语义轴 sudo 合并 ${rate((r) => r.sem.sudo)} · #25 只挂权限 ${rate((r) => r.sem.only25)} · #21 两处 ${rate((r) => r.sem.multi21)} · 22/26/27/28 两处 平均 ${(runs.reduce((s, r) => s + r.sem.multi, 0) / runs.length).toFixed(1)}/4`)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
