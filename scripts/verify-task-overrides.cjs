#!/usr/bin/env node
/**
 * 人工调整的**校验与路由**断言（离线：不调模型、不起 DSH）。
 *
 * 存储后端是**注入**的（当前实现是进程内的，见 `host/taskOverrideStore.ts`），
 * 所以这里测三件真正容易出事的事：
 *
 * 1. **会话键安全**：id 来自请求体，`../..` 这类必须挡住（哪天换持久化后端就是漏洞）；
 * 2. **形状校验**：坏输入要逐条报出来，不能含混地整批拒掉；
 * 3. **后端可替换**：这一层不许假定某种存储。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// **共享的唯一一份校验**（原来经宿主 store 转发，那个文件随 B4-5 删除）
const S = require(path.join(ROOT, 'lib', 'shared', 'taskOverrides.js'));


// **宿主路由与它的进程内 store 已删（B4-5）**：持久化的家定为浏览器侧 localStorage
// （`shared/overrideStorage.ts`，由 `verify-override-storage.cjs` 覆盖）。
// 本文件从此只测**共享的那份校验与申请**（唯一一份，宿主/浏览器/测试共用）。

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 130)]);
  }
};

// ---- 会话键与安全 ----
check('sessionKey：正常 id 通过', () => {
  assert.equal(S.sessionKey('session-abc_1.2'), 'session-abc_1.2');
});
check('sessionKey：挡住路径穿越与奇怪输入', () => {
  for (const bad of ['../../etc/passwd', 'a/b', '..', '.', '', 'x'.repeat(65), 42, null, undefined]) {
    assert.equal(S.sessionKey(bad), null, JSON.stringify(bad) + ' 不该通过');
  }
  return '只接受 [A-Za-z0-9._-]{1,64}';
});

// ---- 形状校验 ----
check('validateOverridesPayload：五类 op 的合法形状都过', () => {
  const good = [
    { op: 'setPlacement', turn: 3, nodes: ['a', 'b'] },
    { op: 'rename', id: 'a', title: '新名字' },
    { op: 'merge', from: ['a', 'b'], into: 'a', title: '合并' },
    { op: 'create', id: 'n', title: '新节点', parents: ['root'] },
    { op: 'delete', id: 'n' },
  ];
  assert.deepEqual(S.validateOverrides(good).problems, []);
});
check('validateOverridesPayload：坏输入逐条报错（一条 op 一条账）', () => {
  const { problems } = S.validateOverrides([
    { op: 'explode' },
    { op: 'setPlacement', turn: 0, nodes: 'a' },
    { op: 'rename', id: '', title: ' ' },
    { op: 'merge', from: [], into: 'a' },
    { op: 'create', id: 'n', title: 'x' },
    { op: 'delete' },
  ]);
  assert.equal(problems.length, 8, problems.join(' | '));
  assert.match(problems[0], /op 必须是/);
  assert.match(problems[1], /turn 必须是正整数/);
  return problems.length + ' 条都报出来了（我第一版按 6 条断言，是错的）';
});
check('validateOverridesPayload：不是数组 / 超量 → 拒绝', () => {
  assert.match(S.validateOverrides({}).problems[0], /必须是数组/);
  const many = Array.from({ length: 501 }, () => ({ op: 'delete', id: 'x' }));
  assert.match(S.validateOverrides(many).problems[0], /最多 500 条/);
});

// ---- 存取：**已随 B4-5 移到浏览器侧** ----
// 原来这里三条（写入读回 / 没写过给空数组 / 换后端互不干扰）测的是宿主的进程内 store，
// 那个文件与路由一起删了。存储契约现在由 `verify-override-storage.cjs`（12 条）覆盖：
// 往返、坏 JSON、跨会话串味、配额满返因不抛——比原来那三条更严。


(async () => {
  const asyncChecks = [];
  const run = async (name, fn) => {
    try {
      const detail = await fn();
      asyncChecks.push([name, true, typeof detail === 'string' ? detail : '']);
    } catch (error) {
      asyncChecks.push([name, false, error.message.split('\n')[0].slice(0, 130)]);
    }
  };

  // 原来这里还有 7 条"路由：…"断言（读/写/非法 id/形状不合法/坏 JSON/清空/可替换后端）。
  // 那条路由与 store 一起删了（B4-5），断言随之删除——**不是放宽**：
  // 校验本身仍然被本文件前面的断言覆盖，存储契约由 verify-override-storage 的 12 条覆盖。


  const all = [...checks, ...asyncChecks];
  let bad = 0;
  for (const [name, ok, detail] of all) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) bad += 1;
  }
  console.log(`\n${all.length - bad}/${all.length} 项通过`);
  process.exit(bad === 0 ? 0 : 1);
})();
