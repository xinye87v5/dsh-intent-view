#!/usr/bin/env node
/**
 * **规则缺口矩阵**（B5）：把 6 种 op × 每一条约束两两试一遍，看谁没被挡住。
 *
 * ## 为什么用"测"而不是"读"
 *
 * 「同级不许同名」这条规则我已经被咬过两次：先是只在**改名**上生效，后来补了
 * **新建枝**，再后来才发现**合并带标题**与**挪枝**也能造出同名同级。每次都是
 * "读代码时觉得已经覆盖了"。所以这次把矩阵跑出来：**每一格都构造一个违规输入，
 * 看校验层是否拒绝**。缺口会直接以 ✗ 的形式出现，不靠记性。
 *
 * ## 口径
 *
 * - fixture 里**故意**放了一对同名兄弟（`a`/`b` 都叫「甲」）——真实结构可能是模型
 *   造出来的，校验层管不了它，但它正好用来测"别的 op 会不会把节点变成同名"；
 * - 期望值写成本文件里的表，**改规则必须改这张表**（表就是规格）；
 * - 只测 `validateOverride`（校验层），不测渲染——渲染的兜底另有断言。
 *
 * 用法：`node scripts/verify-override-matrix.cjs`
 */
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const T = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'))

/** 一张故意带上"同名兄弟"的小图。 */
const graph = () => ({
  nodes: {
    root: { id: 'root', title: 'root', parents: [] },
    p: { id: 'p', title: '项目', parents: ['root'] },
    a: { id: 'a', title: '甲', parents: ['p'] },
    b: { id: 'b', title: '乙', parents: ['p'] },
    c: { id: 'c', title: '具体', parents: ['a'] },
    x: { id: 'x', title: '乙', parents: ['root'] },
    // 再造一个「甲」但挂在 root 下：这样才能构造"挪枝之后才撞名"
    y: { id: 'y', title: '甲', parents: ['root'] },
  },
  membership: { 1: ['a'], 2: ['c'], 3: ['b'], 4: ['x'] },
})

/** 一格的期望：`reject` = 必须被拒（附原因里的关键词）；`allow` = 必须放行。 */
const cases = [
  // ── setPlacement ──────────────────────────────────────────────────────────
  { op: 'setPlacement', id: 'sp-turn', why: '回合号必须是正整数', rule: { op: 'setPlacement', turn: 0, nodes: ['a'] }, want: 'reject', match: /回合号/ },
  { op: 'setPlacement', id: 'sp-dead', why: '落点里的节点必须存在（死 id 不许静默写进去）', rule: { op: 'setPlacement', turn: 1, nodes: ['没有的id'] }, want: 'reject', match: /没有这个节点/ },
  { op: 'setPlacement', why: '空落点 = 摘除（合法）', rule: { op: 'setPlacement', turn: 1, nodes: [] }, want: 'allow' },
  { op: 'setPlacement', why: '挂到任意存在的节点（合法）', rule: { op: 'setPlacement', turn: 1, nodes: ['x'] }, want: 'allow' },

  // ── rename ────────────────────────────────────────────────────────────────
  { op: 'rename', id: 'node', why: '不存在的节点', rule: { op: 'rename', id: '没有', title: 'X' }, want: 'reject', match: /没有这个节点/ },
  { op: 'rename', why: '空名字', rule: { op: 'rename', id: 'a', title: '   ' }, want: 'reject', match: /名字不能为空/ },
  { op: 'rename', id: 'same', why: '同级撞名（把 b 改成 a 的「甲」）', rule: { op: 'rename', id: 'b', title: '甲' }, want: 'reject', match: /同级不能同名/ },
  // 这几格我第一版写错了三次（图里本来就有同名兄弟、把"不同级"当成 x 与 p 等）——
  // 矩阵的价值正在于把"用例错"与"代码缺"分开：两者看起来一样，处置完全不同。
  { op: 'rename', why: '不同级可以同名（c 在 a 下，b 在 p 下 ⇒ 不同级）', rule: { op: 'rename', id: 'c', title: '乙' }, want: 'allow' },
  { op: 'rename', why: '改成自己的名字（没变化）', rule: { op: 'rename', id: 'a', title: '甲' }, want: 'allow' },
  { op: 'rename', why: '顶层之间算同级（x 与 p 都在 root 下）', rule: { op: 'rename', id: 'x', title: '项目' }, want: 'reject', match: /同级不能同名/ },

  // ── create ────────────────────────────────────────────────────────────────
  { op: 'create', why: 'id 已存在', rule: { op: 'create', id: 'a', title: '新的', parents: ['p'] }, want: 'reject', match: /已存在/ },
  { op: 'create', id: 'root', why: 'id 不能是 root', rule: { op: 'create', id: 'root', title: '新的', parents: ['p'] }, want: 'reject', match: /root/ },
  { op: 'create', why: '空名字', rule: { op: 'create', id: 'new1', title: '', parents: ['p'] }, want: 'reject', match: /名字不能为空/ },
  { op: 'create', id: 'parent', why: '父不存在', rule: { op: 'create', id: 'new1', title: '新的', parents: ['没有'] }, want: 'reject', match: /没有父节点/ },
  { op: 'create', id: 'same', why: '同级撞名（p 下已有「甲」）', rule: { op: 'create', id: 'new1', title: '甲', parents: ['p'] }, want: 'reject', match: /同级不能同名/ },
  { op: 'create', why: '别的父下同名（合法）', rule: { op: 'create', id: 'new1', title: '甲', parents: ['x'] }, want: 'allow' },

  // ── delete ────────────────────────────────────────────────────────────────
  { op: 'delete', id: 'node', why: '不存在的节点', rule: { op: 'delete', id: '没有' }, want: 'reject', match: /没有这个节点/ },
  { op: 'delete', id: 'root', why: '不能删根', rule: { op: 'delete', id: 'root' }, want: 'reject', match: /不能删除根节点/ },
  { op: 'delete', why: '删普通枝（子树一起删，另有断言）', rule: { op: 'delete', id: 'c' }, want: 'allow' },

  // ── merge ─────────────────────────────────────────────────────────────────
  { op: 'merge', why: 'into 不存在', rule: { op: 'merge', from: ['c'], into: '没有' }, want: 'reject', match: /没有这个节点/ },
  { op: 'merge', why: 'from 都是 into 自己 ⇒ 没有可合并的', rule: { op: 'merge', from: ['a'], into: 'a' }, want: 'reject', match: /没有可合并的节点/ },
  { op: 'merge', id: 'node', why: 'from 里有不存在的节点', rule: { op: 'merge', from: ['没有'], into: 'a' }, want: 'reject', match: /没有这个节点/ },
  { op: 'merge', id: 'same', why: '带标题撞名（p 下已有「乙」= b）', rule: { op: 'merge', from: ['c'], into: 'a', title: '乙' }, want: 'reject', match: /同级不能同名/ },
  { op: 'merge', why: '普通合并', rule: { op: 'merge', from: ['c'], into: 'a' }, want: 'allow' },

  // ── reparent ──────────────────────────────────────────────────────────────
  { op: 'reparent', id: 'node', why: 'id 不存在', rule: { op: 'reparent', id: '没有', parents: ['root'] }, want: 'reject', match: /没有这个节点/ },
  { op: 'reparent', id: 'root', why: '不能改 root 的父', rule: { op: 'reparent', id: 'root', parents: ['p'] }, want: 'reject', match: /不能改 root/ },
  { op: 'reparent', id: 'parent', why: '父不存在', rule: { op: 'reparent', id: 'c', parents: ['没有'] }, want: 'reject', match: /没有父节点/ },
  { op: 'reparent', id: 'cycle', why: '成环（挂到自己的后代下）', rule: { op: 'reparent', id: 'a', parents: ['c'] }, want: 'reject', match: /会成环/ },
  // 第一版这两格我自己写错了：`c` 叫「具体」挪到 p 下根本不撞名；而 `a`（甲）挪到 p 下
  // **本来就撞**（b 也叫甲）——矩阵当场把"用例错"和"代码缺"分开，这正是它的价值。
  { op: 'reparent', id: 'same', why: '挪到已经有同名兄弟的父下（y「甲」挪到 p，p 下已有 a/b 都叫甲）', rule: { op: 'reparent', id: 'y', parents: ['p'] }, want: 'reject', match: /同级不能同名/ },
  { op: 'reparent', why: '挪到没有同名的地方（合法：c「具体」挪到 x 下）', rule: { op: 'reparent', id: 'c', parents: ['x'] }, want: 'allow' },
  { op: 'reparent', why: '多父里只要有一个父撞名就拒（y「甲」挪到 x + p，p 下有 a「甲」）', rule: { op: 'reparent', id: 'y', parents: ['x', 'p'] }, want: 'reject', match: /同级不能同名/ },
]

