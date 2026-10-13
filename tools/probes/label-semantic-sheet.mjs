#!/usr/bin/env node
/**
 * **判定效果的标注清单**：把"模型说偏离"与"模型没说偏离"的回合一起摆出来，供人逐条标。
 *
 * ## 为什么必须有人标
 *
 * 这条判据此前所有的数字都是"模型自己的判断"：真实臂被标多少、对调臂被标多少。
 * **没有任何人核过**——所以精确率/召回率一直是未知的，谈"识别效果"没有读数。
 * 使用者 2026-10-10：*"我要的是识别效果，成本为次要"*。
 *
 * ## 清单怎么抽样（这一步决定指标能不能算）
 *
 * - **被标偏离的全部放进来**（最多 `--flagged`，默认 15）——它们决定**精确率**；
 * - **没被标的随机抽同样多条**（种子固定，可复现）——它们决定**召回率**。
 *   只放被标的话，漏掉的（假阴性）永远看不见。
 *
 * ## 两段用法
 *
 * ```bash
 * # ① 生成清单（会花调用去判；成本次要）
 * node tools/probes/label-semantic-sheet.mjs --snapshot tools/probes/.out/structure-<…>.json \
 *   --url http://127.0.0.1:3098 --cookie /tmp/cj.txt --seq 51
 *
 * # ② 你标完之后（把「你判」那一列填 偏 / 不偏）算指标
 * node tools/probes/label-semantic-sheet.mjs --score research/semantic-labels-<…>.md
 * ```
 */
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 ? process.argv[i + 1] : d
}

/** 把 markdown 表格里的一行拆成单元格（`|` 分隔，忽略首尾空）。 */
const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())

// ── ② 评分模式 ──────────────────────────────────────────────────────────────
const SCORE = arg('--score', '')
if (SCORE !== '') {
  const rows = readFileSync(path.resolve(SCORE), 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim()))
    .map(cells)
    .filter((cols) => cols.length >= 8 && /^\d+$/.test(cols[0]))
  let tp = 0, fp = 0, fn = 0, tn = 0, unmarked = 0
  for (const cols of rows) {
    const model = cols[5]
  const human = cols[7]
    const said = /偏离/.test(model ?? '')
    const truth = (human ?? '').includes('偏') && !(human ?? '').includes('不偏')
    const saidNo = (human ?? '').includes('不偏')
    if (!truth && !saidNo) { unmarked += 1; continue }
    if (truth && said) tp += 1
    else if (truth && !said) fn += 1
    else if (!truth && said) fp += 1
    else tn += 1
  }
  const precision = tp + fp === 0 ? NaN : tp / (tp + fp)
  const recall = tp + fn === 0 ? NaN : tp / (tp + fn)
  console.log(`标注 ${tp + fp + fn + tn} 条（未标 ${unmarked} 条）`);
  console.log(`  真偏离 ${tp + fn} 条 · 模型抓到 ${tp} 条`);
  console.log(`  精确率 ${(precision * 100).toFixed(0)}%（模型说偏离的里，真偏离的比例）`);
  console.log(`  召回率 ${(recall * 100).toFixed(0)}%（真偏离里，模型抓到的比例）`);
  if (!Number.isNaN(precision) && !Number.isNaN(recall) && precision + recall > 0) {
    console.log(`  F1 ${((2 * precision * recall) / (precision + recall)).toFixed(2)}`);
  }
  process.exit(0)
}

// ── ① 生成清单 ──────────────────────────────────────────────────────────────
const SNAPSHOT = arg('--snapshot', '')
const URL_BASE = arg('--url', 'http://127.0.0.1:3098')
const COOKIE = arg('--cookie', '/tmp/cj.txt')
const SEQ = Number(arg('--seq', 51))
const BASE = arg('--hashbase', 'deadbeef')
const FLAGGED = Number(arg('--flagged', 15))
const LIMIT = Number(arg('--limit', 200))
if (SNAPSHOT === '') {
  console.error('✗ 需要 --snapshot（structure-via-host.mjs 落盘的那份）')
  process.exit(2)
}

const snap = JSON.parse(readFileSync(path.resolve(SNAPSHOT), 'utf8'))
const sessionId = String(snap.sessionId)
const short = sessionId.replace(/^session-/, '').slice(0, 8)
const { loadSessionTurns } = await import('./session-turns.mjs')
const { semanticMaterial } = await import(path.join(ROOT, 'lib', 'shared', 'semantic.js'))
const { goalStatement } = await import(path.join(ROOT, 'lib', 'shared', 'intent.js'))

const { turns: logTurns } = loadSessionTurns(short, { withSteps: true })
const turnText = new Map(logTurns.map((t) => [t.turn, t.prompt]))
const didText = new Map(logTurns.filter((t) => t.response !== '').map((t) => [t.turn, t.response]))
const statements = new Map()
for (const turn of logTurns) {
  const last = turn.steps[turn.steps.length - 1]
  if (last === undefined) continue
  const statement = goalStatement(last.reasoning)
  if (statement !== '') statements.set(turn.turn, statement)
}

