#!/usr/bin/env node
/**
 * 人工调整的**浏览器侧存储**断言（离线：localStorage 用假替身）。
 *
 * 盯三件现实里真会发生的事：
 * 1. **配额满 / 隐私模式**（setItem 抛异常）——面板该照常显示，只提示没存上；
 * 2. **坏数据**（手改过、旧版本残留）——当作"没有人工调整"，不许整块打不开；
 * 3. **跨会话串味**（键要按会话隔离，且会话 id 不安全时不写）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'lib', 'shared', 'overrideStorage.js'));
const V = require(path.join(ROOT, 'lib', 'shared', 'taskOverrides.js'));

/** 最小可用的假 localStorage；可注入故障。 */
function fakeStorage({ failOnSet = null } = {}) {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => {
      if (failOnSet !== null) throw new Error(failOnSet);
      bag.set(k, v);
    },
    removeItem: (k) => bag.delete(k),
    _bag: bag,
  };
}

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 130)]);
  }
};

check('键带命名空间与版本，且按会话隔离', () => {
  const a = S.overridesStorageKey('session-a');
  const b = S.overridesStorageKey('session-b');
  assert.match(a, /^dsh-intent-view:overrides:v1:session-a$/);
  assert.notEqual(a, b);
});
check('不安全的 sessionId → 不给键（也就不写）', () => {
  for (const bad of ['../../x', 'a/b', '', null]) assert.equal(S.overridesStorageKey(bad), null);
});
check('写入后读回一致', () => {
  const st = fakeStorage();
  const list = [{ op: 'setPlacement', turn: 7, nodes: ['n1', 'n2'] }, { op: 'rename', id: 'n1', title: '甲' }];
  assert.deepEqual(S.saveOverrides(st, 'session-a', list), { ok: true });
  assert.deepEqual(S.loadOverrides(st, 'session-a'), list);
});
check('没写过 → 空数组', () => {
  assert.deepEqual(S.loadOverrides(fakeStorage(), 'session-none'), []);
});
check('跨会话不串味', () => {
  const st = fakeStorage();
  S.saveOverrides(st, 'session-a', [{ op: 'delete', id: 'x' }]);
  assert.deepEqual(S.loadOverrides(st, 'session-b'), []);
});
check('坏 JSON → 当作没有人工调整（不抛）', () => {
  const st = fakeStorage();
  st.setItem(S.overridesStorageKey('session-bad'), '{不是 JSON');
  assert.deepEqual(S.loadOverrides(st, 'session-bad'), []);
});
check('形状不对（旧版本残留）→ 当作没有', () => {
  const st = fakeStorage();
  st.setItem(S.overridesStorageKey('session-old'), JSON.stringify([{ op: 'explode' }]));
  assert.deepEqual(S.loadOverrides(st, 'session-old'), []);
});
check('保存前先校验：坏形状直接拒，并说明原因', () => {
  const st = fakeStorage();
  const res = S.saveOverrides(st, 'session-a', [{ op: 'nope' }]);
  assert.equal(res.ok, false);
  assert.match(res.error, /形状不合法/);
  assert.equal(st._bag.size, 0, '不该写进去');
});
check('配额满（setItem 抛）→ 返回原因而不是抛异常', () => {
  const st = fakeStorage({ failOnSet: 'QuotaExceededError' });
  const res = S.saveOverrides(st, 'session-a', [{ op: 'delete', id: 'x' }]);
  assert.equal(res.ok, false);
  assert.match(res.error, /QuotaExceededError/);
  return '隐私模式禁用 localStorage 也是这条路径';
});
check('读取时 getItem 抛异常 → 空数组（不炸面板）', () => {
  const st = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {}, removeItem: () => {} };
  assert.deepEqual(S.loadOverrides(st, 'session-a'), []);
});
check('撤销全部：只清这一个会话的键', () => {
  const st = fakeStorage();
  S.saveOverrides(st, 'session-a', [{ op: 'delete', id: 'x' }]);
  S.saveOverrides(st, 'session-b', [{ op: 'delete', id: 'y' }]);
  assert.deepEqual(S.clearOverrides(st, 'session-a'), { ok: true });
  assert.deepEqual(S.loadOverrides(st, 'session-a'), []);
  assert.deepEqual(S.loadOverrides(st, 'session-b'), [{ op: 'delete', id: 'y' }]);
});
check('校验逻辑只有一份（shared 里那份被两侧共用）', () => {
  assert.equal(typeof V.validateOverrides, 'function');
  const { problems } = V.validateOverrides([{ op: 'setPlacement', turn: 0, nodes: 'a' }]);
  assert.equal(problems.length, 2, 'turn 与 nodes 各一条');
  return '宿主不再自己实现一遍';
});

// **同一回合堆了多条 setPlacement ⇒ 只留最后一条**（归并，不是把整份丢掉）。
// 写入侧本来就只留一条，所以这只会出现在手改过 localStorage 或旧版本残留时；
// 而 `validateOverrides` 返回 null 会让调用方拿到**空列表**——那是把用户所有改动抹掉。
// ── A3：会话名的人工覆盖（结构里没有 root 节点 ⇒ 独立的字符串键）──────────────
check('会话名：存得下、取得回（空串 = 撤掉覆盖）', () => {
  const st = fakeStorage();
  assert.equal(S.loadSessionTitle(st, 'session-a'), undefined);
  S.saveSessionTitle(st, 'session-a', '  我的会话  ');
  assert.equal(S.loadSessionTitle(st, 'session-a'), '我的会话', '首尾空白要 trim');
  S.saveSessionTitle(st, 'session-a', '');
  assert.equal(S.loadSessionTitle(st, 'session-a'), undefined, '空串 = 还原');
});
check('会话名：坏 JSON 当没有（不抛）', () => {
  const st = fakeStorage();
  st.setItem(S.sessionTitleStorageKey('session-a'), '{坏了');
  assert.equal(S.loadSessionTitle(st, 'session-a'), undefined);
});
check('会话名：生效值 = 覆盖优先，否则用投影给的', () => {
  assert.equal(S.applySessionTitle('投影名', undefined), '投影名');
  assert.equal(S.applySessionTitle('投影名', '我改的'), '我改的');
  assert.equal(S.applySessionTitle('投影名', '   '), '投影名', '只有空白等于没改');
});
check('会话名：与结构覆盖分开存（互不影响）', () => {
  const st = fakeStorage();
  S.saveSessionTitle(st, 'session-a', '只改名字');
  assert.deepEqual(S.loadOverrides(st, 'session-a'), [], '结构覆盖不该被这条污染');
  return '键名分开';
});

