#!/usr/bin/env node
/**
 * **交接摘要**（`src/shared/handoff.ts`）的断言：选择集口径 + 文本形状。
 *
 * 这一层不碰模型、不碰网络（阶段 1 是"秒出的确定性草稿"），所以能离线钉死：
 * 同一份选择永远得到同一份文本——面板、模型精炼、断言三处共用这一份实现。
 */
const path = require('node:path')
const ROOT = path.resolve(__dirname, '..')

const checks = []
const ok = (name, cond, detail) => checks.push([name, Boolean(cond), detail === undefined ? '' : String(detail)])

;(async () => {
  const H = await import(path.join(ROOT, 'lib', 'shared', 'handoff.js'))

  // ── 选择集口径 ──────────────────────────────────────────────────────────
  const nodes = {
    n1: { parents: ['root'], title: '甲项目' },
    n2: { parents: ['n1'], title: '甲的子' },
    n3: { parents: ['n2'], title: '甲的孙' },
    n4: { parents: ['root'], title: '乙线' },
  }
  const membership = { 1: ['n1'], 2: ['n2'], 3: ['n3'], 4: ['n1'], 5: ['n4'] }

  ok('subtreeTurns：整棵子树（含孙）',
    JSON.stringify(H.subtreeTurns(nodes, membership, 'n1')) === JSON.stringify([1, 2, 3, 4]),
    JSON.stringify(H.subtreeTurns(nodes, membership, 'n1')))
  ok('subtreeTurns：叶子只有自己',
    JSON.stringify(H.subtreeTurns(nodes, membership, 'n3')) === JSON.stringify([3]))
  ok('subtreeTurns：不碰别的枝',
    JSON.stringify(H.subtreeTurns(nodes, membership, 'n4')) === JSON.stringify([5]))

  // 环（多父 + 人工编辑可能造出来）：不许死循环
  const cyclic = { a: { parents: ['b'] }, b: { parents: ['a'] } }
  ok('subtreeTurns：环里不死循环', Array.isArray(H.subtreeTurns(cyclic, { 1: ['a'] }, 'a')))

  ok('selectedTurns：枝的整棵 + 单独勾的回合，去重升序',
    JSON.stringify(H.selectedTurns(nodes, membership, ['n3'], [1, 4, 4])) === JSON.stringify([1, 3, 4]),
    JSON.stringify(H.selectedTurns(nodes, membership, ['n3'], [1, 4, 4])))

  ok('fullySelectedNodes：整枝拿全才报它（部分选中的不算）',
    JSON.stringify(H.fullySelectedNodes(nodes, membership, ['n1', 'n2'], [1, 2, 3, 4])) === JSON.stringify(['n1', 'n2']) &&
    JSON.stringify(H.fullySelectedNodes(nodes, membership, ['n1', 'n2'], [1, 3, 4])) === JSON.stringify([]))

  ok('toggleTurn：勾上/取消都保持升序',
    JSON.stringify(H.toggleTurn([1, 3], 2)) === JSON.stringify([1, 2, 3]) &&
    JSON.stringify(H.toggleTurn([1, 2, 3], 2)) === JSON.stringify([1, 3]))
  ok('toggleBranch：先整棵铺开，再点一次整棵取消',
    JSON.stringify(H.toggleBranch([], [1, 2, 3, 4])) === JSON.stringify([1, 2, 3, 4]) &&
    JSON.stringify(H.toggleBranch([1, 2, 3, 4], [1, 2, 3, 4])) === JSON.stringify([]))
  ok('toggleBranch：铺开之后能单独取消某个回合（"之后就是可选"）',
    JSON.stringify(H.toggleTurn(H.toggleBranch([], [1, 2, 3, 4]), 3)) === JSON.stringify([1, 2, 4]))
  ok('toggleBranch：部分选中时点是"补齐"而不是"取消"',
    JSON.stringify(H.toggleBranch([1, 2], [1, 2, 3, 4])) === JSON.stringify([1, 2, 3, 4]))
  ok('toggleBranch：空枝不动选择', JSON.stringify(H.toggleBranch([2], [])) === JSON.stringify([2]))

  // ── 文本形状 ────────────────────────────────────────────────────────────
  const turns = [
    { turn: 1, task: '甲项目', ask: '把示例资料汇总成表', did: '整理示例资料' },
    { turn: 2, task: '甲的子', ask: '用另一份材料核对', did: '核对示例来源' },
    { turn: 3, task: '甲的孙', ask: '顺手问一句无关的', did: '记下了这个问题' },
    { turn: 4, task: '甲项目', ask: '继续优化表格', did: '整理示例资料' },
  ]
  const outline = [
    { id: 'n1', title: '甲项目', depth: 0, turns: [1, 4] },
    { id: 'n2', title: '甲的子', depth: 1, turns: [2] },
    { id: 'n3', title: '甲的孙', depth: 2, turns: [3] },
    { id: 'n4', title: '乙线', depth: 0, turns: [5] },
  ]
  const input = {
    sessionId: 'session-abcd1234-demo', sessionTitle: '示例会话', goal: '把示例资料整理成表',
    turns, outline, nodeIds: ['n1', 'n2'],
  }

  const withTitles = H.handoffDraft(input, { withTitles: true })
  ok('草稿：写明是快照（不写会被当成活的）', withTitles.text.includes('快照') && withTitles.text.includes('不会同步'))
  // 会话 id 要**去掉 `session-` 前缀**再截（否则显示出来的就是 `session-` 本身——实测踩到）
  ok('草稿：带来源与回合范围（id 去掉前缀）',
    withTitles.text.includes('abcd1234') && !withTitles.text.includes('会话 session-') &&
    withTitles.text.includes('#1–#4'))
  ok('草稿：**保留层级**（子枝比父枝多缩进）',
    /\n- 甲项目/.test(withTitles.text) &&
    /\n {2}- 甲的子/.test(withTitles.text) &&
    /\n {4}- 甲的孙/.test(withTitles.text),
    JSON.stringify(withTitles.text.split('\n').filter((l) => l.startsWith('- ') || /^\s+- /.test(l))))
  ok('草稿：没选中的枝不进结构（乙线回合 #5 不在）',
    !withTitles.text.includes('乙线') && !withTitles.text.includes('#5'))
  ok('草稿：回合要点带"用户指令 + agent 理解"两列',
    withTitles.text.includes('用户：把示例资料汇总成表') && withTitles.text.includes('agent 理解：整理示例资料'))
  ok('草稿：不带枝名时**不出结构段**（要么给层级、要么不给，不许拍平）',
    !H.handoffDraft(input, { withTitles: false }).text.includes('任务结构'))
  ok('草稿：不带枝名时回合行也不带枝名',
    !H.handoffDraft(input, { withTitles: false }).text.includes('甲项目'))
  ok('草稿：同一份输入永远同一份文本（确定性）',
    H.handoffDraft(input, { withTitles: true }).text === withTitles.text)
  ok('草稿：turns 回填的是进正文的回合（升序）',
    JSON.stringify(withTitles.turns) === JSON.stringify([1, 2, 3, 4]))
  // 截断：正文只带要点（1000 字的指令 → 200 字 + 省略号；整行也不会超预算）
  const longText = H.handoffDraft(
    { ...input, turns: [{ turn: 1, task: 'x', ask: '很长的指令'.repeat(200), did: '' }] },
    { withTitles: false },
  ).text
  ok('草稿：超长材料被截断到要点长度（并留省略号）',
    longText.includes('…') && Math.max(...longText.split('\n').map((l) => l.length)) < 260,
    `最长行 ${Math.max(...longText.split('\n').map((l) => l.length))} 字`)

  // ── 宿主那条精炼路由（阶段 2）：软降级是硬要求 ──────────────────────────
  const HOST = await import(path.join(ROOT, 'lib', 'host', 'handoffUnit.js'))
  const chunked = (text) => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  })()
  const req = (body) => ({ json: async () => body })
  const deps = (over) => ({ route: { provider: 'p', model: 'm' }, ...over })

  {
    const res = await HOST.handleHandoffRequest(req({ sessionId: 's', draft: '# 交接摘要\n…' }),
      deps({ llm: { stream: () => chunked('## 目标\n把示例资料整理成表') } }))
    ok('精炼：成功回 ok:true + 正文 + 耗时', res.status === 200 && res.body.ok === true &&
      String(res.body.text).includes('## 目标') && typeof res.body.meta.elapsedMs === 'number',
      JSON.stringify({ status: res.status, ok: res.body.ok }))
  }
  ok('精炼：宿主没有 llm ⇒ ok:false（面板保留草稿，不报崩溃）',
    (await HOST.handleHandoffRequest(req({ sessionId: 's', draft: 'x' }), deps({ llm: undefined }))).body.ok === false)
  ok('精炼：草稿为空 ⇒ 400', (await HOST.handleHandoffRequest(req({ sessionId: 's', draft: '  ' }), deps({}))).status === 400)
  ok('精炼：缺 sessionId ⇒ 400', (await HOST.handleHandoffRequest(req({ draft: 'x' }), deps({}))).status === 400)
  {
    const boom = { stream: () => (async function* () { throw new Error('假的模型故障') })() }
    const res = await HOST.handleHandoffRequest(req({ sessionId: 's', draft: 'x' }), deps({ llm: boom }))
    ok('精炼：模型抛错 ⇒ HTTP 200 + ok:false（软降级，不是 500）',
      res.status === 200 && res.body.ok === false && /假的模型故障/.test(String(res.body.error)))
  }
  ok('精炼：空文本也算失败（不许把空正文塞进预览）',
    (await HOST.handleHandoffRequest(req({ sessionId: 's', draft: 'x' }), deps({ llm: { stream: () => chunked('') } }))).body.ok === false)

  let bad = 0
  for (const [name, cond, detail] of checks) {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
    if (!cond) bad += 1
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`)
  process.exit(bad === 0 ? 0 : 1)
})()
