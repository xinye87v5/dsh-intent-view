#!/usr/bin/env node
/**
 * `src/shared/taskGraph.ts` 的确定性断言（**纯函数、不调模型、不碰网络**）。
 *
 * 这一层的职责边界要盯住：机器只保证**形状**（id 能解析、父节点存在、覆盖完整），
 * **语义对错交给人**（使用者裁定 2026-10-10：给手动调整的入口，而不是再写判据去逼近）。
 * 所以断言里既要有"能应用"，也要有"**拒绝时要给出人话原因**"。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const T = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));

/** 一个三层的小图，够覆盖单链/异支/多父三种情形。 */
const graph = () => ({
  nodes: {
    p: { id: 'p', title: '项目', parents: ['root'] },
    a: { id: 'a', title: '甲', parents: ['p'] },
    b: { id: 'b', title: '乙', parents: ['p'] },
    c: { id: 'c', title: '具体', parents: ['a'] },
    shared: { id: 'shared', title: '共享件', parents: ['a', 'b'] },
  },
  membership: { 1: ['a'], 2: ['a', 'c'], 3: ['a', 'b'], 4: ['c'] },
});

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 130)]);
  }
};

// ---- 两个归一化 ----
check('mostSpecific：同回合里被其它落点包含的祖先会被折掉', () => {
  const out = T.mostSpecific(graph());
  assert.deepEqual(out.membership['2'], ['c'], 'a 是 c 的祖先');
  assert.deepEqual(out.membership['3'], ['a', 'b'], '异支多归属原样保留');
});
check('mostSpecific 幂等', () => {
  const once = T.mostSpecific(graph());
  assert.deepEqual(T.mostSpecific(once), once);
});
check('closeUnderAncestors：补上整条祖先链（含多父的每一条）', () => {
  const out = T.closeUnderAncestors(T.mostSpecific(graph()));
  assert.deepEqual(out.membership['2'], ['c', 'a', 'p']);
  assert.deepEqual(out.membership['1'], ['a', 'p']);
});
check('两者互逆（**按集合**，顺序不参与契约）', () => {
  const norm = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));
  const closed = T.closeUnderAncestors(graph());
  assert.deepEqual(norm(T.closeUnderAncestors(T.mostSpecific(closed)).membership), norm(closed.membership));
  return '两边顺序确实不同，已在契约里写明';
});
check('都不是就地修改（纯函数）', () => {
  const g = graph();
  const snapshot = JSON.stringify(g);
  T.mostSpecific(g);
  T.closeUnderAncestors(g);
  assert.equal(JSON.stringify(g), snapshot);
});