let bad = 0
const byOp = new Map()
for (const item of cases) {
  const problems = T.validateOverride(graph(), item.rule)
  const rejected = problems.length > 0
  const ok = item.want === 'reject' ? rejected && (item.match === undefined || item.match.test(problems.join('；'))) : !rejected
  if (!ok) bad += 1
  const key = item.op
  if (!byOp.has(key)) byOp.set(key, [])
  byOp.get(key).push({ ...item, ok, problems })
  console.log(
    `  ${ok ? '✓' : '✗'} [${item.op}] ${item.why}` +
      (ok ? '' : `  ← 期望 ${item.want}${item.match ? `（${item.match}）` : ''}，实际 ${rejected ? `拒：${problems.join('；')}` : '放行'}`),
  )
}

// **缺口视图**：每一格"这条约束在这个 op 上有没有被挡"
console.log('\n规则 × op 矩阵（✓ = 该 op 上这条约束被挡住）：')
const rules = ['同名', '成环', '父存在', '节点存在', '根保护']
const grid = {
  同名: { rename: 'same', create: 'same', merge: 'same', reparent: 'same', delete: null, setPlacement: null },
  成环: { reparent: 'cycle', create: null, rename: null, merge: null, delete: null, setPlacement: null },
  父存在: { create: 'parent', reparent: 'parent', rename: null, merge: null, delete: null, setPlacement: null },
  节点存在: { rename: 'node', create: null, merge: 'node', reparent: 'node', delete: 'node', setPlacement: 'sp-dead' },
  根保护: { delete: 'root', reparent: 'root', create: 'root', rename: null, merge: null, setPlacement: null },
}
const ops = ['setPlacement', 'rename', 'merge', 'create', 'delete', 'reparent']
console.log('  ' + '约束'.padEnd(8) + ops.map((o) => o.padEnd(13)).join(''))
for (const rule of rules) {
  const cells = ops.map((op) => {
    const label = grid[rule][op]
    if (label === null) return '—'.padEnd(13)  // 这条约束在这个 op 上不适用
    const found = (byOp.get(op) ?? []).find((c) => c.id === label)
    return (found === undefined ? '?' : found.ok ? '✓' : '✗').padEnd(13)
  })
  console.log('  ' + rule.padEnd(8) + cells.join(''))
}
console.log(`\n${cases.length - bad}/${cases.length} 项通过`)
process.exit(bad === 0 ? 0 : 1)