const material = semanticMaterial(snap.structure, turnText, statements, snap.compactionTurns ?? [], didText)
if (material.turns.length === 0) {
  console.error('✗ 材料里没有待判回合')
  process.exit(1)
}
const judged = material.turns.slice(0, LIMIT)
console.log(`会话 ${sessionId}`)
console.log(`材料：${material.tasks.length} 个节点 · ${material.turns.length} 条待判（本次判 ${judged.length} 条）`)
console.log(`其中：有 agent 回复 ${judged.filter((t) => t.did !== '').length} 条 · 有 agent 理解 ${judged.filter((t) => t.objective !== '').length} 条`)

const hash = `${BASE}-${SEQ}`
const bodyFile = path.join('/tmp', 'semantic-label-sheet.json')
writeFileSync(bodyFile, JSON.stringify({ sessionId, hash, tasks: material.tasks, turns: judged }))
const started = Date.now()
const out = execFileSync('curl', [
  '-s', '-b', COOKIE, '-X', 'POST', `${URL_BASE}/api/intent.semantic`,
  '-H', 'content-type: application/json', '--data-binary', `@${bodyFile}`, '--max-time', '600',
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const parsed = JSON.parse(out)
if (parsed.error !== undefined) {
  console.error(`✗ 宿主拒了：${parsed.error}`)
  process.exit(1)
}
const verdicts = new Map((parsed.verdicts ?? []).map((v) => [v.turn, v]))
console.log(`判完：${verdicts.size} 条 · 状态 ${parsed.status}`
  + (typeof parsed.judged === 'number' ? ` · 新判 ${parsed.judged} / 复用 ${parsed.reused}` : '')
  + ` · ${((Date.now() - started) / 1000).toFixed(1)} 秒`)

// 抽样：被标的全要 + 未被标的随机同样多（种子固定）
const flaggedAll = judged.filter((t) => verdicts.get(t.turn)?.match === false)
const unflagged = judged.filter((t) => verdicts.get(t.turn)?.match !== false)
const picked = [...flaggedAll.slice(0, FLAGGED)]
let seed = 20261010
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pool = [...unflagged]
while (picked.length < FLAGGED * 2 && pool.length > 0) {
  picked.push(...pool.splice(Math.floor(rnd() * pool.length), 1))
}
// 同分组的（同样被标/未被标）保持回合序，读起来顺
picked.sort((a, b) => a.turn - b.turn)

const date = new Date().toISOString().slice(0, 10)
const mdPath = path.join(ROOT, 'research', `semantic-labels-${short}-${date}.md`)
const jsonPath = path.join(HERE, '.out', `semantic-labels-${short}.json`)
mkdirSync(path.dirname(jsonPath), { recursive: true })

const clip = (text, n) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, n)
const lines = [
  `# 语义判定的标注清单（${short}）`,
  '',
  `生成于 ${new Date().toISOString()} · 材料 ${material.turns.length} 条待判（本次判 ${judged.length} 条）· 抽样 ${picked.length} 条`,
  `判据：**agent 做的事是不是在办用户这一回合要它办的事**（材料 = 用户指令 + agent 实际回复 + agent 自述理解 + 节点上下文）`,
  '',
  `**怎么标**：在最后那列写 \`偏\` 或 \`不偏\`（只认这两个词）。标完我跑：`,
  '',
  '```bash',
  `node tools/probes/label-semantic-sheet.mjs --score research/semantic-labels-${short}-${date}.md`,
  '```',
  '',
  `被标偏离的 ${flaggedAll.length} 条**全部**在里面；另外随机会抽了 ${picked.length - Math.min(flaggedAll.length, FLAGGED)} 条**没被标**的——`,
  '**没有它们就算不出召回率**（漏掉的假阴性只在其中）。',
  '',
  '| 回合 | 用户指令 | agent 自述理解 | 模型说"用户要什么" | 模型说"agent 理解成什么" | 模型判定 | 模型理由 | 你判 |',
  '|---|---|---|---|---|---|---|---|',
]
for (const turn of picked) {
  const verdict = verdicts.get(turn.turn)
  lines.push(
    `| ${turn.turn} | ${clip(turn.ask, 80)} | ${clip(turn.objective, 80)} | ${clip(verdict?.want, 40)} | `
    + `${clip(verdict?.got, 40)} | ${verdict?.match === false ? '偏离' : '未标'} | ${clip(verdict?.reason, 80)} |  |`,
  )
}
lines.push('')
writeFileSync(mdPath, lines.join('\n'))
writeFileSync(jsonPath, JSON.stringify({
  sessionId, hash, at: new Date().toISOString(),
  counts: { candidates: material.turns.length, judged: judged.length, flagged: flaggedAll.length, sampled: picked.length },
  rows: picked.map((t) => ({
    turn: t.turn, ask: t.ask, did: t.did, objective: t.objective,
    model: verdicts.get(t.turn)?.match === false ? '偏离' : '未标',
    reason: verdicts.get(t.turn)?.reason ?? '',
    // 模型写下的对照（人核对时最省事的两列）；模型不写就是空串
    want: verdicts.get(t.turn)?.want ?? '',
    got: verdicts.get(t.turn)?.got ?? '',
    human: null,
  })),
}, null, 2))

console.log(`\n清单：${mdPath}`)
console.log(`机器可读：${jsonPath}`)
console.log(`抽样：被标 ${Math.min(flaggedAll.length, FLAGGED)} 条 + 未标 ${picked.length - Math.min(flaggedAll.length, FLAGGED)} 条`)