// ---- 人工调整 ----
check('setPlacement：把回合改挂到另一个节点', () => {
  const out = T.applyOverrides(graph(), [{ op: 'setPlacement', turn: 4, nodes: ['b'] }]);
  assert.equal(out.applied, 1);
  assert.deepEqual(out.graph.membership['4'], ['b']);
  assert.deepEqual(out.rejected, []);
});
check('setPlacement：给一个回合挂两处（异支）也允许', () => {
  const out = T.applyOverrides(graph(), [{ op: 'setPlacement', turn: 4, nodes: ['b', 'shared'] }]);
  assert.deepEqual(out.graph.membership['4'], ['b', 'shared']);
});
check('setPlacement：空列表 = 这个回合不挂任何节点', () => {
  const out = T.applyOverrides(graph(), [{ op: 'setPlacement', turn: 4, nodes: [] }]);
  assert.equal(out.graph.membership['4'], undefined, '空归属就不留键');
});
check('rename：改名只动 title', () => {
  const out = T.applyOverrides(graph(), [{ op: 'rename', id: 'c', title: '新名字' }]);
  assert.equal(out.graph.nodes.c.title, '新名字');
  assert.deepEqual(out.graph.nodes.c.parents, ['a'], '父子关系不动');
});
check('merge：把 from 的归属搬进 into 并删掉 from', () => {
  const out = T.applyOverrides(graph(), [{ op: 'merge', from: ['a', 'c'], into: 'a', title: '合并后' }]);
  assert.equal(out.graph.nodes.c, undefined);
  assert.deepEqual(out.graph.membership['2'], ['a']);
  assert.deepEqual(out.graph.membership['4'], ['a']);
  assert.equal(out.graph.nodes.a.title, '合并后');
});
check('merge：同一回合不会重复出现同一个 id', () => {
  const out = T.applyOverrides(graph(), [{ op: 'merge', from: ['c'], into: 'a' }]);
  assert.deepEqual(out.graph.membership['2'], ['a'], '原本是 [a, c]');
});
check('create：新建节点并指定父（可以被后续 setPlacement 用）', () => {
  const out = T.applyOverrides(graph(), [
    { op: 'create', id: 'n', title: '新对象', parents: ['p'] },
    { op: 'setPlacement', turn: 4, nodes: ['n'] },
  ]);
  assert.deepEqual(out.graph.membership['4'], ['n']);
  assert.deepEqual(out.graph.nodes.n.parents, ['p']);
});
check('delete：删枝后**它的回合变成独立**（落点置空，不是凭空消失）', () => {
  const out = T.applyOverrides(graph(), [{ op: 'delete', id: 'a' }]);
  assert.equal(out.graph.nodes.a, undefined);
  // **空数组而不是删键**（使用者："删除枝后，其下回合应该变成独立的"）：
  // 删键会让它在"属于某枝"与"未归属"两边都不显示——看起来像回合丢了
  assert.deepEqual(out.graph.membership['1'], [], '回合 1 只挂 a ⇒ 现在独立');
  assert.deepEqual(out.graph.membership['3'], ['b'], '回合 3 原本 [a, b] ⇒ 只剩 b（b 没被删）');
});

