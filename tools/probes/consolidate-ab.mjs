#!/usr/bin/env node
/**
 * **定期"判整理"的 A/B 对照**（B1）：同一条会话、同样的前缀推进，两条臂只差一个开关。
 *
 * | 臂 | 环境变量 | 含义 |
 * |---|---|---|
 * | 对照 | `DSH_INTENT_CONSOLIDATE_EVERY=0` | 从不补整理（增量只做归属） |
 * | 实验 | 默认（6） | 新增节点攒够 6 个就补一次整理 |
 *
 * 量三个数：**节点总数**、**只收 1 个回合的节点占比**、**调用次数**（整理每次 1 个调用）。
 * 前两个是"结构有没有收拢"，第三个是"代价"。
 *
 * ## 怎么跑
 *
 * 两条臂各需要**一个独立的宿主实例**（阈值是进程级环境变量），且**缓存文件要隔离**
 * （否则两臂共用 `~/.dsh/storages/intent-view/structures.json` 会互相污染）。
 *
 * ```bash
 * # 臂 A（从不整理）
 * DSH_INTENT_CONSOLIDATE_EVERY=0 DSH_INTENT_STRUCTURE_CACHE=/tmp/ab-a.json dsh web --port 3401
 * # 臂 B（默认）
 * DSH_INTENT_STRUCTURE_CACHE=/tmp/ab-b.json dsh web --port 3402
 * node tools/probes/consolidate-ab.mjs --a http://127.0.0.1:3401 --b http://127.0.0.1:3402 \
 *   --token <token> --session <会话id片段> --steps 10
 * ```
 *
 * ## 一个必须写明的口径
 *
 * 材料取**真实会话的回合**（`session-turns.mjs`，只认真人 user/message、联系方式打码），
 * 但**不是**在真会话上跑——是把它的回合按前缀逐步喂进去。所以量的是"结构算法在真实
 * 文本上的行为"，不是"某个会话的历史"。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { loadSessionTurns } from './session-turns.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const A = arg('--a', 'http://127.0.0.1:3401')
const B = arg('--b', 'http://127.0.0.1:3402')
/**
 * **认证走 cookie 文件**（`curl -c` 那份）：宿主发的是 `dsh-auth-<随机>` 这类名字，
 * 拼一个 `dsh-auth=<token>` 是错的（第一版就这么错了，收到的是 401 的 HTML，
 * 报错停在 `JSON.parse` 上，看不出是认证问题）。
 */
const COOKIE_FILE = arg('--cookie', '/tmp/ab-cj.txt')
const NEEDLE = arg('--session', '')
const STEPS = Number(arg('--steps', '10'))
const MAX = Number(arg('--max-turns', '80'))
/** `--only a|b`：只跑一条臂（做 N 次平均时用，省掉重复那一列）。 */
const ONLY = arg('--only', 'both')

// `loadSessionTurns` 返回的是 `{ id, turns, total }`（不是数组——第一版按数组写，
// 于是"匹配不到"这句误报，实际是形状读错了）
let loaded
try {
  loaded = loadSessionTurns(NEEDLE, { maxTurns: MAX })
} catch (error) {
  console.error(`✗ ${String(error.message)}`)
  process.exit(2)
}
const turns = loaded.turns.map((t) => ({ turn: t.turn, prompt: String(t.prompt ?? '') }))
if (turns.length === 0) {
  console.error(`✗ 会话 ${loaded.id} 没有可用回合`)
  process.exit(2)
}
console.log(`会话 ${loaded.id}（共 ${loaded.total} 回合）· 取前 ${turns.length} 条 · 前缀推进 ${STEPS} 步\n`)

/** 从 cookie jar 里拼出 `k=v; k2=v2`。 */
function cookieHeader() {
  const lines = readFileSync(COOKIE_FILE, 'utf8').split('\n')
  const pairs = []
  for (const line of lines) {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
    const parts = line.replace(/^#HttpOnly_/, '').split('\t')
    if (parts.length < 7) continue
    pairs.push(`${parts[5]}=${parts[6]}`)
  }
  return pairs.join('; ')
}

/** 按前缀问一次结构，返回读数。 */
async function ask(baseUrl, sessionId, prefixLen, tag) {
  // **把 `/?token=…` 那截去掉**：驱动脚本传进来的是完整访问 URL，直接拼路径会得到
  // `/?token=…/api/intent.structure` —— 服务端回空响应，报错停在 `JSON.parse` 上，
  // 看起来像"接口坏了"（这一轮为此白跑了 6 次）。
  const base = baseUrl.replace(/\/\?.*$/, '').replace(/\/$/, '')
  const body = {
    sessionId,
    contentHash: `${tag}-${prefixLen}`,
    turns: turns.slice(0, prefixLen),
  }
  const res = await fetch(`${base}/api/intent.structure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (json.ok !== true) return { error: String(json.error ?? res.status) }
  const nodes = json.structure?.nodes ?? {}
  const membership = json.structure?.membership ?? {}
  const count = Object.fromEntries(
    Object.entries(membership).map(([turn, ids]) => [turn, Array.isArray(ids) ? ids : []]),
  )
  const held = Object.keys(nodes).map(
    (id) => Object.values(count).filter((ids) => ids.includes(id)).length,
  )
  const single = held.filter((n) => n === 1).length
  return {
    nodes: Object.keys(nodes).length,
    single,
    singleShare: held.length === 0 ? 0 : single / held.length,
    calls: json.meta?.calls ?? 0,
    consolidated: json.meta?.consolidated === true,
  }
}

const rows = []
for (let step = 1; step <= STEPS; step += 1) {
  const prefix = Math.max(12, Math.round((turns.length * step) / STEPS))
  const askA = ONLY === 'b' ? Promise.resolve({ skipped: true }) : ask(A, 'ab-arm-a', prefix, 'a')
  const askB = ONLY === 'a' ? Promise.resolve({ skipped: true }) : ask(B, 'ab-arm-b', prefix, 'b')
  const [a, b] = await Promise.all([askA, askB])
  rows.push({ prefix, a, b })
  const fmt = (r) =>
    r.skipped === true
      ? '（本次不跑）'
      : r.error !== undefined
        ? `✗ ${r.error}`
        : `节点 ${String(r.nodes).padStart(3)} · 单回合 ${(r.singleShare * 100).toFixed(0).padStart(3)}% · 调用 ${String(r.calls).padStart(2)}${r.consolidated ? ' · 整理√' : ''}`
  console.log(`#${String(prefix).padStart(3)}  臂A: ${fmt(a)}\n      臂B: ${fmt(b)}`)
}

const last = rows[rows.length - 1]
// 单臂模式只打一行汇总（驱动脚本按行收集，好做 N 次平均）
if (ONLY !== 'both') {
  const r = ONLY === 'a' ? last?.a : last?.b
  if (r?.nodes !== undefined) {
    console.log(`RESULT only=${ONLY} nodes=${r.nodes} single=${(r.singleShare * 100).toFixed(0)} calls=${r.calls} consolidated=${r.consolidated === true ? 1 : 0}`)
  } else {
    console.log(`RESULT only=${ONLY} error=${r?.error ?? 'unknown'}`)
  }
}
if (ONLY === 'both' && last?.a?.nodes !== undefined && last?.b?.nodes !== undefined) {
  console.log(
    `\n末态对照：节点 ${last.a.nodes} → ${last.b.nodes}` +
      ` · 单回合节点占比 ${(last.a.singleShare * 100).toFixed(0)}% → ${(last.b.singleShare * 100).toFixed(0)}%` +
      ` · 调用 ${last.a.calls} → ${last.b.calls}`,
  )
}
