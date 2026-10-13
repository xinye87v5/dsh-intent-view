#!/usr/bin/env node
/**
 * **走真正发出去的那条路**复验节点判据：把材料打给宿主路由 `/api/intent.semantic`，
 * 而不是自己拼提示词。
 *
 * 为什么必须这样验：探针（`node-check-baseline.mjs`）用的是它自己的提示词与解析，
 * 只能证明"按节点判这件事有区分力"；**不能证明插件里跑的提示词与解析也对**。
 * 两者是同一份措辞才有意义——本项目已经吃过"研究里验证过的 ≠ 插件里跑着的"的亏。
 *
 * 两个臂与探针一致：真配对 / 同会话内确定性乱配。
 *
 * ⚠️ **`text` 必须是真内容**：我第一版填了占位串 `#N 的用户回合`，结果两臂都判 0% 被标
 * ——模型没内容可判，只好全说"是"。材料造错会让判据看起来"很稳"，其实是空的。
 *
 * 用法：`node tools/probes/node-check-via-host.mjs --state session-abcd1237.json --url http://127.0.0.1:3098 --cookie /tmp/cj.txt`
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTDIR = path.resolve(HERE, '.out')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const STATE = arg('--state', 'session-abcd1237.json')
/**
 * 也可以直接吃 `structure-via-host.mjs` 落盘的**结构快照**
 * （`--snapshot .out/structure-<会话>-<指纹>.json`）。
 *
 * 两条路的区别很重要：`--state` 吃的是**当时某次跑出来的**结构快照（可能是几十轮之前的
 * 提示词版本），`--snapshot` 吃的是**刚复跑出来的**那份——问"现在的判据正不正常"，
 * 该用后者，否则量的是旧结构。
 */
const SNAPSHOT = arg('--snapshot', '')
const URL_BASE = arg('--url', 'http://127.0.0.1:3098')
const COOKIE = arg('--cookie', '/tmp/cj.txt')
const SAMPLE = Number(arg('--sample', 12))

let state
let short
let turns
if (SNAPSHOT !== '') {
  const snap = JSON.parse(readFileSync(path.resolve(SNAPSHOT), 'utf8'))
  state = snap.structure
  short = String(snap.sessionId)
  turns = snap.turns
  console.log(`快照 ${path.basename(SNAPSHOT)} · 指纹 ${snap.hash} · ${turns.length} 回合 · ${Object.keys(state.nodes).length} 节点`)
} else {
  state = JSON.parse(readFileSync(path.join(OUTDIR, STATE), 'utf8'))
  short = STATE.replace(/^session-/, '').replace(/\.json$/, '')
  const { loadSessionTurns } = await import('./session-turns.mjs')
  turns = loadSessionTurns(short).turns
}
const textOf = (t) => turns.find((x) => x.turn === t)?.prompt ?? ''

const turnsOfNode = new Map()
for (const [turn, list] of Object.entries(state.membership)) {
  for (const id of list) {
    if (state.nodes[id] === undefined) continue
    const arr = turnsOfNode.get(id) ?? []
    arr.push(Number(turn))
    turnsOfNode.set(id, arr)
  }
}
const nodes = [...turnsOfNode.keys()].filter((id) => turnsOfNode.get(id).length > 0)
/** 与客户端同一套材料：节点名 + 最多 3 条代表回合。 */
const tasks = nodes.map((id) =>
  `${state.nodes[id].title}：` + turnsOfNode.get(id).slice(0, 3).map((t) => `「${textOf(t).slice(0, 40)}」`).join(' '),
)
const indexOf = new Map(nodes.map((id, i) => [id, i + 1]))

const withNode = []
for (const id of nodes) for (const t of turnsOfNode.get(id)) withNode.push({ turn: t, node: id })
withNode.sort((a, b) => a.turn - b.turn)
const step = withNode.length / SAMPLE
const sample = withNode.length <= SAMPLE ? withNode : Array.from({ length: SAMPLE }, (_, i) => withNode[Math.floor(i * step)])

const material = (arm) => {
  const list = arm === 'real'
    ? sample.map((x) => ({ turn: x.turn, task: indexOf.get(x.node), text: textOf(x.turn).slice(0, 200) }))
    : sample.map((x, i) => {
        const others = nodes.filter((id) => id !== x.node)
        return { turn: x.turn, task: indexOf.get(others[i % others.length]), text: textOf(x.turn).slice(0, 200) }
      })
  return { tasks, turns: list }
}

/**
 * 指纹的形状由宿主校验（8 位十六进制 + 序号）。
 *
 * ⚠️ **两个臂必须用不同指纹**：宿主按指纹缓存，我第一版两臂共用一个，
 * 第二臂直接吃到了第一臂的缓存结果（两臂都 0%），看起来像"判据没区分力"。
 * 这本身倒证明了缓存有效。
 *
 * `--seq` 用来在同一批实验里换一对新指纹（宿主重启前跑过的指纹会命中旧缓存，
 * 那时量到的是**上一次**的结论）。
 */
const BASE = arg('--hashbase', 'deadbeef')
const SEQ = Number(arg('--seq', 1))
/**
 * 指纹形状由**宿主校验**：`^[0-9a-f]{8}-\d+$`（`host/semanticUnit.ts` 的 `readRequest`）。
 * 不合形状的指纹会被回 `{"error":"bad request"}`——我第一次用 `nc-d5b0-1` 就撞上了，
 * 而那个错误看起来像"路由坏了"，实际是**我这边的指纹形状不对**。所以这里先自检。
 */
if (!/^[0-9a-f]{8}$/.test(BASE)) {
  console.error(`✗ --hashbase 必须是 8 位十六进制字符（宿主校验的形状），收到 ${JSON.stringify(BASE)}`)
  process.exit(2)
}
const hashFor = (arm) => `${BASE}-${SEQ + (arm === 'real' ? 0 : 1)}`
// 用 curl 发：cookie jar 的解析交给它（我手写过一版，拼出来的 header 不认，白跑一轮）
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
for (const arm of ['real', 'shuffled']) {
  const payload = path.join(OUTDIR, `semantic-${arm}.json`)
  writeFileSync(payload, JSON.stringify({ sessionId: short, hash: hashFor(arm), ...material(arm) }))
  const out = execFileSync('curl', [
    '-s', '-b', COOKIE, '-X', 'POST', `${URL_BASE}/api/intent.semantic`,
    '-H', 'content-type: application/json', '--data', `@${payload}`, '--max-time', '300',
  ], { encoding: 'utf8' })
  const body = JSON.parse(out)
  const status = 200
  if (body.status !== 'computed') {
    console.log(`${arm.padEnd(8)} 没判成：${JSON.stringify(body).slice(0, 160)}`)
    continue
  }
  const flagged = (body.verdicts ?? []).filter((v) => v.match === false).length
  const total = (body.verdicts ?? []).length
  console.log(`${arm.padEnd(8)} HTTP ${status} · 判出 ${total} 条 · 被标 ${flagged} 条（${(flagged / Math.max(1, total) * 100).toFixed(0)}%）· ${body.votes ?? '?'} 票`)
}