// ── 删枝 = **连子树一起删**（使用者 2026-10-10 纠正："下挂的所有回合还是没有变成独立回合"）
//
// 上一版是"只删这一个节点，子枝上提一级"。那等于**解散分组**而不是删除枝条：
// 挂在子枝上的回合一个都不会变独立。而实测结构里父节点常常是纯容器（回合都在子节点），
// 删容器时"上提一级"甚至什么都没改变。文件管理器删目录是删子树，这里照这个来。
check('delete：**下挂的子树一起删**，子树里的回合都变成独立回合', () => {
  const out = T.applyOverrides(graph(), [{ op: 'delete', id: 'a' }]);
  assert.equal(out.graph.nodes.c, undefined, 'c 是 a 的子枝 ⇒ 一起删');
  assert.deepEqual(out.graph.membership['2'], [], '回合 2 原本 [a, c] ⇒ 两个落点都被删 ⇒ 独立');
  assert.deepEqual(out.graph.membership['4'], [], '回合 4 只挂 c（在子树里）⇒ 独立');
  return 'a 与 c 一起消失，回合 1/2/4 变独立';
});
check('delete：**多父共享的子枝不连坐**（它外面还有家）', () => {
  const out = T.applyOverrides(graph(), [{ op: 'delete', id: 'a' }]);
  assert.notEqual(out.graph.nodes.shared, undefined, 'shared 还挂在 b 上 ⇒ 不该被删');
  assert.deepEqual(out.graph.nodes.shared.parents, ['b'], '摘掉被删的父 a，留下 b');
  assert.deepEqual(out.graph.membership['3'], ['b'], '回合 3 仍在 shared 所在的 b 枝上');
});
check('delete：删除集就是 deleteImpact 算的那份（界面提示与实际一致）', () => {
  const g = graph();
  const impact = T.deleteImpact(g, 'a');
  assert.deepEqual([...impact.nodes].sort(), ['a', 'c'], `nodes=${JSON.stringify(impact.nodes)}`);
  // **两个数要分开**：`affected` = 会丢掉落点的（回合 3 会失去 a 那一份），
  // `orphaned` = 摘完一个落点都不剩的（才是界面上说的"变成独立回合"）。
  // 第一版只有一个 `turns`，把两者混了——断言当场抓到 turns=[1,2,3,4]。
  assert.deepEqual(impact.affected, [1, 2, 3, 4], `affected=${JSON.stringify(impact.affected)}`);
  assert.deepEqual(impact.orphaned, [1, 2, 4], `orphaned=${JSON.stringify(impact.orphaned)}`);
  const out = T.applyOverrides(g, [{ op: 'delete', id: 'a' }]);
  for (const id of impact.nodes) assert.equal(out.graph.nodes[id], undefined, `${id} 应被删`);
  for (const turn of impact.orphaned) assert.deepEqual(out.graph.membership[String(turn)], []);
  return 'affected=[1,2,3,4] orphaned=[1,2,4]';
});
check('deleteImpact 对不存在的节点给空影响（界面不会崩）', () => {
  assert.deepEqual(T.deleteImpact(graph(), '不存在'), { nodes: [], affected: [], orphaned: [] });
});
// ── 同级不许同名（使用者 2026-10-10："同个父枝不允许下级有同名枝或节点"）──────
check('改名：同一条父枝下撞名 ⇒ 拒绝并说明', () => {
  // fixture：a、b 同为 p 的子（同级）
  const out = T.applyOverrides(graph(), [{ op: 'rename', id: 'b', title: '甲' }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /同级不能同名/);
});
check('改名：改成自己的名字（没变化）不算撞名', () => {
  const out = T.applyOverrides(graph(), [{ op: 'rename', id: 'a', title: '甲' }]);
  assert.equal(out.applied, 1, JSON.stringify(out.rejected));
});
check('改名：**不同父枝**下可以同名（同级才算）', () => {
  // c 的父是 a；把 c 改成与 b 同名——b 的父是 p，两者不共享父
  const out = T.applyOverrides(graph(), [{ op: 'rename', id: 'c', title: '乙' }]);
  assert.equal(out.applied, 1, JSON.stringify(out.rejected));
});
check('新建枝：同一条父枝下撞名 ⇒ 拒绝', () => {
  const out = T.applyOverrides(graph(), [{ op: 'create', id: 'new1', title: '甲', parents: ['p'] }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /同级不能同名/);
});
// **这条规则不许有缺口**（改名/新建能撞，合并带标题与挪枝也能撞）
check('合并带标题：撞名 ⇒ 拒绝（规则不许只在改名那条路上生效）', () => {
  // 把 c 并进 b，并给 b 改名为「甲」——p 下已经有「甲」(a)
  const out = T.applyOverrides(graph(), [{ op: 'merge', from: ['c'], into: 'b', title: '甲' }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /同级不能同名/);
});
check('合并带标题：不与**即将消失的被并枝**撞名（它马上就不在了）', () => {
  // 把 b（标题「乙」）并进 a 并改名为「乙」——b 自己要消失，不算撞名
  const out = T.applyOverrides(graph(), [{ op: 'merge', from: ['b'], into: 'a', title: '乙' }]);
  assert.equal(out.applied, 1, JSON.stringify(out.rejected));
});
check('挪枝：挪到已经有同名子枝的父下 ⇒ 拒绝', () => {
  // shared 叫「共享件」，把 b 挪到 a 下并... 直接构造：把 c 改名成与 shared 不冲突，
  // 这里用一个更直接的场景——把 b 挪到 shared 的父下（a），而 a 下已有 c
  const out = T.applyOverrides(graph(), [{ op: 'reparent', id: 'b', parents: ['a'] }]);
  assert.equal(out.applied, 1, JSON.stringify(out.rejected));
  // 造一个真的撞名：把 b 改名成「具体」再挪回 a（a 下已有 c=「具体」）
  const renamed = T.applyOverrides(graph(), [{ op: 'rename', id: 'b', title: '具体' }]);
  assert.equal(renamed.applied, 1, '此时 b 的父仍是 p，与 c 不同级 ⇒ 允许');
  const moved = T.applyOverrides(renamed.graph, [{ op: 'reparent', id: 'b', parents: ['a'] }]);
  assert.equal(moved.applied, 0, '挪过去就同级同名了 ⇒ 必须拒');
  assert.match(moved.rejected[0].reason, /同级不能同名/);
});
check('新建枝：别的父枝下可以同名', () => {
  const out = T.applyOverrides(graph(), [{ op: 'create', id: 'new1', title: '甲', parents: ['root'] }]);
  assert.equal(out.applied, 1, JSON.stringify(out.rejected));
});

// ---- 拒绝路径（机器只保证形状） ----
check('删根 → 拒绝（否则整棵树没了）', () => {
  const out = T.applyOverrides(graph(), [{ op: 'delete', id: 'root' }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /不能删除根节点/);
  assert.equal(out.graph.nodes.a !== undefined, true, '被拒的调整不该改动任何东西');
});
check('未知节点 → 拒绝并说明原因（不抛异常）', () => {
  const out = T.applyOverrides(graph(), [{ op: 'setPlacement', turn: 1, nodes: ['不存在'] }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /没有这个节点/);
  assert.deepEqual(out.graph.membership['1'], ['a'], '被拒的调整不该改动任何东西');
});
check('空名字 → 拒绝', () => {
  const out = T.applyOverrides(graph(), [{ op: 'rename', id: 'a', title: '   ' }]);
  assert.equal(out.applied, 0);
  assert.match(out.rejected[0].reason, /名字不能为空/);
});
check('create 撞 id / 父不存在 → 拒绝', () => {
  assert.match(T.validateOverride(graph(), { op: 'create', id: 'a', title: 'x', parents: ['p'] })[0], /已存在/);
  assert.match(T.validateOverride(graph(), { op: 'create', id: 'z', title: 'x', parents: ['没'] })[0], /没有父节点/);
});
check('一条被拒不影响后面的调整', () => {
  const out = T.applyOverrides(graph(), [
    { op: 'rename', id: '没有', title: 'x' },
    { op: 'rename', id: 'a', title: '好名字' },
  ]);
  assert.equal(out.applied, 1);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.graph.nodes.a.title, '好名字');
});
check('不就地修改传入的 graph（人工调整也是纯函数）', () => {
  const g = graph();
  const snapshot = JSON.stringify(g);
  T.applyOverrides(g, [{ op: 'delete', id: 'a' }, { op: 'rename', id: 'b', title: 'x' }]);
  assert.equal(JSON.stringify(g), snapshot);
});
check('可回放：同一串调整重复应用结果一致', () => {
  const overrides = [{ op: 'rename', id: 'c', title: 'X' }, { op: 'merge', from: ['c'], into: 'a' }];
  const once = T.applyOverrides(graph(), overrides).graph;
  const twice = T.applyOverrides(graph(), overrides).graph;
  assert.deepEqual(once, twice);
});

// ── 剪空叶子（使用者："如果某个母枝变空了，那么应该可以直接删掉吧"）────────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      project: { parents: ['root'], title: '项目根', kind: 'task' },   // 空容器：有子节点
      child: { parents: ['project'], title: '子任务', kind: 'task' },  // 有回合
      leaf: { parents: ['project'], title: '空叶子', kind: 'task' },   // 无回合、无子节点
    },
    membership: { 1: ['child'] },
  };
  const once = T.pruneEmptyLeaves(graph);
  const twice = T.pruneEmptyLeaves(once.graph);
  // ⚠️ 这个 check 收的是**函数**（惰性求值、内部 try/catch），传布尔值会报 "fn is not a function"
  check('剪掉空叶子', () => {
    if (once.pruned.length !== 1 || once.pruned[0] !== 'leaf') throw new Error(once.pruned.join(','));
    return once.pruned.join(',');
  });
  check('空容器保留（父节点是纯容器是正常设计）', () => {
    if (once.graph.nodes.project === undefined) throw new Error('项目根被误删');
    return '保留';
  });
  check('有回合的节点保留', () => {
    if (once.graph.nodes.child === undefined) throw new Error('有回合的节点被误删');
    return '保留';
  });
  // **独立节点（没有父）是合法的**（使用者问"是否允许独立节点"）：
  // - 校验放行 `parents: []`（只检查列出的父是否存在）；
  // - 树上把"没有父/父不在图里"的节点当顶层画（`treeRows` 的 tops）；
  // - 剪枝只剪"没回合也没子节点"的，**有回合的独立节点留着**。
  check('独立节点（parents: []）有回合时保留', () => {
    const withIndependent = {
      nodes: {
        root: { parents: [], title: 'root', kind: 'root' },
        solo: { parents: [], title: '独立的一件事', kind: 'task' },
      },
      membership: { 7: ['solo'] },
    };
    const kept = T.pruneEmptyLeaves(withIndependent);
    if (kept.graph.nodes.solo === undefined) throw new Error('有回合的独立节点被剪掉了');
    return '保留';
  });
  check('独立节点没回合也没子节点时同样被剪', () => {
    const emptySolo = {
      nodes: {
        root: { parents: [], title: 'root', kind: 'root' },
        solo: { parents: [], title: '空的独立节点', kind: 'task' },
      },
      membership: {},
    };
    if (T.pruneEmptyLeaves(emptySolo).pruned.join(',') !== 'solo') throw new Error('空的独立节点没被剪');
    return '剪掉';
  });
  check('幂等（剪过再剪没有变化）', () => {
    if (twice.pruned.length !== 0) throw new Error(twice.pruned.join(','));
    return '0';
  });
}

// ── 生效结构：叠覆盖 + 剪空枝（B4-1 的承重层）─────────────────────────────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      a: { parents: ['root'], title: '甲', kind: 'task' },
      b: { parents: ['root'], title: '乙', kind: 'task' },
      empty: { parents: ['root'], title: '空叶枝', kind: 'task' },
    },
    membership: { 1: ['a'], 2: ['a'], 3: ['b'] },
  };
  const overrides = [{ op: 'setPlacement', turn: 2, nodes: ['b'] }];
  const eff = T.effectiveStructure(graph, overrides);
  check('生效结构：覆盖生效（回合 2 挪到乙）', () => {
    if (eff.graph.membership['2'].join(',') !== 'b' || eff.applied !== 1) {
      throw new Error(`${eff.graph.membership['2']} applied=${eff.applied}`);
    }
    return 'applied=1';
  });
  check('生效结构：同时剪掉空叶枝', () => {
    if (eff.pruned.join(',') !== 'empty') throw new Error(eff.pruned.join(','));
    return eff.pruned.join(',');
  });
  check('生效结构：不修改入参（纯函数）', () => {
    if (graph.membership['2'].join(',') !== 'a' || graph.nodes.empty === undefined) {
      throw new Error('入参被改了');
    }
    return '未改';
  });
  check('生效结构：被拒的覆盖不影响结果，且记在 rejected 里', () => {
    const bad = T.effectiveStructure(graph, [{ op: 'setPlacement', turn: 2, nodes: ['不存在'] }]);
    if (bad.rejected.length !== 1 || bad.graph.membership['2'].join(',') !== 'a') {
      throw new Error(JSON.stringify(bad.rejected));
    }
    return 'rejected=1';
  });
  check('生效结构：先叠覆盖再剪枝（新建的空枝不会被自己剪掉）', () => {
    // 建一个枝并把回合挂上去：如果顺序反了（先剪后叠），新枝会先消失、回合无处可挂
    const created = T.effectiveStructure(graph, [
      { op: 'create', id: 'fresh', title: '新枝', parents: ['root'] },
      { op: 'setPlacement', turn: 3, nodes: ['fresh'] },
    ]);
    if (created.graph.nodes.fresh === undefined || created.graph.membership['3'].join(',') !== 'fresh') {
      throw new Error('新枝被剪掉或回合没挂上');
    }
    return '新枝保留';
  });
}

