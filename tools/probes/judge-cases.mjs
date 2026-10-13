#!/usr/bin/env node
/**
 * **虚拟判定样例**：把 `judge-cases.json` 里的用例送进真正那条判定路，并生成一份**盲标清单**。
 *
 * ## 为什么要虚拟样例
 *
 * 真实会话上的精确率/召回率一直算不出来——**没有真值**，而让人标真实会话的代价很高
 * （要看上下文、还要判断"用户当时到底要什么"）。虚拟样例把这件事倒过来：
 * 每条只考一件事（真偏离 / 换个做法 / 简报回合 / 指令不具体 / 要借节点上下文 / 压缩后换方向…），
 * 上下文短到可以一眼看完，标起来快，而**考点是事先写好的**。
 *
 * ## 两种用法
 *
 * ```bash
 * # ① 生成盲标清单（**不显示模型结论**，避免锚定）
 * node tools/probes/judge-cases.mjs --sheet
 *
 * # ② 送进判定路跑一遍：先跟"作者预标注"对一次（预标注不是真值，只是先给个读数）
 * node tools/probes/judge-cases.mjs --run --url http://127.0.0.1:3098 --cookie /tmp/cj.txt
 *
 * # ③ 你标完之后：用你的标注当真值算精确率/召回率
 * node tools/probes/judge-cases.mjs --score research/judge-cases.md
 * ```
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
const corpus = JSON.parse(readFileSync(path.join(HERE, 'judge-cases.json'), 'utf8'))
const cases = corpus.cases
const SHEET = path.join(ROOT, 'research', 'judge-cases.md')

/** 用例 → 判定材料：一个用例 = 一个节点 + 一个待判回合。 */
function material() {
  const tasks = cases.map((c) =>
    `${c.node}${c.parent ? `（父枝：${c.parent}）` : '（顶层枝：只判领域）'}：「${c.ask.slice(0, 40)}」`,
  )
  const turns = cases.map((c, i) => ({
    turn: i + 1,
    task: i + 1,
    ask: c.ask,
    objective: c.objective,
    did: c.did,
  }))
  return { tasks, turns }
}

// ── ① 盲标清单 ──────────────────────────────────────────────────────────────
const BATCH = Number(arg('--batch', 0))
if (process.argv.includes('--sheet')) {
  const only = BATCH > 0 ? cases.filter((c) => c.batch === BATCH) : cases
  const out = arg('--sheet-out', BATCH > 0 ? path.join(ROOT, 'research', `judge-cases-${BATCH}.md`) : SHEET)
  const lines = [
    '# 虚拟判定样例（盲标）',
    '',
    `共 ${only.length} 条${BATCH > 0 ? `（第 ${BATCH} 批）` : ''}。**这份不显示模型结论**，避免锚定。`,
    '',
    '怎么标：在最后那列写 `偏` 或 `不偏`（只认这两个词）——判据是「**agent 当时理解成的那件事，',
    '是不是用户这一回合要它做的那件事**」。节点上下文只用来理解"用户这句话要的是哪一步"。',
    '',
    '标完跑：`node tools/probes/judge-cases.mjs --score research/judge-cases.md`',
    '',
    '**第三问那一列**（归属贴近度，独立于前两问）：这一回合做的事，与**父枝的目标**靠近吗？',
    '写 `近` / `远` / `不适用`。参照物是**父枝本身**，不是"整个项目在做的事"——',
    '同一个大项目下的另一条枝也算"远"。父枝写"（顶层枝）"时参照物是**这一枝自己的主题**，',
    '只看领域有没有偏出去（不拿会话大目标卡具体操作）。过渡/收尾/说不清写 `不适用`。',
    '',
    '| # | 考点 | 节点上下文 | 父枝（第三问的参照物） | 用户指令 | agent 自述理解 | agent 回复摘要 | 你判（偏/不偏） | 第三问（近/远/不适用） |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const c of only) {
    const clip = (t, n) => String(t).replace(/\|/g, '/').slice(0, n)
    const parent = c.parent === undefined || c.parent === null ? '（顶层枝：只判领域）' : c.parent
    lines.push(
      `| ${c.id} | ${c.expectParent !== undefined ? '（略——避免锚定）' : c.tests} | ${clip(c.node, 24)} | ${clip(parent, 24)} | ${clip(c.ask, 60)} | ` +
        `${clip(c.objective, 70)} | ${clip(c.did, 60)} |  |  |`,
    )
  }
  lines.push('')
  writeFileSync(out, lines.join('\n'))
  console.log(`盲标清单：${out}`)
  process.exit(0)
}

