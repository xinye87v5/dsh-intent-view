#!/usr/bin/env node
/**
 * **冻结分组语义的交叉校验**：这份 JS 快照必须与 Python 参考值逐字一致。
 *
 * ## 为什么需要它
 *
 * 产品侧的分组/转向函数已经删掉（提交 ④），但历史结论还挂在它上面：
 * `research/group-vs-dag-2026-10-10.md` 的"话题组 vs DAG 冲突规模"、
 * `segment-quality` 的 WindowDiff/Pk，以及"TS 与 Python 两个独立实现
 * 算出同一份分组"这条**第二意见**。
 *
 * 那份语义现在冻结在 `tools/probes/grouping.mjs` 里，是**手工**从
 * `src/shared/intent.ts` 抄成 JS 的（去掉类型标注）。手工搬运最容易
 * 悄悄失真：抄错一个阈值、漏掉 `MIN_GROUP` 的合并，历史就能复现出另一组数字。
 * 所以这里用 Python 的参考输出钉死它。
 *
 * ## 参考值从哪来
 *
 * `graphview intent --session f1cd07a6 --check` 的输出（另一个项目里的
 * Python 实现，独立于本仓库的 TS 实现），fixture 是
 * `research/fixture-f1cd07.json`（379 回合）。**两个独立实现算出逐字一致的
 * 答案**，比一个实现自己声称正确强——这正是这份文件存在的全部理由。
 *
 * 这一份**不在 `npm run build` 里**：它测的是研究侧的冻结副本，不是产品。
 * 用法：`node tools/probes/grouping-crosscheck.mjs`
 */

const FIXTURE = new URL('../../research/fixture-f1cd07.json', import.meta.url)
const GROUPING = new URL('./grouping.mjs', import.meta.url)

/** Python 参考值。 */
const PYTHON = {
  turns: 379,
  groups: 35,
  shifts: 0,
  ranges:
    '1-4,5-16,17-26,27-45,46-60,61-75,76-96,97-101,102-107,108-115,116-133,134-137,' +
    '138-144,145-150,151-167,168-176,177-191,192-195,196-203,204-223,224-238,239-259,' +
    '260-273,274-285,286-293,294-301,302-314,315-321,322-331,332-338,339-344,345-350,' +
    '351-361,362-366,367-379',
}

const { readFileSync } = await import('node:fs')
const mod = await import(GROUPING)
const turns = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const terms = turns.map((t) => mod.bigrams(`${t.prompt ?? ''}${t.response ?? ''}`))
const groups = mod.groupTurns(terms)
const ranges = groups
  .map((g) => `${turns[g[0]].turn}-${turns[g[g.length - 1]].turn}`)
  .join(',')
const shifts = mod.findTopicShifts(terms, [])

// 合成"40 回合同话题 + 40 回合换话题"：转向点应当落在 turn 41，
// 且 `turnsAfterCompaction` 的边界（压缩点恰好落在转向处 = 1）要成立——
// 那条边界是产品侧文档里写死过的语义，快照抄错就会飘。
const synth = []
for (let i = 0; i < 40; i += 1) synth.push(new Set(['aa', 'ab', 'ac', 'ad', 'ae']))
for (let i = 0; i < 40; i += 1) synth.push(new Set(['zz', 'zy', 'zx', 'zw', 'zv']))
const dist = (compactions) => mod.findTopicShifts(synth, compactions).map((s) => s.turnsAfterCompaction)

const checks = [
  [`fixture 回合数 = ${PYTHON.turns}`, turns.length === PYTHON.turns, String(turns.length)],
  [`分组数 = Python 的 ${PYTHON.groups}`, groups.length === PYTHON.groups, String(groups.length)],
  ['组区间与 Python 逐字一致', ranges === PYTHON.ranges, `${ranges.slice(0, 34)}…`],
  [`转向数 = Python 的 ${PYTHON.shifts}`, shifts.length === PYTHON.shifts, String(shifts.length)],
  [
    '分组覆盖全部回合且不重叠',
    groups.reduce((sum, g) => sum + g.length, 0) === turns.length,
    `Σ ${groups.reduce((sum, g) => sum + g.length, 0)}`,
  ],
  [
    'overlap 对称',
    mod.overlap(new Set(['a', 'b']), new Set(['a'])) === mod.overlap(new Set(['a']), new Set(['a', 'b'])),
  ],
  ['合成转向：点落在 #41', dist([]).length === 1 && mod.findTopicShifts(synth, [])[0].turn === 41],
  ['不传压缩点时距离为 0', dist([])[0] === 0, String(dist([])[0])],
  ['压缩在转向之前 → 算出距离', dist([10])[0] === 31, String(dist([10])[0])],
  ['压缩正落在转向处 → 距离 1', dist([40])[0] === 1, String(dist([40])[0])],
  ['压缩在转向之后 → 距离 0', dist([999])[0] === 0, String(dist([999])[0])],
  // 冻结副本**不许**再长出产品侧删掉的东西以外的新行为：这四个阈值是历史结论的锚。
  ['阈值与历史一致', mod.SPLIT_AT === 0.08 && mod.MAX_GROUP === 40 && mod.MIN_GROUP === 3 && mod.LOCAL_FLOOR === 0.12,
    `${mod.SPLIT_AT}/${mod.MAX_GROUP}/${mod.MIN_GROUP}/${mod.LOCAL_FLOOR}`],
]

let bad = 0
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) bad += 1
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`)
process.exit(bad === 0 ? 0 : 1)