// ── 挂枝 reparent（使用者："一个节点可以被挂到几个枝上了，还要考虑一下"）──────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      a: { parents: ['root'], title: '枝 A', kind: 'task' },
      b: { parents: ['root'], title: '枝 B', kind: 'task' },
      leaf: { parents: ['a'], title: '叶子', kind: 'task' },
      grand: { parents: ['leaf'], title: '孙节点', kind: 'task' },
    },
    membership: { 1: ['leaf'], 2: ['grand'] },
  };
  check('挂枝：一个节点可以同时挂在两个枝上（加枝不动原来的枝）', () => {
    const r = T.applyOverrides(graph, [{ op: 'reparent', id: 'leaf', parents: ['a', 'b'] }]);
    const parents = r.graph.nodes.leaf.parents.join(',');
    if (parents !== 'a,b') throw new Error(parents);
    return parents;
  });
  check('挂枝：去掉所有父 = 变成独立节点', () => {
    const r = T.applyOverrides(graph, [{ op: 'reparent', id: 'leaf', parents: [] }]);
    if (r.graph.nodes.leaf.parents.length !== 0) throw new Error(r.graph.nodes.leaf.parents.join(','));
    if (T.pruneEmptyLeaves(r.graph).pruned.includes('leaf')) throw new Error('有回合的独立节点被剪了');
    return '独立';
  });
  check('挂枝：成环被拒（把父设成自己的后代）', () => {
    const r = T.applyOverrides(graph, [{ op: 'reparent', id: 'leaf', parents: ['grand'] }]);
    if (r.rejected.length !== 1) throw new Error('没被拒');
    if (r.graph.nodes.leaf.parents.join(',') !== 'a') throw new Error('图被改了');
    return r.rejected[0].reason.slice(0, 24);
  });
  check('挂枝：父不存在被拒', () => {
    const r = T.applyOverrides(graph, [{ op: 'reparent', id: 'leaf', parents: ['不存在'] }]);
    if (r.rejected.length !== 1) throw new Error('没被拒');
    return '拒';
  });
  check('挂枝：不改别的节点、也不改标题', () => {
    const r = T.applyOverrides(graph, [{ op: 'reparent', id: 'leaf', parents: ['b'] }]);
    if (r.graph.nodes.leaf.title !== '叶子' || r.graph.nodes.a.parents.join(',') !== 'root') {
      throw new Error('别的字段被动了');
    }
    return '只改父';
  });
}

