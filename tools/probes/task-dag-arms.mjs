#!/usr/bin/env node
/**
 * 三臂配对对照：**"多归属"到底靠什么才出现**？
 *
 * 起因：`task-dag-incremental.mjs`（v1）唯一一次拿到 `#21` 两处落点与
 * `#22/26/27/28` 父子双命中（使用者人工标为"对"），而它的第二趟提示词里写着
 *
 *   3. 一个回合里若真有两件事，两件都要有落点（例如同一句里**既确认了覆盖率、
 *      又闲聊了一句天气**）
 *
 * —— 这**正好是 #21 的内容**。所以"v1 形状更好"很可能是**把被评测回合的答案
 * 当例子写进了提示词**（teaching to the test），不是形状的功劳。
 *
 * 三臂（同一次运行里**共用同一份基础结构**，只换这一问的措辞）：
 *
 * - `plain`   抽象允许："推进两件事就给两个落点"（无例子）
 * - `exact`   v1 原话：抽象允许 + **本语料里被评测回合**的例子（泄漏）
 * - `generic` 抽象允许 + **语料外**的例子（Nginx 超时 + 天气）
 *
 * 预测：若 `exact` 明显高于 `plain` → 泄漏成立；`generic` 的位置才是有用信息。
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

const BUILD = [
  '把一段人与 AI 的会话整理成**任务结构**（允许重叠的图，不是划分，也不是严格的树）。',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务）：',
  '- 换了对象/子任务 → 新节点；同一个东西换侧面/换动作 → 同一个节点；',
  '- 单纯的评价/确认/承接（"跑通了就好"）→ 既不是节点，也不该有归属；',
  '- 与任务无关的插话 → 新建 kind="aside" 的小节点；',
  '- 父节点是**纯容器**：父不直接拥有散落回合，那些回合各自成子节点。',
  '',
  '**只回一个 JSON 对象**：',
  '{"nodes":{"n1":{"parents":["root"],"title":"12 字内","kind":"task"}},' +
    ' "membership":{"1":["n1"],"2":["n1","n2"]}}',
  'id 用字符串；根的 parents 写 ["root"]；membership 的值是节点 id 的**列表**；必须覆盖每一个回合。',
].join('\n')

const ASK_HEAD = [
  '已有节点清单：',
  '$NODES',
  '',
  '下面是**新增的回合**。逐个回答：这个回合**在推进哪几件事**？',
  '- 每件事给一个落点：已有节点的 id，或在 newNode 里建一个新节点（id 用 "t<回合号>"）；',
  '- 单纯的评价/确认/承接、"好的/收到"**不算推进**；闲聊若有自己的节点也算一个落点；$EVALNOTE',
  '- 不要输出区间，不要解释。',
  '',
  '$TURNS',
  '',
  '只回 JSON，形状：{"placements":{"21":["n5","n9"]},"newNodes":{"t22":{...}}}',
].join('\n')

/** plain：抽象允许，没有任何例子。 */
const PLAIN = [
  '- **一个回合推进两件事就给两个落点，三件就给三个**；只推进一件就给一个。',
].join('\n')

/** exact：v1 的原话（例子就是被评测的回合）。 */
const EXACT = [
  '- **一个回合推进两件事就给两个落点，三件就给三个**；只推进一件就给一个。',
  '- **一个回合里若真有两件事，两件都要有落点**（例如同一句里既确认了覆盖率、',
  '  又闲聊了一句天气 → 分别落在"覆盖率"与一个零散节点）。',
  '- **同一条线的父与子同时命中是允许的**，不必刻意避免。',
  '- 同一步工作的前后半段要合成一个节点：例如"sudo 为什么写两次"与"改成一次并验证"',
  '  是同一个节点（如 sudo 处理），不要拆成两个并列的兄弟。',
  '- 只推进一件事的回合就单一归属——不要为了"信息完整"而多挂。',
].join('\n')

/** generic：同样的许可，但例子**不在本语料里**（检验例子能不能泛化）。 */
const GENERIC = [
  '- **一个回合推进两件事就给两个落点，三件就给三个**；只推进一件就给一个。',
  '- 例：用户说"这个超时改成 30 秒吧，对了明天记得带伞" —— 那是两件事，',
  '  要分别落在超时那个节点和一个零散节点上；',
  '- 例：用户说"配置改完了，顺便把日志也看下" —— 配置与其所属的下级都算，**父与子可以同时命中**；',
  '- 只推进一件事的回合就单一归属——不要为了"信息完整"而多挂。',
].join('\n')

/**
 * `chitchat`：**唯一变量是那一句负面措辞**——把"闲聊"和"评价/确认"并列写进
 * "不算推进"。`task-dag-split.mjs` 的 A 问就是这句，而它 `#21` 只有 1/3。
 */
const CHITCHAT = { replaceEval: true }

const ARMS = { plain: PLAIN, exact: EXACT, generic: GENERIC, chitchat: CHITCHAT }
const SELECTED = (arg('--arms', 'plain,exact,generic')).split(',').map((x) => x.trim())

