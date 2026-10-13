#!/usr/bin/env node
/**
 * **按节点判**的语义核查基线——决定这条功能留不留得住。
 *
 * ## 为什么要重量一次
 *
 * 旧的语义核查判的是"这条理解与**所在话题组**是不是同一件事"，用的是词面分组当容器。
 * 使用者裁定弃组、只保留 DAG 之后，容器换成**任务节点**。容器变了，判据的区分力
 * 必须重量：旧口径实测**真配对 57% 被标、随机配对 93% 被标**——方向对，但 57% 的
 * 误标率让它只能当提示，不能当判据。
 *
 * ## 两个臂（同一次运行里配对比较）
 *
 * - `real`：把回合配到**它真正挂着的节点**；
 * - `shuffled`：把同一个回合配到**另一个随机节点**（同会话内的确定性乱配）。
 *
 * 判据：`real` 的标记率要明显低于 `shuffled`，才有区分力。若两者接近，
 * 说明模型只是在按词面猜，这条功能该撤。
 *
 * 用法：
 * `node tools/probes/node-check-baseline.mjs --state session-abcd1234.json --sample 12 --votes 2`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.resolve(HERE, '.out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const STATE = arg('--state', 'session-abcd1234.json')
const SAMPLE = Number(arg('--sample', 12))
const VOTES = Number(arg('--votes', 2))
const BATCH = Number(arg('--batch', 12))
const SYS = '你是任务结构审阅者。只回 JSON，不要解释。'

// ── 材料 ────────────────────────────────────────────────────────────────
const state = JSON.parse(readFileSync(path.join(OUTDIR, STATE), 'utf8'))
const short = STATE.replace(/^session-/, '').replace(/\.json$/, '')
const { loadSessionTurns } = await import('./session-turns.mjs')
const turns = loadSessionTurns(short).turns
const textOf = (turn) => turns.find((t) => t.turn === turn)?.prompt ?? ''

/** 节点 → 它名下的回合号（由 membership 反查）。 */
const turnsOfNode = new Map()
for (const [turn, list] of Object.entries(state.membership)) {
  for (const id of list) {
    if (state.nodes[id] === undefined) continue
    const set = turnsOfNode.get(id) ?? []
    set.push(Number(turn))
    turnsOfNode.set(id, set)
  }
}
const nodeIds = [...turnsOfNode.keys()].filter((id) => turnsOfNode.get(id).length > 0)

/** 节点的"代表回合"：取前 3 条（材料要短，判据才在节点本身而不是堆语料）。 */
const samplesOf = (id) => (turnsOfNode.get(id) ?? []).slice(0, 3)

/** 确定性取样：均匀铺开，避免只看开头。 */
function sampleTurns(n) {
  const withNode = []
  for (const id of nodeIds) for (const t of turnsOfNode.get(id)) withNode.push({ turn: t, node: id })
  withNode.sort((a, b) => a.turn - b.turn)
  if (withNode.length <= n) return withNode
  const step = withNode.length / n
  return Array.from({ length: n }, (_, i) => withNode[Math.floor(i * step)])
}

/** 乱配：把每个回合的节点换成"另一个"节点（按序号偏移，确定性）。 */
function shuffled(list) {
  return list.map((item, index) => {
    const others = nodeIds.filter((id) => id !== item.node)
    return { turn: item.turn, node: others[index % others.length] }
  })
}

const renderTasks = (ids) =>
  ids.map((id) => {
    const samples = samplesOf(id).map((t) => `「${textOf(t).slice(0, 40)}」`).join(' ')
    return `${id} ${state.nodes[id].title}：${samples}`
  }).join('\n')

function renderAsk(list) {
  return list.map((item) => `#${item.turn}（挂在 ${item.node}）${textOf(item.turn).slice(0, 60)}`).join('\n')
}

const prompt = (list) => [
  '下面是一场会话的任务结构里的**几个节点**（节点 = 正在弄的那个东西，后面是它名下的代表回合）：',
  renderTasks(nodeIds),
  '',
  '下面是**待判回合**，每条后面写着它被挂到哪个节点：',
  renderAsk(list),
  '',
  '逐条回答：这个回合**是不是在弄它被挂的那个节点所指的那件事**？',
  '- 是 → {"turn":12,"match":true,"reason":"一句话"}',
  '- 不是（挂错了对象、或它其实在说另一件事）→ {"turn":12,"match":false,"reason":"一句话"}',
  '',
  '只回 JSON：{"verdicts":[…]（每条待判回合一条）}',
].join('\n')

async function judge(list) {
  const raw = await complete(SYS, prompt(list), { json: true, maxTokens: 1200 })
  try {
    const parsed = JSON.parse(raw)
    const list2 = Array.isArray(parsed?.verdicts) ? parsed.verdicts : []
    return list2.map((v) => ({ turn: Number(v.turn), match: v.match === true, reason: String(v.reason ?? '') }))
  } catch {
    return []
  }
}

const pairs = sampleTurns(SAMPLE)
console.log(`会话 ${short}：${nodeIds.length} 个节点 · 取 ${pairs.length} 个回合 · 每臂 ${VOTES} 票\n`)

const results = { real: [], shuffled: [] }
for (const arm of ['real', 'shuffled']) {
  const list = arm === 'real' ? pairs : shuffled(pairs)
  const rounds = []
  for (let vote = 0; vote < VOTES; vote += 1) {
    for (let i = 0; i < list.length; i += BATCH) {
      const slice = list.slice(i, i + BATCH)
      rounds.push(await judge(slice))
    }
  }
  results[arm] = rounds.flat()
  const flagged = results[arm].filter((v) => v.match === false).length
  console.log(`  ${arm.padEnd(8)} 判出 ${results[arm].length} 条 · 被标"不是这件事" ${flagged} 条（${(flagged / Math.max(1, results[arm].length) * 100).toFixed(0)}%）`)
}

// 同一条回合被重复判时按多数
function majority(list) {
  const byTurn = new Map()
  for (const v of list) {
    const arr = byTurn.get(v.turn) ?? []
    arr.push(v.match)
    byTurn.set(v.turn, arr)
  }
  const out = new Map()
  for (const [turn, arr] of byTurn) out.set(turn, arr.filter(Boolean).length * 2 > arr.length)
  return out
}
const real = majority(results.real)
const shuf = majority(results.shuffled)
const realFlagged = [...real.values()].filter((m) => m === false).length
const shufFlagged = [...shuf.values()].filter((m) => m === false).length
console.log(`\n按回合取多数后：真配对被标 ${realFlagged}/${real.size} · 乱配对被标 ${shufFlagged}/${shuf.size}`)
console.log(`⇒ ${realFlagged / real.size < 0.35 && shufFlagged / shuf.size > 0.6 ? '有区分力（值得留）' : '区分力不足（该撤或改法）'}`)
console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