// ── 拖拽落点的那一步：附加（多父）而不是搬家 ────────────────────────────────
// 拖拽本身没法离线测（要浏览器），但它**真正改数据的那一步**是纯函数，可以测。
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      a: { parents: ['root'], title: '甲枝', kind: 'task' },
      b: { parents: ['root'], title: '乙枝', kind: 'task' },
    },
    membership: { 1: ['a'], 2: ['a'] },
  };
  check('拖到节点上 = 附加落点（保留原来的枝，成为多父）', () => {
    const next = T.applyOverrides(graph, [
      { op: 'setPlacement', turn: 1, nodes: ['a', 'b'] },
    ]).graph;
    if (next.membership['1'].join(',') !== 'a,b') throw new Error(next.membership['1'].join(','));
    return 'a,b';
  });
  check('拖到节点上不会动别的回合', () => {
    const next = T.applyOverrides(graph, [
      { op: 'setPlacement', turn: 1, nodes: ['a', 'b'] },
    ]).graph;
    if (next.membership['2'].join(',') !== 'a') throw new Error(next.membership['2'].join(','));
    return 'turn2 未动';
  });
}

// ── 拖拽 = **挪**（不是多挂一个）：使用者当场纠正过这条语义 ──────────────────
// 树上一个回合会出现在**每个**挂它的节点下面 ⇒ 拖某一行天然意味着"把这一份挪走"。
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      a: { parents: ['root'], title: '甲枝', kind: 'task' },
      b: { parents: ['root'], title: '乙枝', kind: 'task' },
      c: { parents: ['root'], title: '丙枝', kind: 'task' },
    },
    // 回合 1 **多挂**在甲、丙两条枝上
    membership: { 1: ['a', 'c'], 2: ['a'] },
  };
  check('拖拽=挪：从甲拖到乙 ⇒ 甲的落点没了、乙有了', () => {
    const next = T.applyOverrides(graph, [{ op: 'setPlacement', turn: 1, nodes: ['b', 'c'] }]).graph;
    if (next.membership['1'].join(',') !== 'b,c') throw new Error(next.membership['1'].join(','));
    return 'b,c';
  });
  check('拖拽=挪：**别的枝上那一份仍然在**（丙不动）', () => {
    const next = T.applyOverrides(graph, [{ op: 'setPlacement', turn: 1, nodes: ['b', 'c'] }]).graph;
    if (!next.membership['1'].includes('c')) throw new Error('丙被误删');
    return '丙仍在';
  });
  check('拖拽=挪：只影响被拖的回合', () => {
    const next = T.applyOverrides(graph, [{ op: 'setPlacement', turn: 1, nodes: ['b', 'c'] }]).graph;
    if (next.membership['2'].join(',') !== 'a') throw new Error(next.membership['2'].join(','));
    return 'turn2 未动';
  });
  check('拖回原处 = 不产生覆盖（空操作）', () => {
    const before = JSON.stringify(graph.membership['1']);
    const next = T.applyOverrides(graph, []).graph;
    if (JSON.stringify(next.membership['1']) !== before) throw new Error('变了');
    return '原样';
  });
}

