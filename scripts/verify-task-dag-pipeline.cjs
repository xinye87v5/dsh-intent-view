#!/usr/bin/env node
/**
 * 任务结构流水线的**离线**断言（不调模型、不花钱）。
 *
 * 三件事：
 *
 * 1. **纯函数语义**：\`applyAssign\` / \`applyConsolidate\` / \`measure\` 的行为，
 *    尤其是 \`merge\` 真的会把归属搬过去（那是"两个兄弟合成一个"的唯一实现）；
 * 2. **措辞 lint**：这条线的结论是措辞级的，所以把"会掉分的那种写法"
 *    直接写成断言——例如"闲聊不算推进"（实测 3/3 → 1/3）；
 * 3. **文档一致性**：\`research/task-dag-pipeline.md\` 必须等于生成器的输出，
 *    否则"改了代码忘了改文档"就会让冻结版悄悄失真。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
  const P = await load('tools/probes/pipeline.mjs');
  // 生成器**语法坏了**也要报成一条失败项，而不是让整个校验脚本崩掉
  let renderDoc = null;
  let DOC = null;
  try {
    const mod = await load('tools/probes/render-pipeline-doc.mjs');
    renderDoc = mod.renderDoc;
    DOC = mod.DOC;
  } catch (error) {
    checks.push(['文档生成器能加载（语法/导入）', false, error.message.split('\n')[0].slice(0, 120)]);
  }

  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push([name, true, typeof detail === 'string' ? detail : '']);
    } catch (error) {
      checks.push([name, false, error.message.split('\n')[0].slice(0, 120)]);
    }
  };

  // ---- 1. 拼装 ----
  check('fillPrompt 替换全部占位符', () => {
    const out = P.fillPrompt(P.ASSIGN_PROMPT, { nodes: 'NODES_HERE', turns: 'TURNS_HERE' });
    assert.ok(out.includes('NODES_HERE') && out.includes('TURNS_HERE'));
    assert.ok(!out.includes('$NODES') && !out.includes('$TURNS'));
    return `${out.length} 字符`;
  });
  check('fillPrompt 对没有该占位符的段落报错', () => {
    assert.throws(() => P.fillPrompt('没有占位符', { nodes: 'x' }), /\$NODES/);
  });
  check('fillPrompt 不允许留下没换掉的占位符', () => {
    assert.throws(() => P.fillPrompt('$TURNS', {}), /没替换掉/);
  });

  // ---- 2. applyAssign ----
  check('applyAssign 保留多归属（两个落点都在）', () => {
    const next = P.applyAssign(P.emptyState(), {
      newNodes: { n1: { parents: ['root'], title: '甲' }, n2: { parents: ['n1'], title: '乙' } },
      placements: { 21: ['n1', 'n2'] },
    });
    assert.deepEqual(next.membership['21'], ['n1', 'n2']);
  });
  check('applyAssign 不接受 placements 里凭空出现的 id', () => {
    const next = P.applyAssign(P.emptyState(), { newNodes: {}, placements: { 1: ['n9'] } });
    assert.equal(next.membership['1'], undefined);
    assert.deepEqual(next.dropped, ['1:n9']);
  });
  check('applyAssign 去重但保留顺序', () => {
    const next = P.applyAssign(
      { nodes: { n1: { parents: ['root'], title: '甲' }, n2: { parents: ['root'], title: '乙' } }, membership: {} },
      { placements: { 3: ['n2', 'n1', 'n2'] } },
    );
    assert.deepEqual(next.membership['3'], ['n2', 'n1']);
  });
  check('applyAssign 不修改传入的 state（纯函数）', () => {
    const state = P.emptyState();
    const snapshot = JSON.stringify(state);
    P.applyAssign(state, { newNodes: { n1: { parents: ['root'], title: '甲' } }, placements: { 1: ['n1'] } });
    assert.equal(JSON.stringify(state), snapshot);
  });
  check('applyAssign 空落点不写入 membership（= 这句不推进任何事）', () => {
    const next = P.applyAssign(P.emptyState(), { placements: { 25: [] } });
    assert.deepEqual(Object.keys(next.membership), []);
  });

  // ---- 3. applyConsolidate ----
  check('merge 把 from 的归属搬进 into 并删掉 from', () => {
    const state = {
      nodes: { n1: { parents: ['root'], title: '甲' }, n2: { parents: ['root'], title: '乙' }, n3: { parents: ['root'], title: '丙' } },
      membership: { 23: ['n2'], 24: ['n3'], 25: ['n1'] },
    };
    const next = P.applyConsolidate(state, [{ op: 'merge', from: ['n2', 'n3'], into: 'n2', title: 'sudo 处理' }]);
    assert.deepEqual(Object.keys(next.nodes).sort(), ['n1', 'n2']);
    assert.deepEqual(next.membership['23'], ['n2']);
    assert.deepEqual(next.membership['24'], ['n2']);
    assert.equal(next.nodes.n2.title, 'sudo 处理');
    assert.deepEqual(next.membership['25'], ['n1'], '没被合到的回合不该动');
  });
  check('merge 后同一回合不会重复出现同一个 id', () => {
    const state = {
      nodes: { n1: { parents: ['root'], title: '甲' }, n2: { parents: ['root'], title: '乙' } },
      membership: { 5: ['n1', 'n2'] },
    };
    const next = P.applyConsolidate(state, [{ op: 'merge', from: ['n2'], into: 'n1' }]);
    assert.deepEqual(next.membership['5'], ['n1']);
  });
  check('retitle / reparent 生效', () => {
    const state = { nodes: { n1: { parents: ['root'], title: '旧' }, n2: { parents: ['root'], title: '父' } }, membership: {} };
    const next = P.applyConsolidate(state, [
      { op: 'retitle', id: 'n1', title: '新' },
      { op: 'reparent', id: 'n1', parents: ['n2'] },
    ]);
    assert.equal(next.nodes.n1.title, '新');
    assert.deepEqual(next.nodes.n1.parents, ['n2']);
  });
  check('认不出的 op 记进 unknown（而不是静默忽略）', () => {
    const next = P.applyConsolidate(P.emptyState(), [{ op: 'assign', turn: '1', nodes: ['n1'] }]);
    assert.deepEqual(next.unknown, ['assign']);
  });
  check('applyConsolidate 不修改传入的 state（纯函数）', () => {
    const state = { nodes: { n1: { parents: ['root'], title: '甲' } }, membership: { 1: ['n1'] } };
    const snapshot = JSON.stringify(state);
    P.applyConsolidate(state, [{ op: 'retitle', id: 'n1', title: '改' }]);
    assert.equal(JSON.stringify(state), snapshot);
  });

  // ---- 4. measure ----
  const sample = {
    nodes: {
      n1: { parents: ['root'], title: '部署脚本权限' },
      n2: { parents: ['n1'], title: 'sudo 处理' },
      n3: { parents: ['root'], title: '缓存目录权限配置' },
      n4: { parents: ['root'], title: '下雨闲聊' },
    },
    membership: {
      21: ['n4'], 22: ['n1', 'n2'], 23: ['n2'], 24: ['n2'], 25: ['n3'], 26: ['n1'], 27: ['n1'], 28: ['n1'], 29: ['n4'],
    },
  };
  check('measure：无归属回合列得出来', () => {
    const m = P.measure(sample, 30);
    const expected = [...Array(20)].map((_, i) => String(i + 1)).concat(['30']);
    assert.deepEqual(m.structural.uncovered, expected, '样本只覆盖了 21–29');
  });
  check('measure：引用不存在的 id 会被结构轴抓住', () => {
    const m = P.measure({ nodes: sample.nodes, membership: { 1: ['n99'] } }, 1);
    assert.equal(m.structural.idsResolve, false);
  });
  check('measure：父节点不存在会被结构轴抓住', () => {
    const m = P.measure({ nodes: { n1: { parents: ['nope'], title: '甲' } }, membership: { 1: ['n1'] } }, 1);
    assert.equal(m.structural.parentsResolve, false);
  });
  check('measure：sudo 合并判据认"只有一个 sudo 节点且 23/24 都挂它"', () => {
    const m = P.measure(sample, 29);
    assert.equal(m.sem.sudoMerged, true);
  });
  check('measure：sudo 有两个节点就算没合并', () => {
    const m = P.measure({ nodes: { ...sample.nodes, n5: { parents: ['root'], title: 'sudo 验证' } }, membership: sample.membership }, 29);
    assert.equal(m.sem.sudoMerged, false);
  });
  check('measure：#25 的判据要"全落在权限节点"', () => {
    assert.equal(P.measure(sample, 29).sem.only25, true);
    // n4（下雨闲聊）标题里没有"权限"，才是干净的"非权限节点"
    const bad = P.measure({ nodes: sample.nodes, membership: { ...sample.membership, 25: ['n3', 'n4'] } }, 29);
    assert.equal(bad.sem.only25, false, '#25 多挂了一个非权限节点时应判否');
  });
  check('measure：父子链只在真有祖先关系时算', () => {
    assert.equal(P.measure(sample, 29).sem.chain, 1, '#22 是 n1+n2（真父子）');
    const siblings = P.measure(
      { nodes: { a: { parents: ['root'], title: 'x' }, b: { parents: ['root'], title: 'y' } }, membership: { 22: ['a', 'b'], 26: ['a'], 27: ['a'], 28: ['a'] } },
      28,
    );
    assert.equal(siblings.sem.chain, 0, '两个兄弟不算父子链');
    assert.equal(siblings.sem.multi, 1, '但它仍算"两处落点"');
  });

  check('attachmentShape：单链（父与子）与异支（两件事）分得开', () => {
    const shape = P.attachmentShape({
      nodes: {
        p: { parents: ['root'], title: '父' }, c: { parents: ['p'], title: '子' },
        x: { parents: ['root'], title: '另一支' },
      },
      membership: { 1: ['p', 'c'], 2: ['p', 'x'], 3: ['c'] },
    });
    assert.deepEqual(shape, { zero: 0, single: 1, chain: 1, branch: 1 });
    assert.equal(P.attachmentShape({ nodes: {}, membership: {} }, 3).zero, 3, '零 = 没有归属的回合（1..total）');
  });
  check('attachmentShape：三个同链的落点也算单链', () => {
    const shape = P.attachmentShape({
      nodes: { a: { parents: ['root'], title: 'a' }, b: { parents: ['a'], title: 'b' }, c: { parents: ['b'], title: 'c' } },
      membership: { 1: ['a', 'b', 'c'] },
    });
    assert.equal(shape.chain, 1);
    assert.equal(shape.branch, 0);
  });

  // ---- 4b. 结构图 ----
  const treeState = {
    nodes: {
      n1: { parents: ['root'], title: '图文', kind: 'task' },
      n2: { parents: ['n1'], title: '角色', kind: 'task' },
      n3: { parents: ['n1', 'n2'], title: '两父节点', kind: 'task' },
      n9: { parents: ['root'], title: '题外话', kind: 'aside' },
      n8: { parents: ['nope'], title: '父缺失', kind: 'task' },
    },
    membership: { 1: ['n1'], 2: ['n1', 'n2'], 3: ['n3'], 4: ['n2'], 5: ['n3'], 6: ['n9'] },
  };
  const treeTurns = [1, 2, 3, 4, 5, 6, 7].map((turn) => ({ turn }));
  check('结构图：每个节点后面跟着它收的回合（区间压缩）', () => {
    const { text } = P.renderTree(treeState, treeTurns);
    assert.match(text, /n2 角色 ← #2、#4/);
    assert.match(text, /n3 两父节点 ← #3、#5/);
  });
  check('结构图：多父节点在每个父下都画，重复那次标 ↩', () => {
    const { text } = P.renderTree(treeState, treeTurns);
    assert.equal(text.split('n3 两父节点').length - 1, 2, 'n3 应该出现两次（n1 下与 n2 下）');
    assert.match(text, /↩ 同 n3/);
  });
  check('结构图：插话与父节点缺失都有标记', () => {
    const { text } = P.renderTree(treeState, treeTurns);
    assert.match(text, /n9 题外话 ← #6　\[插话\]/);
    assert.match(text, /⚠ 父节点缺失/);
  });
  check('结构图：没挂任何节点的回合单独列出来', () => {
    const { unattached } = P.renderTree(treeState, treeTurns);
    assert.deepEqual(unattached, [7]);
  });
  check('结构图：有环也画得出来（不会爆栈）', () => {
    const cyc = {
      nodes: { a: { parents: ['root'], title: 'a' }, b: { parents: ['a'], title: 'b' }, c: { parents: ['b'], title: 'c' } },
      membership: {},
    };
    cyc.nodes.a.parents = ['c'];
    let text = '';
    assert.doesNotThrow(() => { text = P.renderTree(cyc, [{ turn: 1 }]).text; });
    assert.match(text, /↻ 环/);
  });

  // ---- 4c. 祖先闭包 ----
  const chainState = {
    nodes: {
      r: { parents: ['root'], title: '项目' }, m: { parents: ['r'], title: '中' },
      c: { parents: ['m'], title: '具体' }, x: { parents: ['root'], title: '另一支' },
    },
    membership: { 1: ['c'], 2: ['x', 'c'], 3: [] },
  };
  check('祖先闭包：只挂具体节点时会补上整条祖先链', () => {
    const closed = P.closeUnderAncestors(chainState);
    assert.deepEqual(closed.membership['1'], ['c', 'm', 'r']);
  });
  check('祖先闭包：原有落点排在前面，已有的祖先不重复', () => {
    const closed = P.closeUnderAncestors(chainState);
    assert.deepEqual(closed.membership['2'], ['x', 'c', 'm', 'r']);
  });
  check('祖先闭包：空落点仍是空（不硬塞节点）', () => {
    assert.deepEqual(P.closeUnderAncestors(chainState).membership['3'], []);
  });
  check('祖先闭包：闭包后 isAncestorClosed 为真，闭包前为假', () => {
    assert.equal(P.isAncestorClosed(chainState), false);
    assert.equal(P.isAncestorClosed(P.closeUnderAncestors(chainState)), true);
  });
  check('祖先闭包：不改传入的 state（纯函数）', () => {
    const snapshot = JSON.stringify(chainState);
    P.closeUnderAncestors(chainState);
    assert.equal(JSON.stringify(chainState), snapshot);
  });

  check('最具体落点：去掉被同回合其它落点包含的祖先', () => {
    const s = P.mostSpecific(chainState);
    assert.deepEqual(s.membership['1'], ['c']);
    assert.deepEqual(s.membership['2'], ['x', 'c']);
  });
  check('最具体落点：幂等（跑两次一样）', () => {
    const once = P.mostSpecific(chainState);
    assert.deepEqual(P.mostSpecific(once), once);
  });
  check('最具体落点：与祖先闭包互逆（strip 后 fill 回到闭包）', () => {
    const closed = P.closeUnderAncestors(chainState);
    assert.deepEqual(P.closeUnderAncestors(P.mostSpecific(closed)).membership, closed.membership);
  });
  check('最具体落点：不改传入的 state（纯函数）', () => {
    const snapshot = JSON.stringify(chainState);
    P.mostSpecific(chainState);
    assert.equal(JSON.stringify(chainState), snapshot);
  });

  // ---- 4d. 根的报告（不设阈值、不合并） ----
  const threeRoots = {
    nodes: {
      p1: { parents: ['root'], title: '个人资料' }, p2: { parents: ['root'], title: '网页项目' },
      p3: { parents: ['root'], title: '岗位调研' }, a: { parents: ['root'], title: '题外话', kind: 'aside' },
      c: { parents: ['p2'], title: '子' },
    },
    membership: { 1: ['p1'], 3: ['p3'], 5: ['p2'], 6: ['c'], 9: ['a'] },
  };
  const flat = {
    nodes: {
      r1: { parents: ['root'], title: '甲' }, r2: { parents: ['root'], title: '乙' },
      r3: { parents: ['root'], title: '丙' }, r4: { parents: ['root'], title: '丁' },
      r5: { parents: ['root'], title: '戊' }, r6: { parents: ['root'], title: '己' },
      r7: { parents: ['root'], title: '庚' },
    },
    membership: { 1: ['r1'], 2: ['r2'], 3: ['r3'], 4: ['r4'], 5: ['r5'], 6: ['r6'], 7: ['r7'] },
  };
  const manyTurns = (n) => [...Array(n)].map((_, i) => ({ turn: i + 1, prompt: `第 ${i + 1} 件事` }));

  check('根的报告：多根**不被判失败**，也不合并（使用者裁定：按语义划分）', () => {
    const r = P.rootSummary(threeRoots, manyTurns(9));
    assert.deepEqual(r.projects.sort(), ['p1', 'p2', 'p3']);
    assert.equal(r.lines.find((l) => l.id === 'a').kind, 'aside');
    return `3 条非插话线 · ${r.note}`;
  });
  check('根的报告：给出每条线的**分叉点**（第一个回合）', () => {
    const r = P.rootSummary(threeRoots, manyTurns(9));
    assert.deepEqual(r.forks.map((f) => [f.title, f.at]), [['个人资料', 1], ['岗位调研', 3], ['网页项目', 5]]);
    return '这就是"任务演化在哪里分叉"';
  });
  check('根的报告：平铺 7 个根也照样如实报（不再当成要修的错误）', () => {
    const r = P.rootSummary(flat, manyTurns(7));
    assert.equal(r.projects.length, 7);
    assert.match(r.note, /7 条线/);
  });
  check('流水线不 reparent：finalize 只做 strip，根的父子关系原样', () => {
    const out = P.finalize(flat, manyTurns(7));
    for (const id of Object.keys(flat.nodes)) {
      assert.deepEqual(out.state.nodes[id].parents, flat.nodes[id].parents, `${id} 的 parents 被改了`);
    }
  });
  check('ensureProjectRoot 仍可用，但**默认不走**（保留给"硬压成一个项目"的展示模式）', () => {
    const merged = P.ensureProjectRoot(flat);
    assert.equal(merged.repaired, true);
    assert.equal(merged.reparented.length, 6);
    const src = fs.readFileSync(path.join(ROOT, 'tools/probes/run-pipeline.mjs'), 'utf8');
    assert.ok(!src.includes('ensureProjectRoot'), 'run-pipeline 不该调用它了');
  });

  // ---- 4e. 分批执行体（用假 completer 离线跑） ----
  const { runPipeline } = await load('tools/probes/run-pipeline.mjs');
  /** 假 completer：按提示词种类回罐头 JSON，并记录调用。 */
  function fakeComplete({ flat = false, splitGroups = false } = {}) {
    const seen = { build: 0, assign: 0, consolidate: 0, adjudicate: 0, assignTurns: [], adjudicateRoots: 0 };
    const reply = async (system, user) => {
      const nums = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
      if (user.includes('把一段人与 AI 的会话整理成')) {
        seen.build += 1;
        const nodes = {
          n1: { parents: ['root'], title: '项目' },
          n2: { parents: ['n1'], title: '子' },
          n3: { parents: ['n2'], title: '具体' },
        };
        if (flat) nodes.n9 = { parents: ['root'], title: '平铺的另一个顶层' };
        const membership = {};
        for (const t of nums) membership[String(t)] = [flat ? 'n9' : 'n2'];
        return JSON.stringify({ nodes, membership });
      }
      if (user.includes('只回 JSON，形状：{"placements"')) {
        seen.assign += 1;
        seen.assignTurns.push(nums);
        const placements = {};
        for (const t of nums) placements[String(t)] = t % 2 === 0 ? ['n2'] : ['n1', 'n3'];
        return JSON.stringify({ placements });
      }
      if (user.includes('只做**节点层面的整理**')) {
        seen.consolidate += 1;
        return JSON.stringify({ ops: [] });
      }
      if (user.includes('请把它们**分组**')) {
        seen.adjudicate += 1;
        seen.adjudicateRoots = user.match(/^\d+\) /gm)?.length ?? 0;
        // 平铺那两个根在同一组 → 应建一个项目节点；
        // `splitGroups` 时让它们各自成组 → 什么都不该发生
        return JSON.stringify(splitGroups
          ? { groups: [{ name: '甲', roots: [1] }, { name: '乙', roots: [2] }] }
          : { groups: [{ name: '合并后的项目', roots: [1, 2] }] });
      }
      throw new Error('假 completer 收到没预期的提示词：' + user.slice(0, 40));
    };
    return { seen, reply };
  }
  const fakeTurns = (n) => [...Array(n)].map((_, i) => ({ turn: i + 1, prompt: `第 ${i + 1} 件事` }));

  check('分批：建结构 1 次、判归属按 chunk 切、判整理 1 次', async () => {
    const fake = fakeComplete();
    const out = await runPipeline({ turns: fakeTurns(50), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.equal(fake.seen.build, 1);
    assert.equal(fake.seen.assign, 3, '50 回合 = 前 20 + 3 批（12/12/6）');
    assert.deepEqual(fake.seen.assignTurns.map((x) => x.length), [12, 12, 6]);
    assert.equal(fake.seen.consolidate, 1);
    assert.equal(out.batches, 3);
    return '真实会话 139 回合就是靠这个切';
  });
  check('分批：每一段只拿到那一段的回合（不重不漏）', async () => {
    const fake = fakeComplete();
    await runPipeline({ turns: fakeTurns(50), complete: fake.reply, firstWindow: 20, chunk: 12 });
    const flat = fake.seen.assignTurns.flat();
    assert.deepEqual(flat, [...Array(30)].map((_, i) => i + 21), '第 21–50 回合，顺序不乱');
  });
  check('分批：跑完每个回合都有归属（覆盖）', async () => {
    const fake = fakeComplete();
    const out = await runPipeline({ turns: fakeTurns(50), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.deepEqual(out.uncovered, []);
  });
  check('分批：strip 在收尾生效（祖先落点被折掉）', async () => {
    const fake = fakeComplete();
    const out = await runPipeline({ turns: fakeTurns(50), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.deepEqual(out.state.membership['21'], ['n3'], '奇数是 [n1,n3]，n1 是祖先该被折掉');
    assert.deepEqual(out.state.membership['22'], ['n2']);
    assert.ok(out.foldedAway > 0);
  });
  check('分批：平铺的根在收尾**原样保留**（不合并），但报告里列出来', async () => {
    const fake = fakeComplete({ flat: true });
    const out = await runPipeline({ turns: fakeTurns(24), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.equal(out.roots.projects.length, 2, 'n1 与 n9 都是非插话顶层，两个都留着');
    assert.equal(P.rootSummary(out.state, fakeTurns(24)).projects.length, 2);
  });

  // ---- 4f. 根裁定 ----
  check('根裁定：顶层只有 1 个非插话时**不问**（省一次调用）', async () => {
    const fake = fakeComplete();
    const out = await runPipeline({ turns: fakeTurns(24), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.equal(fake.seen.adjudicate, 0);
    assert.equal(out.adjudication.asked, false);
  });
  check('根裁定：顶层 ≥2 个时问一次；每组各自成组 → 一条都不合并', async () => {
    const fake = fakeComplete({ flat: true, splitGroups: true });
    const out = await runPipeline({ turns: fakeTurns(24), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.equal(fake.seen.adjudicate, 1, '只问一次');
    assert.equal(out.adjudication.applied, false);
    assert.equal(P.rootSummary(out.state, fakeTurns(24)).projects.length, 2, '两条线都留着（分叉保留）');
  });
  check('根裁定：同一组含 ≥2 条线 → 建项目节点并挂进去（应用它的语义判断）', async () => {
    const fake = fakeComplete({ flat: true });
    const out = await runPipeline({ turns: fakeTurns(24), complete: fake.reply, firstWindow: 20, chunk: 12 });
    assert.equal(out.adjudication.applied, true);
    assert.deepEqual(out.adjudication.merged.map((m) => [m.title, m.count]), [['合并后的项目', 2]]);
    const roots = P.rootSummary(out.state, fakeTurns(24));
    assert.equal(roots.projects.length, 1, '合并后只剩一个非插话顶层');
    assert.equal(roots.projects[0], 'project');
    assert.equal(out.state.nodes.project.title, '合并后的项目');
    assert.deepEqual(out.state.nodes.project.parents, ['root']);
  });
  check('根裁定：单元素组不建节点（那是分叉出来的独立线）', () => {
    const state = {
      nodes: { a: { parents: ['root'], title: '甲' }, b: { parents: ['root'], title: '乙' }, c: { parents: ['root'], title: '丙' } },
      membership: {},
    };
    const out = P.applyAdjudication(state, { groups: [{ name: '甲组', roots: [1, 2] }, { name: '丙', roots: [3] }] }, ['a', 'b', 'c']);
    assert.deepEqual(out.merged.map((m) => [m.title, m.count]), [['甲组', 2]]);
    assert.deepEqual(out.state.nodes.c.parents, ['root'], '丙仍留在顶层');
  });
  check('根裁定提示词：问分组、要 JSON、且不用被证伪的分类式问法', () => {
    assert.match(P.ADJUDICATE_PROMPT, /请把它们\*\*分组\*\*/);
    assert.match(P.ADJUDICATE_PROMPT, /json/i);
    assert.ok(!/几件独立的大事/.test(P.ADJUDICATE_PROMPT), '别用被证伪的分类式问法');
    assert.match(P.ADJUDICATE_PROMPT, /序号/, '要让它回序号，别抄标题');
  });

  // ---- 4g. 覆盖：承接语 / carryForward / 补问 ----
  check('承接语认得出来（含多词连用），但带新内容的不算', () => {
    for (const p of ['同意', '继续优化', '重试', '好的，继续任务', '嗯', 'OK', '可以']) {
      assert.equal(P.isContinuation(p), true, `${p} 该算承接语`);
    }
    for (const p of ['好的，那我们把 07 章重写一遍', '帮我看看 07 章的时间线', '同意，但请先改结局']) {
      assert.equal(P.isContinuation(p), false, `${p} 带新内容，不该算承接语`);
    }
  });
  check('carryForward：没归属的回合继承上一回合的落点', () => {
    const state = { nodes: {}, membership: { 1: ['a'], 3: ['b'] } };
    const out = P.carryForward(state, [{ turn: 1, prompt: '开工' }, { turn: 2, prompt: '同意' }, { turn: 3, prompt: '换话题' }]);
    assert.deepEqual(out.state.membership['2'], ['a']);
    assert.deepEqual(out.inherited, [{ turn: 2, from: 1, continuation: true }]);
  });
  check('carryForward：开头的空回合向后继承；不改传入 state', () => {
    const state = { nodes: {}, membership: { 2: ['a'] } };
    const snapshot = JSON.stringify(state);
    const out = P.carryForward(state, [{ turn: 1, prompt: '同意' }, { turn: 2, prompt: '干活' }]);
    assert.deepEqual(out.state.membership['1'], ['a']);
    assert.equal(JSON.stringify(state), snapshot);
  });
  check('覆盖：实质回合漏了会**补问一次**，承接语不浪费调用', async () => {
    // 建结构只给第 1 回合归属；第 2 回合是承接语、第 3 回合是实质内容
    const seen = { assign: 0, askedTurns: [] };
    const reply = async (system, user) => {
      const nums = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
      if (user.includes('把一段人与 AI 的会话整理成')) {
        return JSON.stringify({ nodes: { n1: { parents: ['root'], title: '项目' } }, membership: { 1: ['n1'] } });
      }
      if (user.includes('只回 JSON，形状：{"placements"')) {
        seen.assign += 1;
        seen.askedTurns.push(nums);
        return JSON.stringify({ placements: Object.fromEntries(nums.map((t) => [String(t), ['n1']])) });
      }
      if (user.includes('只做**节点层面的整理**')) return JSON.stringify({ ops: [] });
      throw new Error('假 completer 收到没预期的提示词：' + user.slice(0, 40));
    };
    const turns = [{ turn: 1, prompt: '开工' }, { turn: 2, prompt: '同意' }, { turn: 3, prompt: '帮我看看第 07 章的时间线' }];
    const out = await runPipeline({ turns, complete: reply, firstWindow: 1, chunk: 12 });
    assert.equal(seen.assign, 1, '只补问一次');
    assert.deepEqual(seen.askedTurns[0], [3], '只问那个实质回合（承接语交给 carryForward）');
    assert.equal(out.coverage.reasked, 1);
    assert.equal(out.coverage.inheritedContinuations, 1);
    assert.equal(out.coverage.stillMissing, 0);
    assert.deepEqual(out.uncovered, [], '最后不该有缺归属的回合');
  });

  // ---- 4h. 组名质量 ----
  check('提示词要求"名字说明这件事是什么"，并禁止动作名', () => {
    assert.match(P.ADJUDICATE_PROMPT, /名字要说明这件事/);
    assert.match(P.ADJUDICATE_PROMPT, /不要描述"分组"这个动作/);
  });
  check('动作名认得出来', () => {
    for (const n of ['会话节点分组', '节点归类', '分组']) assert.equal(P.isMetaName(n), true, n);
    for (const n of ['个人资料制作', '京都行程规划', '小说示例小说修订']) assert.equal(P.isMetaName(n), false, n);
  });
  check('兜底：动作名 → 用该组第一个根的标题当项目名（并记下原名）', () => {
    const state = {
      nodes: { a: { parents: ['root'], title: '创建个人资料文件夹' }, b: { parents: ['root'], title: '基础信息' } },
      membership: {},
    };
    const out = P.applyAdjudication(state, { groups: [{ name: '会话节点分组', roots: [1, 2] }] }, ['a', 'b']);
    assert.equal(out.merged[0].title, '创建个人资料文件夹', '不该把动作名当项目名');
    assert.equal(out.merged[0].asked, '会话节点分组', '原名要留着，便于量');
    assert.equal(out.merged[0].renamed, true);
    assert.equal(out.state.nodes.project.title, '创建个人资料文件夹');
  });
  check('好名字原样保留', () => {
    const state = { nodes: { a: { parents: ['root'], title: '甲' }, b: { parents: ['root'], title: '乙' } }, membership: {} };
    const out = P.applyAdjudication(state, { groups: [{ name: '个人资料制作', roots: [1, 2] }] }, ['a', 'b']);
    assert.equal(out.merged[0].title, '个人资料制作');
    assert.equal(out.merged[0].renamed, false);
  });

  check('占位符：roots 能注入，且拼好的提示词里不许出现 undefined', () => {
    const out = P.fillPrompt(P.ADJUDICATE_PROMPT, { roots: '1) 甲（3 个回合）' });
    assert.ok(out.includes('1) 甲（3 个回合）'));
    assert.ok(!out.includes('undefined'), '这正是一整批数据作废的原因');
    assert.ok(!out.includes('$ROOTS'));
    assert.throws(() => P.fillPrompt('没有占位符', { roots: 'x' }), /\$ROOTS/);
  });
  check('占位符：漏填会报错（不能悄悄发出去）', () => {
    assert.throws(() => P.fillPrompt(P.ADJUDICATE_PROMPT, {}), /没替换掉的占位符/);
  });

  check('多轮裁定：第一轮各自成组、第二轮才合并 → 问两次', async () => {
    let asked = 0;
    const reply = async (system, user) => {
      const nums = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
      if (user.includes('把一段人与 AI 的会话整理成')) {
        return JSON.stringify({
          nodes: { a: { parents: ['root'], title: '甲' }, b: { parents: ['root'], title: '乙' } },
          membership: Object.fromEntries(nums.map((t) => [String(t), ['a']])),
        });
      }
      if (user.includes('只回 JSON，形状：{"placements"')) {
        return JSON.stringify({ placements: Object.fromEntries(nums.map((t) => [String(t), ['b']])) });
      }
      if (user.includes('只做**节点层面的整理**')) return JSON.stringify({ ops: [] });
      if (user.includes('请把它们**分组**')) {
        asked += 1;
        return asked === 1
          ? JSON.stringify({ groups: [{ name: '甲', roots: [1] }, { name: '乙', roots: [2] }] })
          : JSON.stringify({ groups: [{ name: '合起来的一件事', roots: [1, 2] }] });
      }
      throw new Error('没预期的提示词：' + user.slice(0, 40));
    };
    const out = await runPipeline({ turns: fakeTurns(6), complete: reply, firstWindow: 5, chunk: 6, adjudicationRounds: 2 });
    assert.equal(asked, 2, '该问两轮');
    assert.equal(out.adjudication.rounds.length, 2);
    assert.equal(P.rootSummary(out.state, fakeTurns(6)).projects.length, 1, '第二轮把它俩并成一个项目');
  });
  check('多轮裁定：上一轮什么都没并 → 不再问第二轮（省调用）', async () => {
    let asked = 0;
    const reply = async (system, user) => {
      const nums = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
      if (user.includes('把一段人与 AI 的会话整理成')) {
        return JSON.stringify({
          nodes: { a: { parents: ['root'], title: '甲' }, b: { parents: ['root'], title: '乙' } },
          membership: Object.fromEntries(nums.map((t) => [String(t), ['a']])),
        });
      }
      if (user.includes('只回 JSON，形状：{"placements"')) {
        return JSON.stringify({ placements: Object.fromEntries(nums.map((t) => [String(t), ['b']])) });
      }
      if (user.includes('只做**节点层面的整理**')) return JSON.stringify({ ops: [] });
      if (user.includes('请把它们**分组**')) {
        asked += 1;
        return JSON.stringify({ groups: [{ name: '甲', roots: [1] }, { name: '乙', roots: [2] }] });
      }
      throw new Error('没预期的提示词：' + user.slice(0, 40));
    };
    const out = await runPipeline({ turns: fakeTurns(6), complete: reply, firstWindow: 5, chunk: 6, adjudicationRounds: 3 });
    assert.equal(asked, 1, '第一轮没并出东西，后面不该再问');
    assert.equal(out.adjudication.rounds.length, 1);
  });

  // ---- 5. 措辞 lint ----
  const badPhrases = ['闲聊不算推进', '闲聊**不算推进', '闲聊不算'];
  check('ASSIGN 提示词里没有"闲聊不算推进"这类负面写法', () => {
    for (const bad of badPhrases) assert.ok(!P.ASSIGN_PROMPT.includes(bad), `出现禁用措辞：${bad}`);
    return '实测：这句会把 #21 两处从 3/3 打到 1/3';
  });
  check('ASSIGN 里"闲聊"必须与"不算推进"同句、且正着说', () => {
    // 同句：负面与正面在一句里，实测 3/3；拆成两个 bullet 会掉回 1 处落点（我踩过）
    assert.match(P.ASSIGN_PROMPT, /不算推进\*\*；闲聊若有自己的节点也算一个落点/);
    const chitchatBullets = P.ASSIGN_PROMPT.split('\n').filter((l) => l.startsWith('- ') && l.includes('闲聊'));
    assert.equal(chitchatBullets.length, 1, '关于闲聊的 bullet 只能有一条（且它与"不算推进"同句）');
    assert.ok(chitchatBullets[0].includes('不算推进'), '这一条必须自己就带着"不算推进"那半句');
  });
  check('第二段不给 ops 词汇表（不给 assign 例子）', () => {
    assert.ok(!P.ASSIGN_PROMPT.includes('"op"'), 'ASSIGN 里不该出现 op');
    assert.ok(!/"op"\s*:\s*"assign"/.test(P.ASSIGN_PROMPT));
    return '给了会退化成"一个回合一个落点"';
  });
  check('第三段只让它看节点（提示词里说明不含回合归属）', () => {
    assert.match(P.CONSOLIDATE_PROMPT, /不含回合归属/);
  });
  check('三段提示词都含 "json"（API 的硬要求）', () => {
    for (const [name, p] of [['BUILD', P.BUILD_PROMPT], ['ASSIGN', P.ASSIGN_PROMPT], ['CONSOLIDATE', P.CONSOLIDATE_PROMPT]]) {
      assert.ok(/json/i.test(p), `${name} 里没有 json 字样 → response_format 会 400`);
    }
  });
  check('建结构那段保留"父节点是纯容器"的原措辞', () => {
    assert.match(P.BUILD_PROMPT, /父节点是\*\*纯容器\*\*/);
    return '换成"父子都要挂"实测把 sudo 合并从 3/3 打到 1/3';
  });
  check('三段都要求 id 用字符串 / 值是列表', () => {
    assert.match(P.BUILD_PROMPT, /id 用字符串/);
    assert.match(P.BUILD_PROMPT, /节点 id 的\*\*列表\*\*/);
    assert.match(P.ASSIGN_PROMPT, /"21":\["n5","n9"\]/);
  });

  check('两个入口都走唯一的执行体 runPipeline（闸门 + strip 都在里面）', () => {
    for (const rel of ['tools/probes/label-sheet.mjs', 'tools/probes/pipeline-stability.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.match(src, /runPipeline\(/, `${rel} 没有走 runPipeline`);
    }
  });
  check('冻死水线文档写了"根的数量按语义、不设阈值"', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'research/task-dag-pipeline.md'), 'utf8');
    assert.ok(doc.includes('不设阈值'), '文档里没有这条裁定');
    assert.ok(doc.includes('分叉'), '没提分叉点这个信号');
  });
  check('冻死水线文档写了"存最具体落点"这条规则', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'research/task-dag-pipeline.md'), 'utf8');
    assert.ok(doc.includes('存最具体落点'), '文档里没有这条');
    assert.ok(doc.includes('closeUnderAncestors'), '文档没说怎么展开');
  });

  // ---- 6. 文档一致性 ----
  check('research/task-dag-pipeline.md 与生成器逐字一致', () => {
    assert.ok(renderDoc !== null, '生成器没加载成功，见上面那条');
    const onDisk = fs.readFileSync(DOC, 'utf8');
    assert.equal(onDisk, renderDoc());
    return `${onDisk.length} 字符`;
  });
  check('文档里三段提示词都是逐字注入的', () => {
    assert.ok(renderDoc !== null, '生成器没加载成功，见上面那条');
    const doc = fs.readFileSync(DOC, 'utf8');
    for (const [name, p] of [['BUILD', P.BUILD_PROMPT], ['ASSIGN', P.ASSIGN_PROMPT], ['CONSOLIDATE', P.CONSOLIDATE_PROMPT]]) {
      for (const line of p.split('\n').filter((l) => l.trim() !== '')) {
        assert.ok(doc.includes(line), `${name} 的这一行没出现在文档里：${line.slice(0, 40)}`);
      }
    }
  });

  let bad = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) bad += 1;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  return bad === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