const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))
const render = (list) => list.map((t) => `#${t.turn} ${t.prompt.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n')
const nodeList = (nodes) => Object.entries(nodes).map(([id, n]) => `${id} [父 ${n.parents.join('/')}] ${n.title}`).join('\n')

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

/** 只看**归属那一问**的结果（合并是另一问的事，这里不掺进来）。 */
function measure(nodes, membership) {
  const of = (t) => membership[String(t)] ?? []
  const title = (id) => nodes[id]?.title ?? '??'
  const chained = (t) => of(t).some((a) => of(t).some((b) => a !== b && ancestorsOf(nodes, b).has(a)))
  const ids = new Set(Object.keys(nodes))
  return {
    multi21: of(21).length >= 2,
    detail21: of(21).map(title).join(' + ') || '(空)',
    parent: [22, 26, 27, 28].filter((t) => of(t).length >= 2).length,
    chain: [22, 26, 27, 28].filter((t) => chained(t)).length,
    detail22: of(22).map(title).join(' + ') || '(空)',
    detail26: of(26).map(title).join(' + ') || '(空)',
    uncovered: [...Array(all.length)].map((_, i) => String(i + 1)).filter((t) => of(t).length === 0),
    idsResolve: Object.values(membership).every((l) => l.every((id) => ids.has(id))),
  }
}

async function askArm(nodes, variant) {
  let head = ASK_HEAD
  if (ARMS[variant].replaceEval === true) {
    head = head.replace(
      '- 单纯的评价/确认/承接、"好的/收到"**不算推进**；闲聊若有自己的节点也算一个落点；',
      '- 单纯的评价/确认/承接、"好的/收到"、闲聊**不算推进**，但闲聊若有自己的节点也算一个落点；',
    ).replace('$EVALNOTE', '')
  } else {
    head = head.replace('$EVALNOTE', '')
    head = head.replace('- 单纯的评价/确认/承接', `${ARMS[variant]}\n- 单纯的评价/确认/承接`)
  }
  const prompt = head.replace('$NODES', nodeList(nodes)).replace('$TURNS', render(all.slice(CUT)))
  const raw = await complete(SYS, prompt, { json: true, maxTokens: 1600 })
  let ok = true
  let reply
  try { reply = JSON.parse(raw) } catch { ok = false }
  const nextNodes = structuredClone(nodes)
  const membership = {}
  if (ok) {
    for (const [id, n] of Object.entries(reply.newNodes ?? {})) {
      nextNodes[String(id)] = { parents: (n.parents ?? ['root']).map(String), title: String(n.title ?? ''), kind: String(n.kind ?? 'task') }
    }
    for (const [turn, list] of Object.entries(reply.placements ?? {})) {
      const keep = (list ?? []).map(String).filter((id) => nextNodes[id] !== undefined)
      if (keep.length > 0) membership[String(turn)] = keep
    }
  }
  return { ok, nodes: nextNodes, membership }
}

const totals = Object.fromEntries(SELECTED.map((v) => [v, []]))
for (let run = 1; run <= RUNS; run += 1) {
  const base = JSON.parse(await complete(SYS, `${BUILD}\n\n${render(all.slice(0, CUT))}`, { json: true, maxTokens: 2500 }))
  const baseNodes = base.nodes ?? {}
  const baseMembership = base.membership ?? {}
  console.log(`\n第 ${run} 次（基础结构 ${Object.keys(baseNodes).length} 节点）`)
  for (const variant of SELECTED) {
    const r = await askArm(baseNodes, variant)
    const merged = { ...baseMembership, ...r.membership }
    const m = measure(r.nodes, merged)
    totals[variant].push(m)
    console.log(`  ${variant.padEnd(8)} 解析 ${r.ok ? '✓' : '✗'} · #21 两处 ${m.multi21 ? '✓' : '✗'}(${m.detail21}) · 22/26/27/28 两处 ${m.parent}/4 · 其中父子链 ${m.chain}/4 · 无归属 [${m.uncovered.join(',')}]`)
    if (process.argv.includes('--dump')) console.log(`           #22 ${m.detail22}\n           #26 ${m.detail26}`)
  }
}

const rate = (variant, key) => `${totals[variant].filter((m) => m[key] === true).length}/${totals[variant].length}`
const avg = (variant, key) => (totals[variant].reduce((s, m) => s + m[key], 0) / totals[variant].length).toFixed(1)
console.log('\n=== 三臂（每臂 3 次，配对：同一次运行共用基础结构） ===')
for (const variant of SELECTED) {
  console.log(`${variant.padEnd(8)} #21 两处 ${rate(variant, 'multi21')} · 22/26/27/28 两处 ${avg(variant, 'parent')}/4 · 父子链 ${avg(variant, 'chain')}/4 · 无归属 平均 ${(totals[variant].reduce((s, m) => s + m.uncovered.length, 0) / totals[variant].length).toFixed(1)} 个`)
}
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