// ── 拆分枝：新建一条枝 + 把选中的**子枝**从旧枝改挂过去（替换，不是附加）────────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      big: { parents: ['root'], title: '大枝', kind: 'task' },
      kid1: { parents: ['big'], title: '孩子一', kind: 'task' },
      kid2: { parents: ['big', 'root'], title: '孩子二', kind: 'task' }, // 多父：拆走 big 之后 root 那份要留着
      other: { parents: ['root'], title: '别的枝', kind: 'task' },
    },
    membership: { 1: ['kid1'], 2: ['kid2'], 3: ['other'] },
  };
  const overrides = [
    { op: 'create', id: 'new1', title: '拆出来的枝', parents: ['big'] },
    { op: 'reparent', id: 'kid1', parents: ['new1'] },
    { op: 'reparent', id: 'kid2', parents: ['root', 'new1'] },
  ];
  // **新枝与原枝同级**（使用者："拆分时新枝和原来的枝应该是同级的"）：
  // 新枝继承原枝的父，而不是挂在原枝下面（挂下面读起来是嵌套，不是拆分）
  check('拆分：新枝与原枝**同级**（继承原枝的父）', () => {
    const r = T.applyOverrides(graph, [
      { op: 'create', id: 'new1', title: '拆出来的枝', parents: [...graph.nodes.big.parents] },
      { op: 'reparent', id: 'kid1', parents: ['new1'] },
      { op: 'reparent', id: 'kid2', parents: ['root', 'new1'] },
    ]).graph;
    if (r.nodes.new1?.parents.join(',') !== graph.nodes.big.parents.join(',')) {
      throw new Error(`new1.parents=${JSON.stringify(r.nodes.new1?.parents)}`);
    }
    return `new1 与 big 同级（父 ${r.nodes.new1.parents.join(',')}）`;
  });
  check('拆分：子枝**从旧枝移走**（替换而非附加）', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (r.nodes.kid1.parents.join(',') !== 'new1') throw new Error(r.nodes.kid1.parents.join(','));
    return 'kid1 只在 new1 下';
  });
  check('拆分：多父的子枝只摘掉旧枝那一份，别的父保留', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (r.nodes.kid2.parents.join(',') !== 'root,new1') throw new Error(r.nodes.kid2.parents.join(','));
    return 'root,new1';
  });
  check('拆分：不碰别的枝与回合', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (r.nodes.other.parents.join(',') !== 'root') throw new Error('别的枝被动了');
    if (r.membership['3'].join(',') !== 'other') throw new Error('回合被动了');
    return '未动';
  });
  check('拆分：新枝有子节点 ⇒ 不会被剪枝删掉', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (T.pruneEmptyLeaves(r).pruned.includes('new1')) throw new Error('新枝被剪了');
    return '保留';
  });
}

