#!/usr/bin/env node
/**
 * 让模型把一场会话输出成**任务树**——不是被切开的线段。
 *
 * ## 为什么换成树
 *
 * 标定（`research/agenda-calibration.md`）取出的判据是
 * **"正在弄的那个东西变了没有"**，而它区分三种切换（下钻/上浮/平跳），
 * 还包含"离开又回来"。**平铺分段表达不了这些**：
 *
 * - 分不出**兄弟**（logrotate → 环境变量）与**另一根枝**（部署 → 招聘）；
 * - 表达不了**离开又回来**（天气插话后回到任务）；
 * - 而"同一对象换侧面"（缓存设计 ↔ 缓存排期）本来就不该断开。
 *
 * 而模型**本来就在输出树**：上一轮它给的标题里，前六个明显都是"个人资料"下的
 * 兄弟子任务——是我在提示词里要求"按序、不重叠"，把树拍平了。
 *
 * ## 输出形状：平铺的节点表 + `parent`
 *
 * 不用嵌套 JSON：嵌套难解析、也难在终端里读。用 `{id, parent, title, from, to}`
 * 的平铺表，缩进由渲染端算——**解析出错的风险小一个量级**。
 *
 * 用法：`node tools/probes/task-tree.mjs [会话前缀，默认取最近不活跃的那个]`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
import { complete, usage } from '../llm-client.mjs'
import { statSync } from 'node:fs'

const PREFIX = process.argv[2] ?? ''

const SYSTEM = [
  '你在把一段人与 AI 的会话整理成**任务树**——像给一项工作的过程建目录。',
  '',
  '## 什么算一个节点',
  '',
  '判据是"**正在弄的那个东西**"（对象/子任务），不是"话题词"，也不是"说话的角度"：',
  '',
  '- **算新节点**：换了对象或子任务。同一个大任务下的子任务也算——',
  '  "配置 logrotate" 与 "环境变量为什么有两套" 是同一个部署任务下的两个兄弟。',
  '- **不算新节点**：同一个东西换个侧面或换个动作，留在同一个节点里——',
  '  "缓存方案的设计" 与 "缓存这块什么时候做" 是同一件事。',
  '- 汇总、纠正、确认都留在当前节点。',
  '',
  '## 三种移动（这是树，不是一条链）',
  '',
  '1. **下钻**：进子任务；',
  '2. **上浮**：回父任务；',
  '3. **平跳**：换兄弟，或另起一根枝。',
  '',
  '**关键：一个节点可以有多个不连续的区间。** 如果用户中途去处理一件别的事、',
  '然后又回到原来的事，那么原来的那个节点应当有**两个区间**，',
  '而那件"别的事"是一个**叉出去**的节点（挂在被离开的节点下）。',
  '**不要**因为中间插了一件别的事就把原节点拆成两个不同的节点。',
  '',
  '## 根要少',
  '',
  '根回答的是"这一整场在忙哪几件事"。**通常只有两三个根**，',
  '不要把同一件事的不同阶段拆成并列的根。',
  '收尾/交接（例如最后整理文件、确认遗留项）可以单独成一个节点。',
  '',
  '## 输出',
  '',
  '只回 JSON：',
  '{"nodes":[{"id":1,"parent":0,"title":"12 字内的节点名","ranges":[[1,35],[51,93]]}]}',
  '',
  '- parent=0 表示根；id 从 1 递增；',
  '- ranges 是**区间数组**（每个区间是 [起始回合号, 结束回合号]，含两端）；',
  '  连续的区间写成一项即可，被离开又回来则写成多项；',
  '- 子节点的区间应当落在父节点的区间范围内；',
  '- 回合号从 1 开始，覆盖到最后一个回合。',
].join('\n')

// `--turns <file>`：用**合成的回合**跑（每行一条 `#N 用户发言`）。
// 合成语料的好处：判断者对它没有记忆，所以他的判断是**判据**而不是回忆。
const TURNS_FILE = process.argv.includes('--turns') ? process.argv[process.argv.indexOf('--turns') + 1] : null
const sessions = collectSessions()
let target = null
for (const candidate of sessions) {
  if (PREFIX !== '' && !candidate.id.includes(PREFIX)) continue
  let usable
  try { usable = usableTurns(buildTurns(readEvents(candidate.log))) } catch { continue }
  if (usable.turns.length < 40) continue
  target = { candidate, turns: usable.turns }
  if (PREFIX !== '') break
}
if (TURNS_FILE !== null) {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(TURNS_FILE, 'utf8')
  const turns = text.split('\n').filter((l) => l.trim() !== '').map((l, i) => ({
    turn: i + 1, prompt: l.replace(/^#\d+\s*/, ''), response: '', early: '', steps: [], toolArgs: [],
  }))
  target = { candidate: { id: TURNS_FILE, log: TURNS_FILE, bytes: 0 }, turns, synthetic: true }
}
if (target === null) { console.error('✗ 没找到合适的会话'); process.exit(2) }