// ── ③ 用人工标注当真值评分 ──────────────────────────────────────────────────
if (process.argv.includes('--score')) {
  // 复用 `--run` 落盘的模型结论（`tools/probes/.out/judge-cases.json`）
  const judged = JSON.parse(readFileSync(path.join(HERE, '.out', 'judge-cases.json'), 'utf8'))
  const model = new Map(judged.rows.map((r) => [r.id, r.model]))
  const rows = readFileSync(SHEET, 'utf8').split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim()))
    .map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
    .filter((cols) => cols.length >= 7 && /^C\d+$/.test(cols[0]))
  let tp = 0, fp = 0, fn = 0, tn = 0, unmarked = 0
  const misses = []
  for (const cols of rows) {
    const id = cols[0]
    /**
     * 允许在标注后面写理由（"偏，多余任务"）——**只认"不偏"与"偏"两个词**，
     * 但不再要求整格只有这两个字（实测：人一定会写理由，那正是最有用的部分）。
     */
    const human = cols[6] ?? ''
    const saidNo = human.includes('不偏')
    const truth = !saidNo && human.includes('偏')
    if (!truth && !saidNo) { unmarked += 1; continue }
    const said = model.get(id) === '偏离'
    if (truth && said) tp += 1
    else if (truth && !said) { fn += 1; misses.push(`${id} 漏报`) }
    else if (!truth && said) { fp += 1; misses.push(`${id} 误报`) }
    else tn += 1
  }
  const precision = tp + fp === 0 ? NaN : tp / (tp + fp)
  const recall = tp + fn === 0 ? NaN : tp / (tp + fn)
  console.log(`标注 ${tp + fp + fn + tn} 条（未标 ${unmarked} 条）· 真偏离 ${tp + fn} 条`);
  console.log(`  精确率 ${(precision * 100).toFixed(0)}% · 召回率 ${(recall * 100).toFixed(0)}%`
    + (Number.isNaN(precision) || Number.isNaN(recall) ? '' : ` · F1 ${((2 * precision * recall) / (precision + recall)).toFixed(2)}`))
  if (misses.length > 0) console.log(`  错的：${misses.join('、')}`)
  process.exit(0)
}

