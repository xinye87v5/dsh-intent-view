#!/usr/bin/env node
/**
 * 折叠树的两件纯逻辑（离线）：`nestRows` 与 `descendantCount`。
 *
 * 为什么要单独测：`treeRows` 是**扁平的**（深度 + 顺序），而面板要嵌套。
 * 这个转换一旦错位，症状是"某几个节点挂到了错误的父下"——在几十个节点的
 * 真实会话里肉眼很难发现，所以在这里按结构断言。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));

const row = (id, depth, extra = {}) => ({ id, depth, cycle: false, parentIds: [], title: id, kind: 'task', turns: [], notes: [], ...extra });

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 130)]);
  }
};

check('线性嵌套：a > b > c', () => {
  const out = P.nestRows([row('a', 0), row('b', 1), row('c', 2)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].children[0].row.id, 'b');
  assert.equal(out[0].children[0].children[0].row.id, 'c');
});
check('兄弟：同级不互挂', () => {
  const out = P.nestRows([row('a', 0), row('b', 1), row('c', 1)]);
  assert.equal(out[0].children.length, 2);
  assert.deepEqual(out[0].children.map((x) => x.row.id), ['b', 'c']);
});
check('深度回退：回到上层后挂在正确的父下', () => {
  // a / b(d1) / c(d2) / d(d1) / e(d2)
  const out = P.nestRows([row('a', 0), row('b', 1), row('c', 2), row('d', 1), row('e', 2)]);
  assert.deepEqual(out[0].children.map((x) => x.row.id), ['b', 'd']);
  assert.deepEqual(out[0].children[1].children.map((x) => x.row.id), ['e']);
});
check('多个顶层：各自成根', () => {
  const out = P.nestRows([row('a', 0), row('b', 1), row('c', 0)]);
  assert.equal(out.length, 2);
  assert.equal(out[1].row.id, 'c');
});
check('多父重复行（↩ 同 nX）各自嵌进各自的父下', () => {
  const out = P.nestRows([
    row('a', 0), row('shared', 1, { notes: ['↩ 同 shared'] }), row('b', 0), row('shared', 1, { notes: ['↩ 同 shared'] }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].children[0].row.id, 'shared');
  assert.equal(out[1].children[0].row.id, 'shared');
  return '同一节点在两棵子树里各出现一次';
});
check('空输入 → 空树', () => {
  assert.deepEqual(P.nestRows([]), []);
});
check('descendantCount 数后代（不含自己）', () => {
  const out = P.nestRows([row('a', 0), row('b', 1), row('c', 2), row('d', 1)]);
  assert.equal(P.descendantCount(out[0]), 3);
  assert.equal(P.descendantCount(out[0].children[0]), 1);
  assert.equal(P.descendantCount(out[0].children[1]), 0);
});
check('与真实形态一致：深度从 0 起、行序即前序', () => {
  const state = {
    nodes: {
      n1: { parents: ['root'], title: '项目' },
      n2: { parents: ['n1'], title: '子' },
      n3: { parents: ['n2'], title: '孙' },
    },
    membership: { 1: ['n1'], 2: ['n2'], 3: ['n3'] },
  };
  const turns = [{ turn: 1, prompt: 'a' }, { turn: 2, prompt: 'b' }, { turn: 3, prompt: 'c' }];
  const { rows } = P.treeRows(state, turns);
  const outline = P.nestRows(rows);
  assert.equal(outline.length, 1);
  assert.equal(outline[0].children[0].children[0].row.id, 'n3');
  return rows.map((r) => `${r.id}@${r.depth}`).join(' ');
});

// ── 独立节点要计入"几条线"（使用者："独立节点计数吧"）──────────────────────
{
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      p1: { parents: ['root'], title: '项目一', kind: 'task' },
      solo: { parents: [], title: '独立的一件事', kind: 'task' },
    },
    membership: { 1: ['p1'], 7: ['solo'] },
  };
  const summary = P.rootSummary(graph, [{ turn: 1, prompt: 'a' }, { turn: 7, prompt: 'b' }]);
  check('独立节点计入"线"', () => {
    // `projects` 是 **id 列表**（`lines` 才是带 title 的对象）——我第一版按对象写过，报 ",,"
    const titles = summary.projects.map((id) => graph.nodes[id].title);
    if (titles.length !== 2 || !titles.includes('独立的一件事') || !titles.includes('项目一')) {
      throw new Error(titles.join(','));
    }
    return titles.join(' · ');
  });
}

let bad = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) bad += 1;
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
process.exit(bad === 0 ? 0 : 1);