const turns = target.turns
const lines = turns.map((t, i) => {
  const prompt = t.prompt.trim().replace(/\s+/g, ' ')
  if (prompt !== '') return `#${i + 1} ${prompt.slice(0, 80)}`
  const reply = t.response.trim().replace(/\s+/g, ' ')
  return `#${i + 1} （用户没有发言；助手上一步在做：${reply.slice(0, 50)}）`
})
console.log(
  target.synthetic === true
    ? `合成语料 ${target.candidate.id} · ${turns.length} 回合`
    : `会话 ${target.candidate.id.slice(8, 16)} · ${turns.length} 回合 · 最后写入 ${new Date(statSync(target.candidate.log).mtimeMs).toISOString().slice(0, 16)}`,
)
console.log(`（只送**使用者的发言**，助手那侧只给无发言回合的一行提示）\n`)

const raw = await complete(SYSTEM, lines.join('\n'), { json: true, maxTokens: 3000, temperature: 0 })
let nodes = []
try { nodes = JSON.parse(raw).nodes ?? [] } catch { console.error('✗ 解析失败：', raw.slice(0, 300)); process.exit(1) }
nodes = nodes
  .map((n) => ({
    id: Number(n.id),
    parent: Number(n.parent ?? 0),
    title: String(n.title ?? ''),
    // **区间数组**：一个节点可以被"离开又回来"，所以它可能有多段。
    ranges: (Array.isArray(n.ranges) ? n.ranges : [])
      .map((r) => (Array.isArray(r) ? [Number(r[0]), Number(r[1])] : null))
      .filter((r) => r !== null && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] <= turns.length && r[0] <= r[1])
      .sort((a, b) => a[0] - b[0]),
  }))
  .filter((n) => Number.isInteger(n.id) && n.ranges.length > 0)
const byParent = new Map()
for (const node of nodes) {
  if (!byParent.has(node.parent)) byParent.set(node.parent, [])
  byParent.get(node.parent).push(node)
}
let printed = 0
const spanOf = (node) =>
  node.ranges.map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`)).join(' , ')
const render = (parent, depth) => {
  for (const node of (byParent.get(parent) ?? []).sort((a, b) => a.ranges[0][0] - b.ranges[0][0])) {
    console.log(`${'  '.repeat(depth)}${depth === 0 ? '●' : '└'} ${spanOf(node).padEnd(22)} ${node.title}`)
    printed += 1
    render(node.id, depth + 1)
  }
}
console.log('=== 模型给的任务树 ===')
render(0, 0)
// 有父但父不在表里的，兜底打出来（免得静默丢节点）
const ids = new Set(nodes.map((n) => n.id))
const orphans = nodes.filter((n) => n.parent !== 0 && !ids.has(n.parent))
if (orphans.length > 0) {
  console.log(`\n（${orphans.length} 个节点的 parent 不在表里，兜底列出）`)
  for (const n of orphans) console.log(`   #${n.from}–${n.to} ${n.title}`)
}
console.log(`\n共 ${nodes.length} 个节点（打印 ${printed} 个）`)
console.log(`用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