// ── 拆分可以拆**回合**（使用者："应该有回合就可以拆，有子枝也可以拆"）────────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      big: { parents: ['root'], title: '大枝', kind: 'task' },
      other: { parents: ['root'], title: '别的枝', kind: 'task' },
    },
    // 回合 1 只挂大枝；回合 2 **多挂**在大枝与别的枝上
    membership: { 1: ['big'], 2: ['big', 'other'] },
  };
  // 拆：把回合 1 分到新枝（回合 2 不动）
  const overrides = [
    { op: 'create', id: 'new1', title: '拆出来的枝', parents: ['big'] },
    { op: 'setPlacement', turn: 1, nodes: ['new1'] },
  ];
  check('拆分回合：被拆的回合从旧枝移到新枝', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (r.membership['1'].join(',') !== 'new1') throw new Error(r.membership['1'].join(','));
    return 'new1';
  });
  check('拆分回合：没勾的回合不动', () => {
    const r = T.applyOverrides(graph, overrides).graph;
    if (r.membership['2'].join(',') !== 'big,other') throw new Error(r.membership['2'].join(','));
    return 'big,other';
  });
  check('拆分回合：多挂的回合若被拆，只移走旧枝那一份', () => {
    const r = T.applyOverrides(graph, [
      { op: 'create', id: 'new2', title: '新枝二', parents: ['big'] },
      { op: 'setPlacement', turn: 2, nodes: ['other', 'new2'] },
    ]).graph;
    if (r.membership['2'].join(',') !== 'other,new2') throw new Error(r.membership['2'].join(','));
    return 'other,new2';
  });
}

