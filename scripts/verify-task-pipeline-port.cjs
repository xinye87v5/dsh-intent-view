#!/usr/bin/env node
/**
 * **交叉校验**：搬进 `src/shared/taskPipeline.ts` 的那份，与它来自的研究工具
 * `tools/probes/pipeline.mjs` 必须**逐字一致**。
 *
 * 为什么值得单独一个脚本：这份流水线现在有**两处**存在——研究工具（跑真实会话、
 * 出结论）与插件（面板要用）。两边一旦漂移，"研究里验证过的"就不再等于
 * "插件里跑着的"，而那种漂移**不会报错**，只会让结论悄悄失效。
 * 本项目在 `splitlines` vs `split('\n')` 上吃过一次同样的亏。
 *
 * 校验两件事：
 * 1. **提示词逐字相同**（四段 + 系统提示 + 占位符表）——措辞级结论全靠它；
 * 2. **同一批状态 + 同一批操作 → 结果相同**（assign / consolidate / adjudicate /
 *    carryForward / rootSummary / finalize / 两个归一化）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'tools', 'probes', '.out');

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 140)]);
  }
};

(async () => {
  const probe = await import(pathToFileURL(path.join(ROOT, 'tools', 'probes', 'pipeline.mjs')).href);
  const port = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
  const graph = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));

  // ---- 1. 提示词逐字 ----
  for (const key of ['BUILD_PROMPT', 'ASSIGN_PROMPT', 'CONSOLIDATE_PROMPT', 'ADJUDICATE_PROMPT', 'SYS']) {
    check(`提示词逐字一致：${key}`, () => {
      assert.equal(port[key], probe[key], `${key} 两边不同——措辞级结论会失效`);
      return `${port[key].length} 字符`;
    });
  }
  check('占位符表一致', () => {
    assert.deepEqual(port.PLACEHOLDERS, probe.PLACEHOLDERS);
  });
  check('承接语正则一致（含多词连用与 12 字上限）', () => {
    for (const p of ['同意', '继续优化', '好的，继续任务', '重试', '好的，那我们把 07 章重写一遍']) {
      assert.equal(port.isContinuation(p), probe.isContinuation(p), p);
    }
    return '五种代表性输入判定相同';
  });

  // ---- 2. 同一批状态 + 操作 → 同一结果 ----
  //
  // **夹具必须进库**：这一段原来只找 `tools/probes/.out/` 里的真机产物，而那个目录是
  // gitignore 的——于是**干净检出（发布后使用者 `npm install && npm run build`）必然失败**，
  // 报"没找到夹具"。现在第一顺位是 `tools/probes/fixtures/` 里那份**合成**状态
  // （含多父 aside，专门压 `↩ 同 nX` 与插话那两条路径）；本地的真机产物仍可作为候选。
  const FIXTURE_DIRS = [path.join(ROOT, 'tools', 'probes', 'fixtures'), OUTDIR];
  const candidates = ['pipeline-state-synthetic.json', 'fairytale-run2.json', 'travel-run3.json'];
  let fixture;
  let label = '';
  for (const name of candidates) {
    for (const dir of FIXTURE_DIRS) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) { fixture = candidate; label = name; break; }
    }
    if (fixture !== undefined) break;
  }
  if (fixture === undefined) {
    checks.push(['找到一份状态夹具（合成那份必须进库）', false, `没找到：${candidates.join(' / ')}`]);
  } else {
    const state = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    const turns = Object.keys(state.membership).map((t) => ({ turn: Number(t), prompt: `第 ${t} 回合` }));
    // 造几个承接语回合，专门压 carryForward 那条路径
    for (let t = 1; t <= 6; t += 1) delete state.membership[String(t)];
    turns.slice(0, 6).forEach((t) => { t.prompt = '继续优化'; });

    const ops = [
      { op: 'merge', from: Object.keys(state.nodes).slice(0, 2), into: Object.keys(state.nodes)[2], title: '合并后' },
      { op: 'retitle', id: Object.keys(state.nodes)[3], title: '改过的名字' },
    ];
    const assignReply = { placements: Object.fromEntries(turns.slice(0, 6).map((t) => [String(t.turn), [Object.keys(state.nodes)[0]]])) };
    const adjudication = { groups: [{ name: '会话节点分组', roots: [1, 2, 3] }] };

    check(`两个归一化一致（夹具 ${label}）`, () => {
      assert.deepEqual(graph.mostSpecific(state), probe.mostSpecific(state));
      return 'mostSpecific';
    });
    check('closeUnderAncestors 一致', () => {
      const a = graph.closeUnderAncestors(state).membership;
      const b = probe.closeUnderAncestors(state).membership;
      assert.deepEqual(a, b);
    });
    check('applyAssign 一致', () => {
      assert.deepEqual(port.applyAssign(state, assignReply), probe.applyAssign(state, assignReply));
    });
    check('applyConsolidate 一致（merge + retitle）', () => {
      assert.deepEqual(port.applyConsolidate(state, ops), probe.applyConsolidate(state, ops));
    });
    check('applyAdjudication 一致（含动作名兜底改名）', () => {
      const rootIds = Object.keys(state.nodes).filter((id) => state.nodes[id].parents.includes('root'));
      assert.deepEqual(
        port.applyAdjudication(state, adjudication, rootIds),
        probe.applyAdjudication(state, adjudication, rootIds),
      );
    });
    check('carryForward 一致（含承接语判定）', () => {
      assert.deepEqual(port.carryForward(state, turns), probe.carryForward(state, turns));
    });
    check('rootSummary 一致（含分叉点）', () => {
      assert.deepEqual(port.rootSummary(state, turns), probe.rootSummary(state, turns));
    });
    check('finalize 一致（strip + 根报告）', () => {
      assert.deepEqual(port.finalize(state, turns), probe.finalize(state, turns));
    });
    check('renderRoots 一致（提示词里那份编号清单）', () => {
      assert.equal(port.renderRoots(state, turns), probe.renderRoots(state, turns));
    });
    check('treeRows 一致（渲染树的原料，含多父的 ↩ 标记）', () => {
      // 只比 rows/unattached：`compress` 是个函数，deepEqual 比不了（也不该比）
      const a = port.treeRows(state, turns)
      const b = probe.treeRows(state, turns)
      assert.deepEqual(a.rows, b.rows)
      assert.deepEqual(a.unattached, b.unattached);
      const notes = port.treeRows(state, turns).rows.flatMap((r) => r.notes);
      return notes.length > 0 ? `含标记：${[...new Set(notes)].join('、')}` : '这份夹具没有多父/插话标记';
    });
    check('renderTree 一致（带引导线的树状文本）', () => {
      const a = port.renderTree(state, turns)
      const b = probe.renderTree(state, turns)
      assert.equal(a.text, b.text);
      assert.deepEqual(a.unattached, b.unattached);
      return `${a.text.split('\n').length} 行`;
    });
    check('renderTurns / nodeList 一致', () => {
      assert.equal(port.renderTurns(turns), probe.renderTurns(turns));
      assert.equal(port.nodeList(state.nodes), probe.nodeList(state.nodes));
    });
  }

  let bad = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) bad += 1;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  process.exit(bad === 0 ? 0 : 1);
})();