// ── ①b 第三问打分：清单最后一列（近/远/不适用）vs 上一次跑出来的模型结论 ──────
if (process.argv.includes('--score-parent')) {
  const sheet = readFileSync(arg('--score-parent'), 'utf8')
  const ran = JSON.parse(readFileSync(path.join(HERE, '.out', 'judge-cases.json'), 'utf8'))
  const model = new Map(ran.rows.map((r) => [r.id, r.modelParent]))
  const norm = (t) => {
    const x = String(t).trim()
    if (x.startsWith('近')) return '近'
    if (x.startsWith('远')) return '远'
    if (x.startsWith('不')) return '不适用'
    return null
  }
  let n = 0, ok = 0, tp = 0, fp = 0, fn = 0
  const misses = []
  for (const line of sheet.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 11 || !/^P\d+$/.test(cells[1])) continue
    // **取最后一个非空格**：写死下标会随列数漂移（第一版写 cells[10]，实测返回 0 条——
    // 人一改列、或表格少一列，打分器就静默算 0 条，那是"看着像绿"的另一种形式）
    const filled = cells.filter((c) => c !== '')
    const truth = norm(filled[filled.length - 1])
    if (truth === null) continue
    const said = model.get(cells[1])
    const want = truth === '近' ? 'near' : truth === '远' ? 'far' : 'na'
    n += 1
    if (said === want) ok += 1
    else misses.push(`${cells[1]} 你判 ${truth} / 模型 ${said ?? '无'}`)
    if (truth === '远' && said === 'far') tp += 1
    if (truth !== '远' && said === 'far') fp += 1
    if (truth === '远' && said !== 'far') fn += 1
  }
  const precision = tp + fp === 0 ? NaN : tp / (tp + fp)
  const recall = tp + fn === 0 ? NaN : tp / (tp + fn)
  console.log(`第三问标注 ${n} 条 · 一致 ${ok}/${n}`)
  console.log(`  判 far 的精确率 ${Number.isNaN(precision) ? '—' : (precision * 100).toFixed(0) + '%'}`
    + ` · 召回率 ${Number.isNaN(recall) ? '—' : (recall * 100).toFixed(0) + '%'}（TP ${tp} / FP ${fp} / FN ${fn}）`)
  if (misses.length > 0) console.log(`  不一致：${misses.join('、')}`)
  process.exit(0)
}