// ── 合并的收尾（审查发现：原来只搬回合，不管子枝与父引用）────────────────────
{
  const graph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      into: { parents: ['root'], title: '目标枝', kind: 'task' },
      from: { parents: ['root'], title: '被并枝', kind: 'task' },
      kid: { parents: ['from'], title: '被并枝的孩子', kind: 'task' },
    },
    membership: { 1: ['from'], 2: ['kid'], 3: ['into'] },
  };
  const r = T.applyOverrides(graph, [{ op: 'merge', from: ['from'], into: 'into' }]).graph;
  check('合并：被并枝的回合改挂到目标枝', () => {
    if (r.membership['1'].join(',') !== 'into') throw new Error(r.membership['1'].join(','));
    return 'into';
  });
  check('合并：被并枝的**子枝上提到目标枝**（不留悬空父）', () => {
    if (r.nodes.kid?.parents.join(',') !== 'into') throw new Error(JSON.stringify(r.nodes.kid?.parents));
    return 'kid ← into';
  });
  check('合并：树上每个节点的父都存在（没有悬空引用）', () => {
    const bad = Object.entries(r.nodes).filter(([, n]) => n.parents.some((p) => p !== 'root' && r.nodes[p] === undefined));
    if (bad.length > 0) throw new Error(bad.map(([id]) => id).join(','));
    return '无悬空';
  });
  check('合并：目标枝不与已被并的枝互为父子', () => {
    if (r.nodes.into.parents.includes('from')) throw new Error('into 仍指着 from');
    return r.nodes.into.parents.join(',') || '(无父=独立)';
  });
}

let bad = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) bad += 1;
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
process.exit(bad === 0 ? 0 : 1);
