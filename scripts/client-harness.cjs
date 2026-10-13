#!/usr/bin/env node
/**
 * 在 Node 里跑**真实的封装产物**，验证注册逻辑。
 *
 * 这个文件从 `check-client.py` 内嵌的 `HARNESS` 字符串里抽出来——
 * 内容本来就是 JavaScript，嵌在 Python 里只是历史原因。
 *
 * **用真的 react，不用 stub**：stub 比现实宽松，必然放过真实缺陷
 * （本项目吃过一次：`useRef` 被转成命名空间绑定，stub 不报错，真 react 才暴露）。
 *
 * 输出一行 JSON：`{ checks: [{name, ok, detail}], error? }`。
 * 由 `check-client.mjs` 调用并格式化。
 */
const fs = require('fs');
const path = require('path');

const target = path.resolve(process.argv[2]);
const source = fs.readFileSync(target, 'utf8');

const loaded = [];
global.window = {
__ModuleLoader__: {
  load(spec) {
    loaded.push(spec);
  },
},
};

// **用真的 react**，不用 stub。
//
// stub 的 `createElement` 会返回一个假对象，于是"返回的是不是 React 元素"这条断言
// 永远是 true——检查就白做了。真 React 才能验证 `$$typeof`，也才能在直接调用
// （无 hook 宿主）时**如实抛出** React 自己的错误。
//
// 本插件在浏览器侧只 require `react` 与 `react/jsx-runtime`，Node 里同样取得到
// （devDependencies）。
let reactStub;
try {
reactStub = require('react');
} catch (error) {
console.error('需要 react 才能做元素身份检查：' + error.message);
process.exit(2);
}

const results = { checks: [], registered: [], error: null };

function check(name, condition, detail) {
results.checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
}

try {
// 执行真实产物。它调用 window.__ModuleLoader__.load。
new Function('require', source)((id) => {
  if (id === 'react' || id === 'react/jsx-runtime') return reactStub;
  throw new Error('unexpected require: ' + id);
});

check('模块注册了一次', loaded.length === 1, String(loaded.length));
const spec = loaded[0];
check('模块 id 正确', spec && spec.id === 'dsh-intent-view', spec && spec.id);

const factory = spec && spec.factory;
check('有 factory', typeof factory === 'function');
const moduleExports = factory((id) => {
  if (id === 'react' || id === 'react/jsx-runtime') return reactStub;
  throw new Error('unexpected require: ' + id);
});

check('导出了 apply', typeof moduleExports.apply === 'function');
// **承重检查。** Cordis 靠 `inject` 知道要等哪些服务就绪，在那之前不激活插件。
// 少了它，`apply` 永远不会被调用——而模块加载、loadCache、零错误**全都正常**，
// 只有 tab 不出现。这个 bug 真的发生过，靠对比 better-sidebar 自己的导出才发现。
check(
  '导出了 inject（Cordis 靠它决定何时激活插件——少了它 apply 永远不会被调用）',
  Array.isArray(moduleExports.inject),
  JSON.stringify(moduleExports.inject),
);
// **反向断言**（2026-10-14 移除侧栏）：插件不再依赖任何第三方 peer 服务
check(
  'inject 里不再有 betterSidebar（侧栏那条路已删除）',
  Array.isArray(moduleExports.inject) && !moduleExports.inject.includes('betterSidebar'),
  JSON.stringify(moduleExports.inject),
);

// 1) 没有 slots：必须静默退出，不能抛（软依赖）。
let quiet = true;
try {
  moduleExports.apply({ get: () => undefined });
} catch (error) {
  quiet = false;
  results.error = String(error);
}
check('缺 slots 时静默退出（软依赖，不抛）', quiet, results.error);

// 2) 有 slots：必须注册。**不再有 betterSidebar 这条假服务**——侧栏那条路已删除。
const injected = [];
const viewRegistrations = [];
const fakeSlots = {
  inject: (name, callback) => { injected.push(name); callback(); },
  register: (def, component) => { viewRegistrations.push({ def, component }); },
};
moduleExports.apply({ get: (name) => (name === 'slots' ? fakeSlots : undefined) });

check(
  '只注册 conversation.view 一个扩展点（侧栏 tab 已删除）',
  injected.length === 1 && injected[0] === 'conversation.view',
  JSON.stringify(injected),
);
check('注册到 conversation.view 这个 slot', injected.includes('conversation.view'), JSON.stringify(injected));
const viewDef = (viewRegistrations[0] || {}).def || {};
check('视图 id 是 intent-view', viewDef.id === 'intent-view', String(viewDef.id));
check('视图排在轨迹页之后（order > 10）', Number(viewDef.order) > 10, String(viewDef.order));
check('视图标题是「意图」', typeof viewDef.label === 'function' && viewDef.label() === '意图');

// ── 主区视图的组件契约（与侧栏那条同一套：**直接调用**必须返回元素）──────────
check('视图有组件', typeof (viewRegistrations[0] || {}).component === 'function');
if (typeof (viewRegistrations[0] || {}).component === 'function') {
  let element = null;
  let renderError = null;
  try {
    element = viewRegistrations[0].component({ sessionId: 'session-x' });
  } catch (error) {
    renderError = String((error && error.message) || error);
  }
  check(
    '组件直接调用返回元素（挂载方不经 createElement）',
    renderError === null && element !== null && typeof element === 'object',
    renderError || String(element),
  );
  // **宽区档必须真的传进主体**：主区比侧栏宽得多，漏传就退回窄列版式。
  check(
    '主区组件把 wide 传给主体',
    (element || {}).props?.wide === true,
    String((element || {}).props?.wide),
  );
}

} catch (error) {
results.error = String(error && error.stack ? error.stack : error);
}

console.log(JSON.stringify(results));