// ── ② 跑一遍 ────────────────────────────────────────────────────────────────
const URL_BASE = arg('--url', 'http://127.0.0.1:3098')
const COOKIE = arg('--cookie', '/tmp/cj.txt')
const { tasks, turns } = material()
const body = { sessionId: 'synthetic-judge-cases', hash: `deadbeef-${arg('--seq', 201)}`, tasks, turns }
const file = '/tmp/judge-cases-request.json'
writeFileSync(file, JSON.stringify(body))
const out = execFileSync('curl', [
  '-s', '-b', COOKIE, '-X', 'POST', `${URL_BASE}/api/intent.semantic`,
  '-H', 'content-type: application/json', '--data-binary', `@${file}`, '--max-time', '600',
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const parsed = JSON.parse(out)
if (parsed.error !== undefined) {
  console.error(`✗ 宿主拒了：${parsed.error}`)
  process.exit(1)
}
const verdicts = new Map((parsed.verdicts ?? []).map((v) => [v.turn, v]))
const rows = cases.map((c, i) => {
  const v = verdicts.get(i + 1)
  return {
    id: c.id, tests: c.tests, expect: c.expect, node: c.node, ask: c.ask,
    objective: c.objective, did: c.did,
    model: v?.match === false ? '偏离' : v?.match === true ? '未标' : '无结论',
    want: v?.want ?? '', got: v?.got ?? '', reason: v?.reason ?? '',
    // 两问的原始答案 + 模型列出的"动过的对象"（核对"是理解错了还是越界了"用）
    understanding: v?.understanding ?? null, inScope: v?.inScope ?? null,
    // **第三问**：模型结论 vs 作者预标 vs 人工真值（三者分列，不混）
    modelParent: v?.parent ?? null,
    parentWhy: v?.parentWhy ?? '',
    parentWhat: v?.parentWhat ?? '',
    parentGoal: v?.parentGoal ?? '',
    expectParent: c.expectParent ?? null,
    truthParent: c.truthParent ?? null,
    agreeParent: (() => {
      const truth = c.truthParent ?? c.expectParent
      if (truth == null || v?.parent == null) return null
      const want = truth === '近' ? 'near' : truth === '远' ? 'far' : 'na'
      return v.parent === want
    })(),
    touched: v?.touched ?? [],
    // 有真值（人工盲标）就用真值；否则退回作者预标注，并在输出里标明
    truth: c.truth ?? null,
    basis: c.truth !== undefined ? '真值' : '预标',
    agree: v === undefined ? null : (v.match === false) === ((c.truth ?? c.expect) === '偏'),
  }
})
writeFileSync(path.join(HERE, '.out', 'judge-cases.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))

console.log(`判完 ${verdicts.size}/${cases.length} 条 · 状态 ${parsed.status}\n`)
console.log('#  考点                                        依据   标注   模型   一致  第三问(父枝)')
for (const r of rows) {
  const p3 = r.expectParent == null
    ? ''
    : `${r.truthParent != null ? '真值' : '预标'} ${r.truthParent ?? r.expectParent} / 模型 ${r.modelParent ?? '无'}` + (r.agreeParent === null ? '' : r.agreeParent ? ' ✓' : ' ✗')
  console.log(
    `${r.id.padEnd(4)}${r.tests.padEnd(44)}${r.basis.padEnd(6)}${(r.truth ?? r.expect).padEnd(6)}${r.model.padEnd(6)}`
    + (r.agree === null ? '—' : r.agree ? '✓' : '✗') + '  ' + p3
    + (r.model === '偏离' && r.reason !== '' ? `\n     理由：${String(r.reason).slice(0, 80)}` : '')
    + (r.parentGoal !== '' || r.parentWhat !== ''
        ? `\n     第三问先写：父枝目标「${String(r.parentGoal).slice(0, 30)}」/ 本回合在「${String(r.parentWhat).slice(0, 30)}」`
        : '')
    + (r.parentWhy !== '' ? `\n     第三问依据：${String(r.parentWhy).slice(0, 80)}` : ''),
  )
}
const scoreable = rows.filter((r) => r.agree !== null)
const agree = scoreable.filter((r) => r.agree).length
const real = scoreable.filter((r) => r.basis === '真值')
const realAgree = real.filter((r) => r.agree).length
console.log(`\n与人工真值一致 ${realAgree}/${real.length}`
  + (scoreable.length > real.length ? ` · 与作者预标一致 ${agree}/${scoreable.length}（预标不是真值，只供参考）` : ''))
if (real.length > 0) {
  const tp = real.filter((r) => r.truth === '偏' && r.model === '偏离').length
  const fn = real.filter((r) => r.truth === '偏' && r.model !== '偏离').length
  const fp = real.filter((r) => r.truth === '不偏' && r.model === '偏离').length
  console.log(`  精确率 ${tp + fp === 0 ? '—' : ((tp / (tp + fp)) * 100).toFixed(0) + '%'}`
    + ` · 召回率 ${tp + fn === 0 ? '—' : ((tp / (tp + fn)) * 100).toFixed(0) + '%'}`
    + `（TP ${tp} / FP ${fp} / FN ${fn}）`)
}
// **第三问单独汇总**（它不进 match，指标也单独算）
const p3rows = rows.filter((r) => r.agreeParent !== null)
if (p3rows.length > 0) {
  const ok = p3rows.filter((r) => r.agreeParent).length
  const wantFar = p3rows.filter((r) => (r.truthParent ?? r.expectParent) === '远').length
  const tp = p3rows.filter((r) => (r.truthParent ?? r.expectParent) === '远' && r.modelParent === 'far').length
  const fp = p3rows.filter((r) => (r.truthParent ?? r.expectParent) !== '远' && r.modelParent === 'far').length
  const fn = wantFar - tp
  console.log(`\n第三问（归属贴近度）：一致 ${ok}/${p3rows.length}`
    + ` · 判 far 的精确率 ${tp + fp === 0 ? '—' : ((tp / (tp + fp)) * 100).toFixed(0) + '%'}`
    + ` · 召回率 ${wantFar === 0 ? '—' : ((tp / wantFar) * 100).toFixed(0) + '%'}（TP ${tp} / FP ${fp} / FN ${fn}）`)
}
console.log(`盲标清单：node tools/probes/judge-cases.mjs --sheet`)