// ── A2：按标题把"指向已消失节点"的落点接回当前结构（纯函数）────────────────
// 结构重算会换 id ⇒ 旧覆盖指向空气（使用者那个会话的 4 条 `没有这个节点：t22`）。
// v1 只重接 setPlacement、且**标题必须唯一**才接；其余一律留在"失效"清单里。
const remapCases = () => ({
  titles: new Map([['t22', '整理工作文件'], ['old1', '核对12306数据'], ['dup', '插画']]),
  nodes: {
    n7: { title: '整理工作文件' },
    n8: { title: '核对12306数据' },
    a1: { title: '插画' },
    a2: { title: '插画' },
    n9: { title: '地图服务脚本化' },
  },
});
check('重接：旧 id 消失、标题唯一 ⇒ 接到新 id 上', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle([{ op: 'setPlacement', turn: 6, nodes: ['t22'] }], titles, nodes);
  assert.deepEqual(out.list[0].nodes, ['n7']);
  assert.deepEqual(out.remapped, [{ from: 't22', to: 'n7', title: '整理工作文件' }]);
});
check('重接：同名多个 ⇒ **不接**（宁少不错）', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle([{ op: 'setPlacement', turn: 6, nodes: ['dup'] }], titles, nodes);
  assert.deepEqual(out.list[0].nodes, ['dup'], '保持原样，继续留在失效清单里');
  assert.equal(out.remapped.length, 0);
});
check('重接：旧标题也找不到 ⇒ 不接', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle([{ op: 'setPlacement', turn: 6, nodes: ['没见过的id'] }], titles, nodes);
  assert.deepEqual(out.list[0].nodes, ['没见过的id']);
  assert.equal(out.remapped.length, 0);
});
check('重接：活着的 id 一个都不动', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle([{ op: 'setPlacement', turn: 6, nodes: ['n9'] }], titles, nodes);
  assert.deepEqual(out.list[0].nodes, ['n9']);
  assert.equal(out.remapped.length, 0);
});
check('重接：接上后与原落点重复 ⇒ 去重', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle([{ op: 'setPlacement', turn: 6, nodes: ['n7', 't22'] }], titles, nodes);
  assert.deepEqual(out.list[0].nodes, ['n7']);
});
check('重接：**结构性 op 一律不碰**（delete/rename 的目标按标题猜风险更大）', () => {
  const { titles, nodes } = remapCases();
  const list = [
    { op: 'delete', id: 't22' },
    { op: 'rename', id: 't22', title: '新名字' },
    { op: 'reparent', id: 't22', parents: ['n7'] },
  ];
  const out = S.remapOverridesByTitle(list, titles, nodes);
  assert.deepEqual(out.list, list, '一条都不该被改写');
  assert.equal(out.remapped.length, 0);
});
check('重接：账要能读（人核这一行）', () => {
  const { titles, nodes } = remapCases();
  const out = S.remapOverridesByTitle(
    [{ op: 'setPlacement', turn: 6, nodes: ['t22', 'old1'] }],
    titles,
    nodes,
  );
  const line = S.remapReceipt(out.remapped);
  assert.match(line, /按标题接回 2 条旧改动/);
  assert.match(line, /t22 → n7「整理工作文件」/);
  return line;
});
check('重接：开关默认开，可一键关（DSH_INTENT_REMAP_BY_TITLE=0）', () => {
  assert.equal(S.remapEnabled(), true);
  process.env.DSH_INTENT_REMAP_BY_TITLE = '0';
  const off = S.remapEnabled();
  delete process.env.DSH_INTENT_REMAP_BY_TITLE;
  return off === false;
});

check('同一回合多条 setPlacement：读回来只留最后一条（不整份丢）', () => {
  const st = fakeStorage();
  S.saveOverrides(st, 'session-a', [
    { op: 'rename', id: 'n1', title: '甲' },
    { op: 'setPlacement', turn: 3, nodes: ['n1'] },
    { op: 'setPlacement', turn: 3, nodes: ['n2'] },
  ]);
  const back = S.loadOverrides(st, 'session-a');
  const placements = back.filter((item) => item.op === 'setPlacement' && item.turn === 3);
  assert.equal(placements.length, 1, JSON.stringify(back));
  assert.deepEqual(placements[0].nodes, ['n2'], '留最后一条（回放顺序决定结果）');
  assert.equal(back.some((item) => item.op === 'rename'), true, '别的改动一条都不能丢');
});
check('不同回合的 setPlacement 互不影响', () => {
  const st = fakeStorage();
  S.saveOverrides(st, 'session-a', [
    { op: 'setPlacement', turn: 3, nodes: ['n1'] },
    { op: 'setPlacement', turn: 4, nodes: ['n2'] },
  ]);
  assert.equal(S.loadOverrides(st, 'session-a').length, 2);
});

let bad = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) bad += 1;
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
process.exit(bad === 0 ? 0 : 1);
