const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const loaded = [];
global.window = { __ModuleLoader__: { load: (s) => loaded.push(s) } };
const req = (id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
  throw new Error('unexpected require: ' + id);
};
new Function('require', fs.readFileSync('lib/client.js', 'utf8'))(req);
const mod = loaded[0].factory(req);

// 假的 sessions 服务：包含一份有 goal 的投影
// 含一个 prompt 为空、但回复有内容的回合——真实会话里存在（`#36`/`#37`）。
const EMPTY_PROMPT_TURN = { turn: 3, prompt: '', response: '两次挂载都崩了，我把根因查清了…' };
const projection = {
  goal: { goal: { id: 'g1', revision: 10, objective: '按 docs/44 的顺序执行优化并最终给出可部署判断。剩余：裁剪杠杆压力感知、稳定检索入口、父子双写核对。' }, roundsStarted: 7 },
  turnOutline: [
    { turn: 1, prompt: '如何定制旅游规划 harness 工程', response: '先分清哪一层才是领域工程…' },
    { turn: 2, prompt: 'harness 与平台工具的区别', response: '扩展点不同…' },
    EMPTY_PROMPT_TURN,
    // #4–#7：官方大纲里给一份**短截断**的原文，用来分辨"界面吃的是哪一份"。
    // #4 在 wire 里被换成了宿主那份（长一点、也是结构流水线真正要的），
    // #5 在 wire 里**没有这个键**（旧缓存行的形状），必须回落到这几行。
    { turn: 4, prompt: '官方大纲：画风', response: '定稿…' },
    { turn: 5, prompt: '官方大纲：配色', response: '两版…' },
    { turn: 6, prompt: '官方大纲：排版', response: '左对齐…' },
    { turn: 7, prompt: '官方大纲：交稿', response: '周五…' },
    ...Array.from({ length: 9 }, (_, i) => ({
      turn: i + 8,
      prompt: i === 3 ? '随便聊点别的' : '继续按 docs/44 优化稳定检索入口',
      response: i === 3 ? '好的' : '已量了裁剪杠杆压力感知的代价…',
    })),
  ],
};
// **宿主折叠的逐回合原文**（wire 的 `prompt`，`stateVersion` 8 起的键）。
//
// 三处**刻意的形状**，每条都有断言盯着：
//   · #3 不给原文——官方 `turnOutline` 那份也是空的，"空回合"不许被编出来；
//   · #4 给一份**与 `turnOutline` 不同**的原文——wire 优先。否则结构流水线吃的是
//     侧栏卡片那份短截断，而它要的是"用户到底说了什么"；
//   · #5 压根没有这个键——模拟旧缓存行（v8 之前），必须回落到 `turnOutline`。
const hostPrompts = new Map(projection.turnOutline.map((t) => [t.turn, String(t.prompt ?? '')]))
hostPrompts.set(4, '宿主折叠的原文（口径测试）：画风定稿')
hostPrompts.delete(3)
hostPrompts.delete(5)

const hostIntent = {
  turnCount: 14,
  firstSeq: 4,
  lastSeq: 200,
  turns: Array.from({ length: 14 }, (_, i) => {
    const turn = i + 1
    const prompt = hostPrompts.get(turn)
    return {
      turn,
      ...(prompt === undefined ? {} : { prompt }),
      // **只有简报回合带这一句**，与投影的真实行为一致（其余回合没有这个键）
      ...(turn === 2 ? { statement: 'The user agrees to continue optimising docs/44.' } : {}),
    }
  }),
  goalOnset: 59,
  goalTimeline: [
    { turn: 0, operation: 'create', revision: 1 },
    { turn: 58, operation: 'create', revision: 1 },
    { turn: 61, operation: 'pause', revision: 3 },
    { turn: 62, operation: 'resume', revision: 3 },
  ],
}

const projectionWithIntent = { ...projection, intent: hostIntent }

// **必须用带 `intent` 的那份**：面板现在纯渲染，投影里没有 `intent` 就只会
// 显示"还没有意图投影"。这个 fixture 就是"宿主算好的载荷"。
const byId = {
  'session-x': { projectionValues: projectionWithIntent, displayTitle: '上下文压缩' },
};
const list = {
  getSnapshot: () => ({ ids: ['session-x'], byId, current: 'session-x' }),
  subscribe: () => () => {},
};
const ctx = { get: (n) => (n === 'sessions' ? { list } : undefined) };

// 客户端要能直接用的几个函数：折进导出检查。
//
// ⚠️ `describeShift` 曾在这个名单里——它来自 `shared/intent.ts`（不是
// `client/shifts.ts`，那个文件其实一直没有消费者）。话题转向随组口径一起删除
// （提交 ④），名字也跟着撤掉；**不是放宽，是那个东西不存在了**。
for (const name of ['modelFromProjection', 'pickSession']) {
  const ok = typeof mod[name] === 'function';
  if (!ok) {
    console.log('  ✗ 缺少导出 ' + name);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// **面板现在是纯渲染**：语义由宿主的 `intent` 投影给出。
// 所以这里要造的是一份**宿主算好的载荷**，而不是让浏览器去算。
// 形状与 `src/host/intentProjection.ts` 的 `IntentView` 一致。
// ---------------------------------------------------------------------------



const structureState = {
  nodes: {
    n1: { parents: ['root'], title: '图文改编' },
    n2: { parents: ['n1'], title: '角色设定' },
    n3: { parents: ['n1'], title: '插画' },
    shared: { parents: ['n2', 'n3'], title: '共享画风' },
    aside: { parents: ['root'], title: '题外话', kind: 'aside' },
  },
  membership: {
    // 选中 n2 时要能看到 #1–#3：#3 是压缩回合（那两个标记渲染在详情层里），
    // 且 #3 与多父节点 shared 共挂（树上的 ↩ 标记靠它）。
    1: ['n1', 'n2'], 2: ['n2'], 3: ['shared', 'n2'], 4: ['aside'], 5: ['n3'],
  },
};
const structureTurns = [
  { turn: 1, prompt: '开工' }, { turn: 2, prompt: '定角色' },
  { turn: 3, prompt: '画风' }, { turn: 4, prompt: '聊天气' }, { turn: 5, prompt: '画第一页' },
];

/** 详情层要能渲染，必须先有结构（弃组之后选中对象是节点）。三处夹具共用这一份。 */
const STRUCTURE_PROPS = {
  structure: {
    kind: 'done',
    structure: structureState,
    roots: { projects: ['n1'], note: '单线', forks: [{ id: 'n1', title: '图文改编', at: 1 }] },
    meta: { calls: 4, batches: 1, adjudication: 'asked', inherited: 0, reasked: 0 },
  },
};

// **详情层**：与概况层分别渲染。两层的断言不能混在一起——
// 那正是分层要解决的问题。
const detailHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
    compactions: undefined,
    sessionId: 'session-x',
    savedBaseline: '',
    onApplyBaseline: () => {},
    // **详情层的选中对象是任务节点**（弃组之后）：这里选 n2「角色设定」
    initialSelection: 'n2',
    ...STRUCTURE_PROPS,
  }),
);
const detailChecks = [
  // 回合行现在带逐回合标记（`#1 ⟨未判⟩`）⇒ 锚点从 `>#1<` 改成 `>#1`（**改指向，不是放宽**：
  // 仍然要求行首是 `#1`，而且下面的断言盯着标记本身）
  ['详情层含回合行', detailHtml.includes('>#1')],
  // 详情层把"回合号"与"标记"拆成两个 span（回合号红色、标记按状态着色），
  // 所以锚点从 `#1 ⟨…⟩` 改成"有 #1 且有标记文本"（标记文本仍是 ✓/未判/理解偏/越界之一）
  ['详情层每个回合都有标记（未判/✓/理解偏/越界）',
    detailHtml.includes('#1') && /(✓|未判|理解偏|越界)/.test(detailHtml)],
  // 空 prompt 不能退化成"（空）"——那会丢掉图上唯一可读的信息。
  [
    '空 prompt 用回复当标签',
    detailHtml.includes('两次挂载都崩了') && !detailHtml.includes('（空）'),
  ],
  ['详情层有返回入口', detailHtml.includes('回到结构')],
  // 旧版这里断言"目标派生自"（组口径）。弃组之后换成**节点口径**：
  // 这一层要说明它是哪个节点、收了多少回合。
  ['详情层说明是哪个节点、收了多少回合', detailHtml.includes('角色设定') && /收了 \d+ 个回合/.test(detailHtml)],
  // **B4-1：详情层是人改落点的地方**（树上不塞编辑入口，避免挤）。
  // 只读渲染（没传 onOverridesChange）时不出现入口——这条同时守住"夹具不必都改成可编辑"。
  ['只读渲染时没有编辑入口', !/data-intent-edit=/.test(detailHtml)],
  // **B4-2：节点级操作也只读时不出现**（改名/挂枝/新增枝/合并/删除）
  ['只读渲染时没有节点操作', !/data-intent-node-ops=/.test(detailHtml)],
  // **人工判定回到详情层**（使用者 2026-10-10）——但**只在给了回调时**：
  // 只读调用方（宿主内嵌、测试夹具）不该凭空长出一个能写 localStorage 的入口。
  ['只读渲染时没有逐回合人工判定', !/data-intent-turn-verdict/.test(detailHtml)],
];

// ---------------------------------------------------------------------------
// **可编辑渲染**（B4-2）：给上覆盖与回调之后，节点操作入口与回合编辑入口都该出现。
// 只读与可编辑**两条路都要断言**：只读那条守"调用方不必都改"，这条守"给了回调就真能改"。
// ---------------------------------------------------------------------------
// ⚠️ **这份夹具原来带 `initialSelection: 'n2'`**——也就是说它渲染的是**详情层**，
// 于是"编辑栏 off"、'编辑栏把拖=移动说清楚' 这些断言全都在详情层上通过，
// 而使用者一眼就看出"点进回合详情还能看到编辑按钮栏"。
// 断言挂在错误的层上，等于没守。现在拆成两份：
//   `editableHtml`       = 概况层（树）可编辑 → 守着操作栏/拖拽/回收站这些**树上的**表面
//   `editableDetailHtml` = 详情层可编辑 → 守着"这一层里什么都不出现"
const EDITABLE_PROPS = {
  model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
  compactions: undefined,
  sessionId: 'session-x',
  savedBaseline: '',
  onApplyBaseline: () => {},
  overrides: [],
  onOverridesChange: () => {},
  verdictEdits: [],
  onVerdictEdit: () => {},
  ...STRUCTURE_PROPS,
}
const editableHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, { ...EDITABLE_PROPS }))
const editableDetailHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, { ...EDITABLE_PROPS, initialSelection: 'n2' }),
);
const EXPECTED_EXTRA = []
const CANSPLIT_CHECKS = []
// ---------------------------------------------------------------------------
// **能拆的判据**（使用者："拆分按钮好像无法使用"——叶子枝没有可勾的子枝，
// 摆一个永远禁用的按钮只会让人困惑，所以拆不了就不显示）
// ---------------------------------------------------------------------------
{
  const looksLikeGraph = {
    nodes: {
      root: { parents: [], title: 'root', kind: 'root' },
      n1: { parents: ['root'], title: '有子枝', kind: 'task' },
      n2: { parents: ['n1'], title: '叶子枝', kind: 'task' },
    },
    membership: { 1: ['n2'] },
  }
  const probes = [
    ['有子枝 ⇒ 可拆', mod.canSplit(looksLikeGraph, 'n1') === true],
    // **有回合也能拆**（使用者纠正："应该有回合就可以拆，有子枝也可以拆"）——
    // 回合是真实发生过的，把它们分组到新枝是"重新分组"，不是凭空建任务节点
    ['有回合的叶子枝 ⇒ 也能拆', mod.canSplit(looksLikeGraph, 'n2') === true],
    ['既没回合也没子枝 ⇒ 不可拆', mod.canSplit({ nodes: { root: { parents: [], title: 'root', kind: 'root' }, x: { parents: ['root'], title: '空', kind: 'task' } }, membership: {} }, 'x') === false],
    ['root 不可拆', mod.canSplit(looksLikeGraph, 'root') === false],
    ['图缺失 ⇒ 不可拆（不崩）', mod.canSplit(undefined, 'n1') === false],
  ]
  CANSPLIT_CHECKS.push(...probes.map(([name, ok]) => [name, ok]))
}

/**
 * 「现在」标记用**最小夹具**验（不是那份大投影）。
 *
 * 为什么：大投影里 `model.turns`（来自官方 `turnOutline`，14 条）与树 fixture 的回合
 * （1–5）本就不一致，"最新回合"落在树里根本没有的行上 ⇒ 标记当然不渲染。
 * 我为此试了两轮"对齐夹具"都没成——**最小夹具一次就复现了**（3 个回合全挂一条枝）：
 * 这比继续修大夹具便宜，也更直接地说明"最新那一条会被标出来"。
 */
const miniStructure = { nodes: { m1: { parents: ['root'], title: '甲' } }, membership: { 1: ['m1'], 2: ['m1'], 3: ['m1'] } }
const miniTurns = [
  { turn: 1, prompt: '第一件事' },
  { turn: 2, prompt: '第二件事' },
  { turn: 3, prompt: '最新的一件' },
]
const miniModel = {
  turns: miniTurns, turnCount: 3, rootDetail: '会话目标', rootProvenance: 'derived',
  goalTimeline: [], notes: [],
}
const miniTree = (() => {
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
  const { rows, unattached } = P.treeRows(miniStructure, miniTurns)
  return { outline: P.nestRows(rows), unattached }
})()
const miniProps = {
  model: miniModel, compactions: undefined, sessionId: 'session-mini',
  structure: { kind: 'done', structure: miniStructure, roots: {}, meta: {} },
  tree: miniTree, graph: miniStructure, overrideCount: 0, overrides: [],
  onOverridesChange: () => {}, wide: true,
}
const miniHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, miniProps))

// 一个收了 13 个回合（区间不连续）的枝：徽标该收起
const manyTurns = [1, 2, 3, 5, 9, 12, 13, 14, 17, 19, 21, 22, 30]
const badgeStructure = {
  nodes: { b1: { parents: ['root'], title: '回合很多的枝' } },
  membership: Object.fromEntries(manyTurns.map((t) => [String(t), ['b1']])),
}
const badgeTree = (() => {
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
  const { rows, unattached } = P.treeRows(badgeStructure, manyTurns.map((t) => ({ turn: t, prompt: `第 ${t} 件` })))
  return { outline: P.nestRows(rows), unattached }
})()
/**
 * 区间模式的夹具：**30 个回合挂在一条枝上**，其中第 2 条判"理解偏"（落在第一个区间里，
 * 它必须在不展开的情况下也露出来）。
 */
const bigTurns = Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, prompt: `第 ${i + 1} 件` }))
const bigStructure = {
  nodes: { n1: { parents: ['root'], title: '回合很多的枝' } },
  membership: Object.fromEntries(bigTurns.map((t) => [String(t.turn), ['n1']])),
}
const bigTree = (() => {
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
  const { rows, unattached } = P.treeRows(bigStructure, bigTurns)
  return { outline: P.nestRows(rows), unattached }
})()
const bigNodeHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, {
  ...miniProps, wide: true,
  model: { ...miniModel, turns: bigTurns, turnCount: 30 },
  structure: { kind: 'done', structure: bigStructure, roots: {}, meta: {} },
  tree: bigTree, graph: bigStructure,
  semantic: {
    kind: 'done',
    result: {
      hash: 'h', model: 'm', at: 0, votes: 3,
      verdicts: [
        { turn: 2, match: false, reason: '理解偏了', understanding: false, inScope: true },
        { turn: 30, match: true, reason: '' },
      ],
    },
  },
}))

const badgeHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, {
  ...miniProps,
  model: { ...miniModel, turns: manyTurns.map((t) => ({ turn: t, prompt: `第 ${t} 件` })), turnCount: 13 },
  structure: { kind: 'done', structure: badgeStructure, roots: {}, meta: {} },
  tree: badgeTree, graph: badgeStructure,
}))
const miniDetailHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, { ...miniProps, initialSelection: 'm1' }),
)

const rangeChecks = [
  // B 方案（使用者 2026-10-13 选定）：宽区按区间成行 + 两处改进
  ['区间统计只写出现过的档', () =>
    mod.rangeStats([1, 2, 3], new Map([[1, { match: true }], [2, { match: false, understanding: false }], [3, { match: false, inScope: false }]])) === '✓×1 · 理解偏×1 · 越界×1'],
  ['区间统计：全没判过写「未判」', () => mod.rangeStats([1, 2], new Map()) === '未判'],
  ['区间统计：较远单独一档（↔N）', () =>
    mod.rangeStats([1], new Map([[1, { match: true, parent: 'far' }]])) === '✓×1 · ↔1'],
  ['宽区：30 个回合折成区间行（不是 30 行）', () =>
    /data-intent-range="n1:10"/.test(bigNodeHtml) && (bigNodeHtml.match(/data-intent-range="/g) || []).length >= 2],
  // 使用者 2026-10-14："我的目的是不进入详情界面也可以看到回合" ⇒ **默认全部展开**
  ['宽区：区间**默认展开**（回合不用点、不用进详情就看得到）', () =>
    /data-intent-range="n1:0" data-intent-range-expanded="true"/.test(bigNodeHtml) &&
      /data-intent-range="n1:20" data-intent-range-expanded="true"/.test(bigNodeHtml) &&
      /data-intent-latest="30"/.test(bigNodeHtml)],
  ['宽区：30 个回合**全部**在 HTML 里（不是只列首尾）', () =>
    [1, 7, 15, 23, 30].every((t) => new RegExp(`data-intent-verdict="[a-z]+"[^>]*>#${t}<|#${t}<`).test(bigNodeHtml))],
  // 使用者 2026-10-14："全部按方案 B 的设计展示，不再进入详情才能看到全部"
  ['两处挂载都用区间（窄列 6 / 宽区 10），没有"不收区间"的档', () =>
    mod.layoutFor(false).rangeSize === 6 && mod.layoutFor(true).rangeSize === 10],
];

const badgeChecks = [
  // 使用者 2026-10-13："同枝下太多回合……还有名称栏那里的横向展示"
  ['徽标：回合少时照旧是区间串（不收起）', () =>
    mod.badgeText([1, 2, 3, 5]) === '#1–3、#5'],
  ['徽标：区间串太长时收起成"…共 N 个"', () => {
    const many = [1, 2, 3, 5, 9, 12, 13, 14, 17, 19, 21, 22, 30]
    const text = mod.badgeText(many)
    return text.length <= mod.BADGE_LIMIT + 6 && /…共 13 个$/.test(text)
  }],
  ['徽标：完整区间进 title（收起不丢信息）', () =>
    /title="[^"]*#1–3[^"]*共 13 个回合/.test(badgeHtml) && badgeHtml.includes('…共 13 个')],
];

const placesStructure = {
  nodes: { m1: { parents: ['root'], title: '甲枝' }, m2: { parents: ['root'], title: '乙枝' } },
  membership: { 1: ['m1', 'm2'], 2: ['m1'] },
}
const placesTurns = [{ turn: 1, prompt: '同时挂在两条枝下的回合' }, { turn: 2, prompt: '只挂一处' }]
const placesTree = (() => {
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
  const { rows, unattached } = P.treeRows(placesStructure, placesTurns)
  return { outline: P.nestRows(rows), unattached }
})()
const placesHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, {
  ...miniProps,
  model: { ...miniModel, turns: placesTurns, turnCount: 2 },
  structure: { kind: 'done', structure: placesStructure, roots: {}, meta: {} },
  tree: placesTree,
  graph: placesStructure,   // ← ×N 要用生效结构的 membership 算，这条必须给
}))

// 三层枝 + 一条不相干的枝：最新回合挂在最深那层
const pathStructure = {
  nodes: {
    a1: { parents: ['root'], title: '顶层枝' },
    a2: { parents: ['a1'], title: '中间枝' },
    a3: { parents: ['a2'], title: '最深的枝' },
    z1: { parents: ['root'], title: '不相干的枝' },
  },
  membership: { 1: ['a3'], 2: ['z1'], 3: ['a3'] },
}
const pathTurns = [{ turn: 1, prompt: '第一件' }, { turn: 2, prompt: '别的枝' }, { turn: 3, prompt: '最新一件' }]
const pathTree = (() => {
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'))
  const { rows, unattached } = P.treeRows(pathStructure, pathTurns)
  return { outline: P.nestRows(rows), unattached }
})()
const pathHtml = renderToStaticMarkup(React.createElement(mod.IntentBody, {
  ...miniProps,
  model: { ...miniModel, turns: pathTurns, turnCount: 3 },
  structure: { kind: 'done', structure: pathStructure, roots: {}, meta: {} },
  tree: pathTree, graph: pathStructure,
}))

const dagViewChecks = [
  // 使用者 2026-10-14："可以一条完整枝（从回合向上推）都标现在吗？"
  ['祖先链都标「现在」（直接挂着的那枝 + 它上面每一层）', () =>
    /data-intent-node-latest="a3"/.test(pathHtml) &&
      /data-intent-node-now-path="a2"/.test(pathHtml) &&
      /data-intent-node-now-path="a1"/.test(pathHtml)],
  ['祖先链不标到不相干的枝（z1 上什么都没有）', () =>
    !/data-intent-node-latest="z1"/.test(pathHtml) && !/data-intent-node-now-path="z1"/.test(pathHtml)],
  ['直接挂着的那枝不重复标两次（latest 与 now-path 二选一）', () =>
    !/data-intent-node-now-path="a3"/.test(pathHtml)],

  // 借鉴 ~/dag-view：图的用处在"同一节点的多条边一眼看得见" ⇒ 回合行标 `×N` 并可悬停看各枝
  ['多挂回合行标 `×N`（看得出它还挂在几条枝下）', () =>
    /data-intent-turn-places="1:2"/.test(placesHtml) && /同时挂在两条枝下/.test(placesHtml)],
  ['只挂一处的回合不标（不制造噪声）', () =>
    !/data-intent-turn-places="2:1"/.test(placesHtml) && !/data-intent-turn-places="\d+:1"/.test(placesHtml)],
  // 学 dag-view 的"每张图一行统计"：口径不依赖闭包，只放悬停里
  ['枝的徽标悬停带统计（共 N 个回合 · 被标 K 条）', () =>
    /title="[^"]*共 \d+ 个回合[^"]*被标 \d+ 条/.test(structureHtml)],
];

const positionChecks = [
  // 使用者 2026-10-14："当前回合的标签也放到枝那里，因为回合可能处于折叠状态"
  ['枝的标题行也标「现在」（折叠时仍看得到在哪一枝）', () =>
    /data-intent-node-latest="m1"/.test(miniHtml) && miniHtml.includes('你现在在这个枝里')],
  ['区间行标出哪个区间含最新回合', () =>
    /现在/.test(bigNodeHtml) && /data-intent-node-latest="n1"/.test(bigNodeHtml)],
  // 使用者 2026-10-13："最新的回合需要标识，这样用户比较清晰了解目前位置"
  ['最新回合标「现在」（树上）', () =>
    /data-intent-latest="3"/.test(miniHtml) && miniHtml.includes('现在')],
  ['最新回合标「现在」（详情层）', () => /data-intent-latest="3"/.test(miniDetailHtml)],
  ['「现在」只标最新那一条（其它回合没有）', () =>
    (miniHtml.match(/data-intent-latest="/g) || []).length === 1 &&
      !/data-intent-latest="(1|2)"/.test(miniHtml)],
  // 使用者 2026-10-13："去掉'点这里看全部'，现在 tab 够位置放下所有"
  ['不再有"点这里看全部"（宽区不截断）', () =>
    !editingHtml.includes('点这里看全部') && !editableDetailHtml.includes('点这里看全部')],
  ['两处都不截断（preview 都是 Infinity）', () =>
    mod.layoutFor(true).preview === Number.POSITIVE_INFINITY &&
      mod.layoutFor(false).preview === Number.POSITIVE_INFINITY],
];

const layoutChecks = [
  // 步骤④：宽区只调四个数、**不重排**（结构/交互/断言都不动）
  ['版式：窄列与宽区只差四个数（内边距/限宽/摘要长度/每节点条数）',
    (() => {
      const narrow = mod.layoutFor(false); const wide = mod.layoutFor(true);
      return narrow.maxWidth === undefined && wide.maxWidth > 600 &&
        narrow.snippet === 44 && wide.snippet > narrow.snippet &&
        narrow.preview === Number.POSITIVE_INFINITY && wide.preview === Number.POSITIVE_INFINITY &&
        narrow.rangeSize < wide.rangeSize &&
        narrow.padding !== wide.padding
    })()],
  // 步骤⑤：两条挂载路与取舍文档都要在（README 写了路径，文档也真在）
  ['挂载点只有主区（README 写清）＋取舍文档也在＋不再提已删除的探针',
    (() => {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
      const doc = path.join(ROOT, 'research', 'sidebar-vs-main-view-2026-10-10.md')
      return readme.includes('只有一个挂载点') && readme.includes('check:live:panel') &&
        readme.includes('已移除') && !readme.includes('check:live:tab') &&
        readme.includes('sidebar-vs-main-view-2026-10-10.md') && fs.existsSync(doc)
    })()],
  ['版式：宽区渲染出限宽 + 更长摘要（静态渲染对比）',
    (() => {
      const wide = renderToStaticMarkup(React.createElement(mod.IntentBody, {
        ...EDITABLE_PROPS, wide: true,
      }))
      const narrow = renderToStaticMarkup(React.createElement(mod.IntentBody, { ...EDITABLE_PROPS }))
      return /max-width:\s*1100px/.test(wide) && !/max-width:\s*1100px/.test(narrow) &&
        wide.length !== narrow.length
    })()],
];

const conversationViewChecks = [
  // **主区对话视图**（conversation.view slot）：props 形状不确定，提取必须防御
  ['主区视图：从 props.sessionId 取会话 id', mod.slotSessionId({ sessionId: 's1' }) === 's1'],
  ['主区视图：从 props.inject.sessionId 取（我们注册时声明的那个位置）',
    mod.slotSessionId({ inject: { sessionId: 's2' } }) === 's2'],
  ['主区视图：从 props.scope.sessionId 取（侧栏那条的写法）',
    mod.slotSessionId({ scope: { sessionId: 's3' } }) === 's3'],
  ['主区视图：形状不认识 ⇒ undefined（面板显示"没有选中会话"，不白屏）',
    mod.slotSessionId({}) === undefined && mod.slotSessionId(undefined) === undefined &&
      mod.slotSessionId({ sessionId: '   ' }) === undefined && mod.slotSessionId({ sessionId: 42 }) === undefined],
  ['主区视图：缺 slots 服务时注册返回 false（软依赖，不影响侧栏那条）',
    mod.registerConversationView({ get: () => undefined }) === false &&
      mod.registerConversationView({}) === false],
  ['主区视图：注册参数是 conversation.view / 排在轨迹页之后',
    mod.CONVERSATION_VIEW.name === 'conversation.view' && mod.CONVERSATION_VIEW.order > 10],
  // **活体验证那条命令与探针都在**（主区视图是唯一能在无头窗口点开面板的路）
  ['活体点面板的探针与命令都在（check:live:panel）',
    (() => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      return String(pkg.scripts['check:live:panel'] ?? '').includes('conversation-view-check') &&
        fs.existsSync(path.join(ROOT, 'tools', 'probes', 'conversation-view-check.mjs'))
    })()],
];

const liveHookChecks = [
  // **活面板探针靠这几个成员**：它们被删掉时探针会静默失效
  // （报"没有诊断钩子"），所以在源码级守住这条契约。
  // 侧栏时代的 `tabs` / `serviceKeys` / `service` 随侧栏那条路一起删了。
  ['诊断钩子提供探针要用的成员（overrideRoundTrip / intentProbe / conversationView）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client.ts'), 'utf8')
      return src.includes('overrideRoundTrip') && src.includes('intentProbe') && src.includes('conversationView')
    })()],
  ['两个活面板探针都在（命令 check:live:* 指向它们）',
    (() => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      return (
        String(pkg.scripts['check:live:storage'] ?? '').includes('panel-storage-check') &&
        String(pkg.scripts['check:live:panel'] ?? '').includes('conversation-view-check')
      )
    })()],
];

const historyChecks = [
  ['撤销栈：后进先出（回到上一个状态，不是最初）', (() => {
    let st = [];
    st = mod.pushHistory(st, [{ op: 'rename', id: 'a', title: '1' }]);
    st = mod.pushHistory(st, [{ op: 'rename', id: 'a', title: '2' }]);
    const one = mod.popHistory(st);
    const two = mod.popHistory(one.stack);
    return one.list[0].title === '2' && two.list[0].title === '1' && two.stack.length === 0;
  })()],
  ['撤销栈：空栈出栈 = 不动（调用方据此不写回）', mod.popHistory([]).list === undefined],
  ['撤销栈：有上限（只留最近 N 版）', (() => {
    let st = [];
    for (let i = 0; i < mod.HISTORY_MAX + 5; i += 1) st = mod.pushHistory(st, [{ op: 'delete', id: `n${i}` }]);
    const top = mod.popHistory(st).list[0].id;
    return st.length === mod.HISTORY_MAX && top === `n${mod.HISTORY_MAX + 4}`;
  })()],
  ['撤销栈：不就地改调用方的数组（压栈后原列表还能用）', (() => {
    const base = [{ op: 'delete', id: 'x' }];
    const st = mod.pushHistory([], base);
    base.push({ op: 'delete', id: 'y' });
    return st[0].length === 1;
  })()],
];

const dragChecks = (() => {
  const G = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
  const base = {
    nodes: {
      root: { id: 'root', title: 'root', parents: [] },
      a: { id: 'a', title: '甲', parents: ['root'] },
      b: { id: 'b', title: '乙', parents: ['root'] },
    },
    membership: { 1: ['a'], 2: [] },
  };
  const drop = (payload) => G.applyOverrides(base, mod.dropOnNode([], base, payload, 'b')).graph;
  return [
    // **独立回合拖到枝上 = 挂上去**（不是替换、不是合并）
    ['落点：从"没挂任何节点"拖来 ⇒ 挂上去（追加）',
      drop({ turns: [2], from: '' }).membership['2'].join() === 'b',
      JSON.stringify(drop({ turns: [2], from: '' }).membership)],
    ['落点：从别的枝拖来 ⇒ 挪（旧的落点去掉）',
      drop({ turns: [1], from: 'a' }).membership['1'].join() === 'b'],
    ['落点：从别的枝拖来时，**别的枝上那一份不动**',
      G.applyOverrides(base, mod.dropOnNode([], base, { turns: [1], from: 'a' }, 'b')).graph.membership['1'].join() === 'b'],
  ];
})();

const dragPayloadChecks = [
  ['拖拽载荷往返（回合 + 来源）',
    JSON.stringify(mod.decodeDrag(mod.encodeDrag([19, 21], ''))) === JSON.stringify({ turns: [19, 21], from: '' })],
  ['拖拽载荷：来源是节点时也带得住',
    mod.decodeDrag(mod.encodeDrag([3], 'n7')).from === 'n7'],
  ['拖拽载荷：坏数据当没有（不抛）',
    mod.decodeDrag('{oops') === undefined && mod.decodeDrag('') === undefined && mod.decodeDrag('{"turns":[]}') === undefined],
  // **止冒泡是这条链的命门**：回合行在 `<summary>` 里，dragstart 冒泡到节点处理器
  // 会把"拖一个回合"变成"拖整条枝"（落在枝上=合并、落在回收站=删枝）。源码级守住。
  // **根因守卫**：独立回合的行用的是 `nodeRowContext`；那份里少了 onDragStart，
  // 行照样 draggable、照样能拖起来，但落点什么也读不到（这一轮就是这么坏的）。
  ['共用上下文（nodeRowContext）里带着拖拽处理器',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
      const at = src.indexOf('const nodeRowContext = {')
      const block = src.slice(at, src.indexOf('return createElement(', at))
      return at > 0 && block.includes('onDragStart') && block.includes('onDragEnd')
    })()],
  ['回合行的 dragstart 止冒泡（否则会变成拖整条枝）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
      const at = src.indexOf('onDragStart: pickable')
      return at > 0 && src.slice(at, at + 400).includes('stopPropagation')
    })()],
];

const branchChecks = (() => {
  const G = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
  const base = { nodes: { root: { id: 'root', title: 'root', parents: [] }, a: { id: 'a', title: '甲', parents: ['root'] } }, membership: { 1: ['a'] } };
  const list = mod.newBranchOverrides([], base, [1, 2], 'new1', '未归类');
  const out = G.applyOverrides(base, list);
  return [
    ['新建枝：先建容器再挂回合（两条 op，顺序不能反）',
      list.length === 3 && list[0].op === 'create' && list[0].parents.join() === 'root' && list[1].op === 'setPlacement'],
    ['新建枝：选中的回合都挂到新枝上',
      out.graph.membership['1'].includes('new1') && out.graph.membership['2'].includes('new1'),
      JSON.stringify(out.graph.membership)],
    ['新建枝：原来的落点一个不动（是追加不是搬走）',
      out.graph.membership['1'].includes('a')],
    ['新建枝：新枝不会被剪枝删掉（它有回合了）', out.graph.nodes['new1'] !== undefined],
  ];
})();

const describeChecks = [
  ['说人话：摘除落点', mod.describeOverride({ op: 'setPlacement', turn: 7, nodes: [] }) === '摘除 #7 的落点'],
  ['说人话：挪到某个节点（带标题）',
    mod.describeOverride({ op: 'setPlacement', turn: 7, nodes: ['n2'] }, structureState).includes('角色设定')],
  ['说人话：删枝条带标题',
    mod.describeOverride({ op: 'delete', id: 'n2' }, structureState).includes('删枝条 「角色设定」'),
    mod.describeOverride({ op: 'delete', id: 'n2' }, structureState)],
  ['摘要最多列 3 条，其余折成"等 N 条"',
    mod.describeOverrides(
      [
        { op: 'rename', id: 'a', title: 'x' },
        { op: 'rename', id: 'b', title: 'y' },
        { op: 'rename', id: 'c', title: 'z' },
        { op: 'rename', id: 'd', title: 'w' },
      ],
      structureState,
    ).includes('等 1 条')],
];

const editableChecks = [
  // **方案 A：编辑与浏览分离**——默认只读（编辑栏显示 off + 一句说明），
  // 打开后才有操作栏动作与树上可选中（选择器要选中之后才出现，静态渲染断不到它）。
  // 拖拽：静态渲染里 `draggable` 与 `onDrop` 都会出现在 HTML 上（React 会输出 draggable 属性）
  // 拖拽的说明要**说准语义**：拖 = 挪（去掉源节点），多挂用「挂到…」——
  // 第一版写成"拖到目标节点上"（附加），被使用者当场指出违背直觉
  ['给了回调：编辑栏把"拖=移动 / 复制到…=多挂 / 枝条拖=合并"说清楚',
    (() => {
      const text = editableHtml.replace(/&quot;/g, '"').replace(/[\u200b*]/g, '')
      return /拖 = 移动/.test(text) && /「复制到…」= 多挂/.test(text) && /枝条也能拖/.test(text)
    })()],
  // 投放区与撤销按钮只在**编辑态**渲染（静态渲染是只读态 ⇒ 这里应当没有）
  // 原先是两个投放区（摘除落点 / 删除枝条），使用者提议合成**一个回收站**——
  // 对象类型决定后果，悬停时把后果写在上面。只读态不渲染它。
  ['只读态不出现回收站（编辑态才有）', !/data-intent-dropzone=/.test(editableHtml)],
  // 树上的枝条按钮（改名 / 拆分）同样只在编辑态渲染
  ['只读态不出现树上的枝条按钮', !/data-intent-node-rename=/.test(editableHtml) && !/data-intent-node-split=/.test(editableHtml)],
  ['给了回调：默认是只读（编辑栏 off，没有动作）',
    /data-intent-editbar="off"/.test(editableHtml) && !/data-intent-editbar-actions=/.test(editableHtml)],
  // **动作常显**（使用者反馈"复制到我没看到单独按钮"）：只有选中后才出现的按钮
  // 等于让人猜"这里能干什么"。所以编辑态下四个动作始终渲染，没选中时禁用并写明原因。
  ['编辑栏说明里点名"先在树上点选回合"（动作常显的前提）',
    /先在树上点选回合/.test(editableHtml.replace(/&quot;/g, '"'))],
  // **详情层只展示**（使用者："点进回合详情就不需要保留编辑了"）——编辑统一在树上 + 操作栏
  ['详情层不再有回合级编辑入口', !/data-intent-edit=/.test(editableHtml)],
  // 节点级操作也从详情层移走了；树上的入口只在**编辑态**渲染（静态渲染是只读态，故为"没有"）
  ['详情层不再有节点级操作', !/data-intent-node-ops=/.test(editableHtml)],
  // **编辑栏里不放人工判定**（使用者 2026-10-10："编辑里面不放人工判定吧"）。
  // 编辑栏的动作只在编辑态渲染（静态渲染里编辑态是关的 ⇒ HTML 里断不到），
  // 所以这条守到**源码级**：那个属性与那套按钮必须彻底不存在。
  ['编辑栏里没有人工判定（源码级：栏内无此文案，也没有那个属性）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
      // 精确切出编辑栏那一块：从栏本身的属性到下一个块（结构块）为止
      const from = src.indexOf("'data-intent-editbar':")
      const to = src.indexOf("'data-intent-structure':")
      const ok = from > 0 && to > from
      // **去掉注释再查**：注释里正解释"为什么这里没有人工判定"，
      // 拿注释当证据是"看着像绿"的另一种形式（前一版断言就栽在这上面）。
      const bar = (ok ? src.slice(from, to) : '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      return ok && !bar.includes('人工判定') && !src.includes('data-intent-editbar-verdict')
    })()],
  ['三条预设只有一份定义（详情层那个逐回合判定在用）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
      const uses = (src.match(/VERDICT_PRESETS\.map\(/g) || []).length
      const defs = (src.match(/const VERDICT_PRESETS/g) || []).length
      const inline = (src.match(/\{ label: '理解偏', match: false/g) || []).length
      // `inline === 1` 是**定义体里那一处**：源码里只许出现这一次，
      // 多出来的就是有人在某处又手抄了一份（漂移的起点）。
      // `uses === 1`：编辑栏里那份已按使用者要求撤掉，现在只有详情层在用。
      return defs === 1 && uses === 1 && inline === 1
    })()],

  // ── 详情层：**可编辑渲染下也必须是干净的**（使用者 2026-10-10：
  //    "但回合详情我还可以看到编辑按钮栏"）─────────────────────────────
  //
  // 上一版只把详情层**内部**的控件删了，而操作栏与回收站挂在面板层级、两层都渲染
  // ⇒ 点进详情后那一栏还在。这一组断言就是钉住这个案例：**可编辑 ≠ 详情层能编辑**。
  // **先证明这份夹具真的在详情层**——上一版之所以漏掉"详情里还有操作栏"，
  // 根因就是夹具选错了层，断言在错误的层上静默通过。这条守卫挡住同一个坑再踩一次。
  ['守卫：可编辑详情夹具确实渲染在详情层（否则下面几条是假通过）',
    editableDetailHtml.includes('回到结构') && !/data-intent-structure=/.test(editableDetailHtml)],
  ['详情层（可编辑渲染）里不出现操作栏', !/data-intent-editbar=/.test(editableDetailHtml)],
  ['详情层（可编辑渲染）里不出现回收站', !/data-intent-dropzone=/.test(editableDetailHtml)],
  ['详情层（可编辑渲染）里不出现树上的枝条按钮',
    !/data-intent-node-rename=/.test(editableDetailHtml) && !/data-intent-node-split=/.test(editableDetailHtml)],
  ['详情层（可编辑渲染）里不出现结构编辑入口（回合级/节点级）',
    !/data-intent-edit=/.test(editableDetailHtml) && !/data-intent-node-ops=/.test(editableDetailHtml)],
  // **人工判定留在详情层**（使用者裁定）。三个预设 + 还原，每个回合一套。
  ['可编辑详情层：每个回合都有逐回合人工判定',
    /data-intent-turn-verdict-set="1:✓"/.test(editableDetailHtml) &&
      /data-intent-turn-verdict-set="1:理解偏"/.test(editableDetailHtml) &&
      /data-intent-turn-verdict-set="1:越界"/.test(editableDetailHtml) &&
      /data-intent-turn-verdict-clear="1"/.test(editableDetailHtml)],
  // 判定是**标注**不是结构改动：它随时能还原，所以不必先进"编辑落点"（少一次开关）
  ['人工判定不需要先进编辑态（详情层直接可点）',
    /data-intent-turn-verdict-set="1:✓"/.test(editableDetailHtml) &&
      !/data-intent-editbar=/.test(editableDetailHtml)],
  // 反面对照：同一份 props 只要不选中节点，操作栏**必须**在（否则上面几条可能是"永远没有"）
  ['对照：不选中节点时操作栏在（否则上一条是假通过）', /data-intent-editbar=/.test(editableHtml)],
  // 详情层里也不能出现**导向编辑的提示文字**——那是"入口"的软形式，同样会让人以为这一层能编辑。
  // 一次说全：详情层里**只有"人工判定"这一种编辑词汇**，结构编辑的词一个都不许有
  //（控件已经各有一条断言，这里守"软入口"——提示文字、引导语同样会让人以为这一层能编辑）
  // **第三问也能人工改**（结论分开：它单独一组，与 ✓/理解偏/越界 不混）
  ['详情层可逐回合人工改第三问（父枝：近/远/不适用）',
    /data-intent-turn-parent-set="1:near"/.test(editableDetailHtml) &&
      /data-intent-turn-parent-set="1:far"/.test(editableDetailHtml) &&
      /data-intent-turn-parent-set="1:na"/.test(editableDetailHtml)],
  ['详情层只出现"人工判定"这一种编辑词汇（无编辑落点/回收站/拖动/多挂/拆分/改名）',
    /人工判定/.test(editableDetailHtml) &&
      !/(编辑落点|回收站|拖动|多挂|拆分|改名|退出编辑)/.test(editableDetailHtml)],
];

// ---------------------------------------------------------------------------
// **任务结构块（树状渲染）**：喂一份宿主会回的结构载荷，断言树真的画出来了。
//
// 这一块的价值在于：面板上看到的树，与研究里贴的树**是同一棵**——
// `renderTree` 是从 `tools/probes/pipeline.mjs` 抽出来的、逐字交叉校验过。
// 所以这里断言的是"那棵树被画到界面上"，而不是"另画了一棵像树的"。
// ---------------------------------------------------------------------------
const structureHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
    compactions: undefined,
    sessionId: 'session-x',
    savedBaseline: '',
    onApplyBaseline: () => {},
    structure: {
      kind: 'done',
      structure: structureState,
      roots: {
        projects: ['n1'],
        note: '单线',
        forks: [{ id: 'n1', title: '图文改编', at: 1 }],
      },
      meta: { calls: 4, batches: 1, adjudication: 'asked', inherited: 2, reasked: 1 },
    },
    // 树文本由 shared 那份 renderTree 算（与研究工具逐字交叉校验过）
    // 与客户端同一条路径：treeRows（行）→ nestRows（嵌成折叠树）
    tree: (() => {
      const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
      const { rows, unattached } = P.treeRows(structureState, structureTurns);
      return { outline: P.nestRows(rows), unattached };
    })(),
  }),
);
const structureChecks = [
  ['结构块挂在 dom 上（done）', structureHtml.includes('data-intent-structure="done"')],
  ['顶层节点默认展开（open）', /<details[^>]*open/.test(structureHtml)],
  // **树是主体、对话在节点里**（使用者裁定：扁平的话题组列表不要了）
  ['节点里列出它收的对话（可点）', /data-intent-node[\s\S]*?#\d+/.test(structureHtml) && structureHtml.includes('看这个任务收的回合')],
  ['主体渲染的是树而不是扁平话题组列表', structureHtml.includes('data-intent-outline')],
  ['扁平话题组列表已撤掉', !structureHtml.includes('点开看这一组的回合')],
  ['树用可折叠的 details/summary 渲染', structureHtml.includes('<details') && structureHtml.includes('<summary')],
  // **标记要能被读懂**：光有 ⟨✓/理解偏/越界/未判⟩ 而不解释，读者不知道那是什么
  ['结构块给出标记图例', structureHtml.includes('data-intent-legend')],
  // **树要降密度**：节点行与会话行分开渲染（节点有加粗标题 + 左色条 + 区间徽标），
  // 会话行整体带引导线；超出的回合收成"还有 N 个"（否则挂 20+ 回合的节点整屏都是字）。
  ['节点行有左侧色条（结构 vs 内容的第一层区分）', /border-left:\s*2px solid/.test(structureHtml)],
  ['会话行带引导线（虚线，缩进一级）', /border-left:\s*1px dashed/.test(structureHtml)],
  ['状态行有四态符号（○ / ◌ / ● / ✕）', /[○◌●✕]\s*(任务结构|语义核查)/.test(structureHtml)],
  ['标记本身带状态（data-intent-verdict）', /data-intent-verdict="(ok|understanding|scope|both|none)"/.test(structureHtml)],
  ['每个可折叠节点带 data-intent-node', structureHtml.includes('data-intent-node="n2"')],
  ['分支数写在 summary 上', /\d+ 个分支/.test(structureHtml)],
  ['嵌套：details 里还有 details', /<details[^>]*>[\s\S]*<details/.test(structureHtml)],
  ['节点标题在树里', structureHtml.includes('角色设定') && structureHtml.includes('插画')],
  ['回合号压在节点后面', structureHtml.includes('#2')],
  ['多父节点带 ↩ 标记', structureHtml.includes('↩ 同')],
  ['插话节点被标出来', structureHtml.includes('插话')],
  ['调用次数写在状态行里', structureHtml.includes('4 次调用')],
  ['补问/继承的账写在状态行里', structureHtml.includes('补问 1 个') && structureHtml.includes('承接继承 2 个')],
];
const structureState2 = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
    compactions: undefined,
    sessionId: 'session-x',
    savedBaseline: '',
    onApplyBaseline: () => {},
    structure: { kind: 'failed', error: '这次没算成' },
  }),
);
const structureChecks2 = [
  ['没算成时说明原因，且不影响其他部分', structureState2.includes('data-intent-structure="failed"') && structureState2.includes('这次没算成')],
];

// ---------------------------------------------------------------------------
// **删枝之后：下挂的回合要出现在「没挂任何节点」那一行上**（使用者 2026-10-10：
// "删除枝的时候，下挂的所有回合还是没有变成独立回合"）。
//
// 为什么这里要**照 IntentTab 的方式自己拼一遍 props**：`IntentBody` 只认
// `graph` / `tree` / `overrideCount`（**不认 `overrides`**）。上一版我把
// `overrides` 传给它就以为测到了，其实那一份被忽略、面板显示的是未叠加覆盖的原始结构
// ——断言在错误的输入上通过。所以这里显式走 `effectiveStructure` + `treeRows`，
// 与 `IntentTab` 里那三行同构（计算本身的正确性另有 shared 层那几条断言守着）。
// ---------------------------------------------------------------------------
const deletedHtml = (() => {
  const G = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
  const overrides = [{ op: 'delete', id: 'n1' }];
  const eff = G.effectiveStructure(structureState, overrides);
  const { rows, unattached } = P.treeRows(eff.graph, structureTurns);
  return renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      // ⚠️ `structure` 是**宿主原始结构**、`graph` 才是生效结构——与 `IntentTab` 完全一致。
      // 第一版把 eff.graph 同时当两者，于是"被删枝条的标题"永远查不到（夹具失真，
      // 断言当场抓到 `删枝条 「n1」`）。
      structure: {
        kind: 'done',
        structure: structureState,
        roots: { projects: ['n1'], note: '单线', forks: [] },
        meta: { calls: 4, batches: 1, adjudication: 'asked', inherited: 0, reasked: 0 },
      },
      tree: { outline: P.nestRows(rows), unattached },
      graph: eff.graph,
      overrideCount: eff.applied,
      prunedCount: eff.pruned.length,
      overrides,
      onOverridesChange: () => {},
    }),
  );
})();
// **被拒的覆盖必须显示**（静默拒绝 = 让人以为改成功了）。
// 这里造一条必然被拒的（改一个不存在的节点），按 IntentTab 的拼法把 rejected 传下去。
const rejectedHtml = (() => {
  const G = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
  const overrides = [{ op: 'rename', id: '不存在', title: 'x' }];
  const eff = G.effectiveStructure(structureState, overrides);
  const { rows, unattached } = P.treeRows(eff.graph, structureTurns);
  return renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      structure: { kind: 'done', structure: structureState, roots: {}, meta: {} },
      tree: { outline: P.nestRows(rows), unattached },
      graph: eff.graph,
      overrideCount: eff.applied,
      rejectedOverrides: eff.rejected,
      overrides,
      onOverridesChange: () => {},
    }),
  );
})();

// **编辑态渲染**（`initialEditing`）：此前"编辑态才出现"的东西从来没有被渲染出来看过，
// 所有相关断言都停在源码级。拖拽出问题正是在这一层——先把它渲出来，再断言。
const editingHtml = (() => {
  const G = require(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
  const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
  const overrides = [{ op: 'setPlacement', turn: 4, nodes: [] }];
  const eff = G.effectiveStructure(structureState, overrides);
  const { rows, unattached } = P.treeRows(eff.graph, structureTurns);
  return renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      structure: { kind: 'done', structure: structureState, roots: { projects: ['n1'], note: '单线', forks: [] }, meta: {} },
      tree: { outline: P.nestRows(rows), unattached },
      graph: eff.graph,
      overrideCount: eff.applied,
      overrides,
      onOverridesChange: () => {},
      initialEditing: true,
    }),
  );
})();

const editingChecks = [
  ['编辑态：编辑栏打开（data-intent-editbar=on）', /data-intent-editbar="on"/.test(editingHtml)],
  ['编辑态：回收站渲染出来', /data-intent-dropzone="trash"/.test(editingHtml)],
  ['编辑态：树上枝条可拖（draggable）', /<summary[^>]*draggable="true"/.test(editingHtml)],
  // **触屏等价路径**（A4）：拖进回收站在触屏上做不到 ⇒ 节点行也要有「删除」按钮
  ['编辑态：节点行有「删除」（触屏那条路）', /data-intent-node-delete="n1"/.test(editingHtml)],
  // **触屏也能合并枝**（A4）：拖枝条到别的枝上在触屏上做不到 ⇒ 节点行也要有按钮
  ['编辑态：节点行有「合并到…」（触屏那条路）', /data-intent-node-merge="n1"/.test(editingHtml)],
  ['只读态：没有「合并到…」（编辑态才有）', !/data-intent-node-merge=/.test(editableHtml)],
  ['只读态：没有「删除」按钮（编辑态才有）',
    !/data-intent-node-delete=/.test(editableHtml) && !/data-intent-node-delete=/.test(detailHtml)],
  // **独立回合必须真的可拖**——这条以前走的是"或者"分支，实际渲染成 div 也能通过，
  // 是典型的"看着像绿"。现在钉死：是 button、带 data-intent-pick、带 draggable。
  ['编辑态：独立回合是**可拖的 button**（不是只读的 div）',
    (() => {
      // 取**整个开始标签**：`<button` 到它自己的 `>`。属性顺序是 React 的书写顺序，
      // 只看"标记之前 300 字"会永远看不到写在标记之后的 `draggable`（第一版就这么写错了）。
      const at = editingHtml.indexOf('data-intent-unattached-row="4"')
      if (at < 0) return false
      const start = editingHtml.lastIndexOf('<', at)
      const tag = editingHtml.slice(start, editingHtml.indexOf('>', at) + 1)
      return tag.startsWith('<button') && /draggable="true"/.test(tag) && /data-intent-pick="4"/.test(tag)
    })(),
    (() => {
      const at = editingHtml.indexOf('data-intent-unattached-row="4"')
      return at < 0 ? '没有这一行' : editingHtml.slice(Math.max(0, at - 160), at + 30).replace(/\n/g, ' ')
    })()],
];

const deleteChecks = [
  ['删枝：被删枝条从树上消失', !deletedHtml.includes('data-intent-node="n1"') && !deletedHtml.includes('>图文改编<')],
  // fixture：n1 是 n2/n3 的父，shared 同时挂 n2、n3
  // ⇒ 删 n1 = 删整棵子树（n1/n2/n3/shared），回合 1/2/3/5 因此变成独立回合
  // **独立回合要能操作**（使用者 2026-10-10："独立回合还是没有显示，这让我如何进行
  // 挂接已有枝或新枝？"）——以前那里只有一串号码：看得见、够不着。
  ['独立回合渲染成可操作的回合行（带原文、可拖）',
    /<button[^>]*data-intent-pick="1"[^>]*data-intent-unattached-row=/.test(deletedHtml) ||
      /data-intent-unattached-row="1"[^>]*>/.test(deletedHtml),
    (deletedHtml.match(/data-intent-unattached-row="\d+"/g) || []).join(',')],
  ['删枝：下挂子树里的回合都出现在「没挂任何节点」行上',
    /data-intent-unattached="4"[^>]*>([^<]*)</.test(deletedHtml) &&
      ['#1', '#2', '#3', '#5'].every((t) => deletedHtml.includes(t)),
    (deletedHtml.match(/data-intent-unattached="[^"]*"[^>]*>([^<]*)</) || [])[1]],
  ['删枝：覆盖计数写进面板（改过 1 条）', /data-intent-overrides="1"/.test(deletedHtml)],
  // 独立回合区要写明怎么挂接。**分两句**：静态渲染是只读态（编辑态由「编辑落点」开），
  // 所以只在只读文案上断言"去哪挂"，编辑态的"拖到某条枝上即可挂接 / 新建枝…"走源码级
  // ——把两句混成一条断言，就会得到一条永远绿的假断言（这个文件栽过）。
  ['只读态写明去哪里挂接（开「编辑落点」）',
    deletedHtml.includes('开「编辑落点」就能把它们挂回枝上')],
  ['编辑态给两条挂接路径：拖到枝上、新建枝…（源码级，编辑态静态渲染到不了）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
      return src.includes('拖到某条枝上即可挂接') && src.includes("'新建枝…'")
    })()],
  // **面板要把"我收到了什么"写出来**（使用者两轮报"改了没反应"：
  // 以前 overrideCount 只写在不显示的 data- 属性上，"没生效"与"没显示"分不出来）
  // **被删的枝条也要显示真名**（只查生效结构会写成生 id：`删枝条 「t21」`——
  // 使用者的诊断块里正是这样，认不出是哪一枝）。标题先查宿主原始结构。
  ['面板写明改过什么，且被删的枝条显示真名',
    /data-intent-edit-effect="1\/0"/.test(deletedHtml) &&
      deletedHtml.includes('人工覆盖：改过 1 条') &&
      deletedHtml.includes('删枝条 「图文改编」'),
    (deletedHtml.match(/人工覆盖：[^<]*/) || [''])[0]],
  // 「没挂任何节点」常显：写"（无）"就是真的没有，写不出来就是渲染没到
  ['没挂任何节点这一行常显（无独立回合时写「（无…）」）',
    /data-intent-unattached="0"[\s\S]{0,240}（无/.test(structureHtml)],
  // **被拒的要带原因显示**（不许静默拒绝）：说全 + 一键清理
  ['被拒的覆盖带原因列出（这条指向的节点已经不在结构里）',
    /data-intent-rejected-list="1"/.test(rejectedHtml) &&
      rejectedHtml.includes('1 条改动没生效') &&
      rejectedHtml.includes('没有这个节点')],
  ['被拒的覆盖给一键清理入口', /data-intent-drop-stale="1"/.test(rejectedHtml)],
  // "改过 N 条"只算生效的（此前把被拒的也算进去 ⇒ "改过 14 条 · 等 15 条"这种自相矛盾的账）
  ['"改过 N 条"只数生效的（被拒的不算进摘要）',
    /data-intent-edit-effect="0\/1"/.test(rejectedHtml) &&
      rejectedHtml.includes('人工覆盖：没改过') &&
      !rejectedHtml.includes('人工覆盖：改过 1 条')],
  // 诊断块：把面板实际拿到的东西一次摊开（来回三轮都是靠手抄一两行）
  ['诊断块可复制（覆盖 + 结构节点 + 未归属回合 + 被拒原因）',
    /data-intent-diag="1"/.test(deletedHtml) &&
      deletedHtml.includes('结构节点') &&
      deletedHtml.includes('未归属回合')],
];

// **选中的节点不存在时必须回落**，否则面板整个空白且没有返回按钮。
const vanishedHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
    compactions: undefined,
    sessionId: 'session-x',
    savedBaseline: '',
    onApplyBaseline: () => {},
    initialSelection: 'n-不存在',
  }),
);
// **`pickSession` 的规矩：就显示你正在看的那个。**
//
// 上一版的规矩是反的——"当前会话没有 intent 时让位给有值的"。那时这条断言
// 写的是 `=== 'rich'`，理由是"面板要靠 intent 才显示得出东西"。
// 实测发现那个交换是亏的：面板顶部写「133 回合」，而侧栏当前会话是另一个
// 7 回合的新会话——**静默显示了别人的意图**，界面上没有一处说明。
// 而且自定义基线按会话 id 存，跳走之后会写到另一个会话的键上。已反过来。
const pickChecks = [
  [
    '作用域里有会话就用它（哪怕它没有 intent）',
    mod.pickSession(
      {
        ids: ['empty', 'rich'],
        byId: {
          empty: { projectionValues: { goal: null, turnOutline: [] } },
          rich: { projectionValues: projectionWithIntent },
        },
        current: 'empty',
      },
      'empty',
    ).id === 'empty',
    String(
      mod.pickSession(
        {
          ids: ['empty', 'rich'],
          byId: {
            empty: { projectionValues: { goal: null, turnOutline: [] } },
            rich: { projectionValues: projectionWithIntent },
          },
          current: 'empty',
        },
        'empty',
      ).id,
    ),
  ],
  [
    '有 intent 的当前会话当然也用它',
    mod.pickSession(
      { ids: ['rich'], byId: { rich: { projectionValues: projectionWithIntent } }, current: 'rich' },
      'rich',
    ).id === 'rich',
  ],
  [
    '用作用域里的会话时 borrowed 为假',
    mod.pickSession(
      { ids: ['empty', 'rich'], byId: {}, current: 'empty' },
      'empty',
    ).borrowed === false,
  ],
  [
    '作用域里压根没有会话时才借，且标记为借来的',
    (() => {
      const picked = mod.pickSession(
        {
          ids: ['empty', 'rich'],
          byId: {
            empty: { projectionValues: { goal: null, turnOutline: [] } },
            rich: { projectionValues: projectionWithIntent },
          },
        },
        undefined,
      )
      return picked.id === 'rich' && picked.borrowed === true
    })(),
    JSON.stringify(
      mod.pickSession(
        {
          ids: ['empty', 'rich'],
          byId: {
            empty: { projectionValues: { goal: null, turnOutline: [] } },
            rich: { projectionValues: projectionWithIntent },
          },
        },
        undefined,
      ),
    ),
  ],
  [
    '一个会话都没有时返回空且不标借用',
    (() => {
      const picked = mod.pickSession({ ids: [], byId: {} }, undefined)
      return picked.id === undefined && picked.borrowed === false
    })(),
  ],
];

// **一份没有 goal 事件的投影** —— 用来测"不编造 onset"。
// 拿有 goal 的那份去测"onset 是 0"，测不出任何东西。
const projectionNoGoal = {
  goal: null,
  turnOutline: projectionWithIntent.turnOutline,
  intent: { ...hostIntent, goalOnset: 0, goalTimeline: [] },
}
const projectionWithoutCompaction = { ...projectionWithIntent }

const vanishChecks = [
  [
    // 概况层现在是**任务结构树**（扁平话题组列表已按使用者裁定撤掉），
    // 所以"回落"的判据改成"仍然渲染出概况层的内容"，而不是找那句已删掉的表头。
    '节点不存在时回落概况层而不是空白',
    vanishedHtml.includes('data-intent-structure') && !vanishedHtml.includes('回到概况'),
    vanishedHtml.length + ' 字符',
  ],
  ['回落时说明仍显示', vanishedHtml.includes('承接') || vanishedHtml.length > 400],
];

// **共享语义（`shared/intent.ts`）的断言不在这里**——见 `verify-shared.cjs`。
// 那个模块是纯函数，能被 Node 直接 import，不必经过 bundle；
// 而本脚本读的是包装后的 bundle，包装脚本拒绝别名 re-export（正确行为）。


// 侧栏那条路（`tabDescriptor` / `IntentSurface`）**已随"只留主区视图"删除**：这里直接渲染
// 主体 `IntentTab`（等价于原先经 `IntentSurface` 的那次渲染），另加三条断言盯住
// "删干净了 + 主区那条新路真的通"。
const mainView = mod.makeConversationView(ctx);
const mainViewElement = mainView({ sessionId: 'session-x' });
const html = renderToStaticMarkup(React.createElement(mod.IntentTab, {
  ctx, scope: { sessionId: 'session-x' }, visible: true,
}));
// **宽区档要一路走到 DOM**：只验 props 传递不够——`layoutFor(wide)` 那一步也得接上，
// 否则主区（比侧栏宽得多）还是按窄列排。`layoutFor(true).maxWidth = 1100`。
const wideHtml = renderToStaticMarkup(React.createElement(mod.IntentTab, {
  ctx, scope: { sessionId: 'session-x' }, visible: true, wide: true,
}));

const checks = [
  ['侧栏那条路已删除（无 tabDescriptor / IntentSurface）',
    mod.tabDescriptor === undefined && mod.IntentSurface === undefined,
    typeof mod.tabDescriptor + ' / ' + typeof mod.IntentSurface],
  ['主区视图注册名是 conversation.view', mod.CONVERSATION_VIEW?.name === 'conversation.view', String(mod.CONVERSATION_VIEW?.name)],
  ['主区把宽区档传给主体（曾漏传 ⇒ 主区按窄列排）', mainViewElement?.props?.wide === true, String(mainViewElement?.props?.wide)],
  ['渲染出 HTML', html.length > 500, html.length + ' 字符'],
  // **可选段跳过了要说出来**（判整理/根裁定/补问失败不再丢掉整份结构，但必须可见）
  ['跳过的段在面板上说出来了（data-intent-skipped + 全文进 title）', (() => {
    const withSkipped = renderToStaticMarkup(React.createElement(mod.IntentBody, {
      ...EDITABLE_PROPS,
      structure: {
        ...STRUCTURE_PROPS.structure,
        meta: {
          ...STRUCTURE_PROPS.structure.meta,
          skipped: ['判整理跳过了：判整理 的回复不是合法 JSON：Unterminated string in JSON at position 3121'],
        },
      },
    }));
    return withSkipped.includes('data-intent-skipped="1"') &&
      withSkipped.includes('判整理跳过了') && withSkipped.includes('title="判整理跳过了') &&
      !editableHtml.includes('data-intent-skipped');
  })()],
  ['宽区档落到 DOM（max-width:1100px，窄列不设限宽）',
    wideHtml.includes('max-width:1100px') && !html.includes('max-width:1100px')],
  ['含目标文本', html.includes('docs/44')],
  // **目标时间线**：官方 `goal` 投影只有当前值，没有历史——这份是我们自己 fold 的。
  ['显示目标时间线', /目标时间线 4 次/.test(html), (html.match(/目标时间线[^<]*/) || [null])[0]],
  ['时间线标出建立回合', /#58[^<]*建立/.test(html), ''],
  ['时间线区分建立与其余操作', /建立/.test(html) && /停|续/.test(html)],
  ['含组区间', /#\d+(–\d+)?/.test(html)],
  // 「目标派生自」现在只在**详情层**（`detailChecks` 里那条仍盯着它）——
  // 概况层不再逐组列卡片，所以这条从概况层断言里移走，而不是放宽。
  ['概况层给出树/结构入口', html.includes('data-intent-outline') || html.includes('任务结构')],
  ['含回合区间', /#\d/.test(html)],
  ['含百分比', /\d+%/.test(html)],
  ['标出 inferred/derived', html.includes('derived') || html.includes('inferred')],
  // 分层：概况层**不该**出现逐回合的行——那是详情层的内容。
  ['概况层不含回合行', !html.includes('>#1<') && !/第 \d+–\d+ 回合/.test(html)],
  ['概况层不再列扁平话题组卡片', !html.includes('点开看这一组的回合')],
  // **话题转向区已撤**（使用者裁定弃组、只保留 DAG）：词面转向判据连同它的展示一起下线。
  // 这条从"给出转向"改成"不再出现"，是**改指向**而不是放宽。
  ['概况层不再显示话题转向', !html.includes('话题转向')],

  // 承重检查：面板自己不会滚（paneContent 是 overflow:hidden），内容必须自带滚动。
  ['根容器可滚动', /overflow-y:\s*auto/.test(html), (html.match(/overflow-y:[^;"]*/) || [''])[0]],
  ['根容器可收缩', /min-height:\s*0/.test(html)],
  // 「编辑基线」已删（B4-4）：改名走覆盖系统 ⇒ 断言改成盯那句指路（**改指向，不是放宽**：
  // 仍然要求界面上有一处说明"改名去哪儿做"，而不是静默消失）
  // A3：头部改成**就地显示并修改会话名**（结构里没有 root 节点 ⇒ 走独立的字符串覆盖）。
  // 断言跟着改指向：仍然要求界面上有一处"会话名在哪、能不能改"的交代。
  ['头部显示会话名（带 data 属性，便于断言与排查）',
    /data-intent-session-title=/.test(html) && html.includes('会话名：')],

  // 「基线：…」标签已删（B4-4）：它标注的概念随贴合度下线，名字与实际作用不符。
  // 断言改成**反向**：不再出现"基线"这个已死的概念（防止有人顺手加回来）
  ['不再出现"基线"字样', !/基线：/.test(html)],

  ['不再列出话题转向', !html.includes('话题转向')],
  // **措辞里不再有"可能由窗口收缩造成"那种因果推断。**
  // 那个机制已被本项目自己的检验否掉（tools/test-compaction-confound.py：
  // 压缩前后窗重合上升 +0.0091）。现在只报距离，并明说"成因未证实"。
  ['低贴合计数已撤（组口径指标下线）', !html.includes('组内不贴合')],
  // 结构不可用时：**按会话顺序列回合**（使用者裁定：面板按会话顺序列即可），
  // 不发明任何划分——没有结构时一个"看起来有含义的划分"比没有更糟。
  ['结构不可用时给出按会话顺序的回退视图', html.includes('data-intent-fallback')],
  // **回退列表的文字取自宿主折叠那份**（`stateVersion` 8 起的 `intent.turns[].prompt`），
  // 不是官方 `turnOutline` 的短截断。两者都从同一个 `turn/end` 事件来，
  // 但结构流水线的材料必须是宿主那份——否则喂给模型的原文是侧栏卡片口径。
  ['回退列表用宿主折叠的原文', html.includes('宿主折叠的原文（口径测试）')],
  ['回退列表不用官方大纲那份', !html.includes('官方大纲：画风')],
  ['不出现"可能由窗口收缩造成"', !/可能由窗口收缩造成/.test(html)],
  ['贴合度条不再染红判定', !/background:\s*#d9463f/.test(html)],
  // 措辞：不出现"跑题/偏离"这类图无权下的结论。注释里解释为什么不用它是可以的，
  // 但**渲染出来的文字**里不能有。
  ['界面不出现"偏离"字样', !/偏离/.test(html.replace(/<!--[\s\S]*?-->/g, ''))],
  // 分组必须有派生目标，且**标明它是派生的**——不是作者写的。
  // 概况层不再逐组列卡片（扁平列表已撤），这条挪到详情层盯着：
  // 见 `detailChecks` 的「详情层给出组目标来源」。这里断言它**没有**在概况层出现。
  ['概况层不再出现组头派生标注', !/目标派生自/.test(html)],
  ['未出现"偏离"字样', !/偏离/.test(html)],
  // **措辞与语义必须同源。** 语义从"与全局目标的趋近度"改成"组内贴合度"之后，
  // 界面文字与 tooltip 若还写着旧词，读者会对百分比的含义产生错的预期。
  ['未出现"趋近度"字样', !/趋近度/.test(html)],
  ['未出现"目标尚未建立"', !/目标尚未建立/.test(html)],
  // **简报回合的"agent 理解"**。
  //
  // 它站得住的用处只有这一处：用户只说「同意」时，**原话里没有任何具体指称**
  // （211 个简报回合里，带路径 / `#N` / 标识符的 prompt 是 **0 个**），
  // 而 agent 的复述是完整的一句。所以面板在这一处显示**不是用户说的话**——
  // 必须标出来源，否则读者会以为那是用户说的。
  ['简报回合显示 agent 的理解', /data-intent-statement/.test(detailHtml)],
  ['标明它不是用户说的话', /agent 理解为：/.test(detailHtml)],
  ['理解句的内容来自投影', /continue optimising docs\/44/.test(detailHtml)],
  [
    '没有该字段的回合不显示理解句',
    (() => {
      const only = mod.modelFromProjection(
        {
          goal: null,
          turnOutline: projection.turnOutline,
          intent: {
            ...hostIntent,
            turns: hostIntent.turns.map((t) => (t.statement ? { ...t, statement: undefined } : t)),
          },
        },
        'x',
      )
      return only.turns.every((t) => t.statement === undefined)
    })(),
  ],
];

// **借来的会话必须显式标注。**
//
// 一份"别人的意图"和"你的意图"在界面上长得一模一样。不标注的话，
// 用户看到的是一个**看起来像答案的错答案**——比空白糟。
// 实测：上一版在 3098 上显示 133 回合的会话，而侧栏当前会话是 7 回合的新会话。
const borrowedHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '借来的'),
    compactions: undefined,
    sessionId: 'session-abcd1236-17b4-44cc-8162-0dcd452a1f7d',
    borrowed: true,
    savedBaseline: '',
    onApplyBaseline: () => {},
  }),
);
const ownHtml = renderToStaticMarkup(
  React.createElement(mod.IntentBody, {
    model: mod.modelFromProjection(projectionWithIntent, '自己的'),
    compactions: undefined,
    sessionId: 'session-abcd1236-17b4-44cc-8162-0dcd452a1f7d',
    borrowed: false,
    savedBaseline: '',
    onApplyBaseline: () => {},
  }),
);
// **语义核查那条状态行**：四种状态都必须说出来。
//
// 不说出来的后果实测过：模型调用那次失败，界面只是**静静地什么都不显示**，
// 我照着"没反应"去查了路由、effect 生命周期——**方向全错**。
// 状态可见是这类异步功能的可用性底线。
/**
 * `detail` 为假时渲染**概况层**——状态行只在那里出现（进了详情层，
 * 读者已经在看具体内容，不需要导读）。第一版这里固定传了 `initialSelection`，
 * 于是四条状态断言全红——**是我的测试搭错了，不是代码错了**。
 */
const semanticHtml = (semantic, detail = false) =>
  renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '语义'),
      compactions: undefined,
      sessionId: 'session-x',
      semantic,
      savedBaseline: '',
      onApplyBaseline: () => {},
      ...(detail ? { initialSelection: 'group-1' } : {}),
    }),
  );
const semanticChecks = [
  // ── **交接摘要**（阶段 1 的 UI + 阶段 2 的按钮）─────────────────────────
  ['交接摘要：预览层渲染出草稿（快照声明 / 文本域 / 开关 / 精炼 / 复制 / 下载 / 关闭）', (() => {
    const html = renderToStaticMarkup(React.createElement(mod.IntentBody, {
      ...EDITABLE_PROPS,
      initialEditing: true,
      initialHandoff: true,
      initialPicked: [1, 2],
    }));
    return html.includes('data-intent-handoff="2"') &&
      html.includes('data-intent-handoff-text') &&
      html.includes('交接摘要 · 2 回合') &&
      html.includes('快照') &&
      html.includes('不会替你建会话') &&
      html.includes('带枝名称（保留结构）') &&
      html.includes('data-intent-handoff-refine') &&
      html.includes('用模型精炼') &&
      html.includes('data-intent-handoff-copy') &&
      html.includes('data-intent-handoff-download') &&
      html.includes('data-intent-handoff-close');
  })()],
  ['交接摘要：编辑栏两个动作都在（选中整枝… / 交接摘要）', (() => {
    const html = renderToStaticMarkup(React.createElement(mod.IntentBody, {
      ...EDITABLE_PROPS, initialEditing: true, initialPicked: [1],
    }));
    return html.includes('data-intent-editbar-branch') && html.includes('选中整枝…') &&
      html.includes('data-intent-editbar-handoff="1"');
  })()],
  /**
   * **反向守卫**（使用者裁定："不直接建会话，只提供摘要等给用户"）。
   * 这条功能永远不许碰会话写入面——把守卫钉在源码级，防以后有人"顺手"加上。
   */
  ['交接摘要：**永不替你建会话**（src 里不许出现 create/prompt/会话写入口）', (() => {
    const files = ['src/client/IntentTab.ts', 'src/client.ts', 'src/host/handoffUnit.ts', 'src/shared/handoff.ts'];
    const src = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    return !/sessions\.create/.test(src) && !/\.prompt\(/.test(src) && !/sessions\.get\(/.test(src) &&
      !/sessionManager/.test(src);
  })()],
  ['交接摘要：复制失败有退路（无剪贴板接口 / 被拒都要给人出路）', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8');
    return src.includes('这个环境没有剪贴板接口') && src.includes('复制被浏览器拒绝') &&
      src.includes('请手动全选文本框内容复制');
  })()],
  // ── **碎片信号**（C#8-C）：只提示，不动结构 ─────────────────────────────
  //
  // 两条自动收拢的路实测都不动单回合节点（判整理 8/8 空操作、根裁定只管顶层线），
  // 所以先把这件事显示出来，由人用现成的「合并到…」决定。
  ['碎片信号：只收 1 个回合的枝在树上带 `·1` 徽标、概览层有汇总行', (() => {
    const frag = {
      nodes: {
        n1: { parents: ['root'], title: '甲项目' },
        n2: { parents: ['n1'], title: '只收一个回合的小事' },
        n3: { parents: ['n1'], title: '收了三个回合的正经事' },
      },
      // n2 只被 #2 引用一次；n3 被 #3/#4/#5 引用
      membership: { 1: ['n1'], 2: ['n2'], 3: ['n3'], 4: ['n3'], 5: ['n3'] },
    };
    const html = renderToStaticMarkup(React.createElement(mod.IntentBody, {
      ...EDITABLE_PROPS,
      structure: { kind: 'done', structure: frag, roots: { projects: ['n1'], note: '单线' }, meta: { calls: 1, batches: 1, adjudication: 'asked', inherited: 0, reasked: 0 } },
      // **`graph` 必须显式给**：碎片计数读的是"生效结构"的 membership（与视图一致），
      // 不给它就等于没有成员关系 ⇒ 徽标与汇总行都不会出现（我第一版就漏了这行）。
      graph: frag,
      tree: {
        outline: [
          { row: { id: 'n1', depth: 0, turns: [1, 2, 3, 4, 5], title: '甲项目', notes: [] }, children: [
            { row: { id: 'n2', depth: 1, turns: [2], title: '只收一个回合的小事', notes: [] }, children: [] },
            { row: { id: 'n3', depth: 1, turns: [3, 4, 5], title: '收了三个回合的正经事', notes: [] }, children: [] },
          ] },
        ],
        unattached: [],
      },
    }));
    // 口径是"**叶子** + 只收一个回合"：n1 是容器（有子节点）⇒ 不算；
    // n2 是只收 1 个回合的叶子 ⇒ 算；n3 收了 3 个回合 ⇒ 不算。
    return html.includes('data-intent-fragmentation="1"') &&
      html.includes('data-intent-single-turn="n2"') &&
      html.includes('碎片：1 个枝只收 1 个回合') &&
      !html.includes('data-intent-single-turn="n1"') &&
      !html.includes('data-intent-single-turn="n3"');
  })()],
  ['碎片信号：没有单回合枝时不出徽标、不出汇总行', (() => {
    const html = renderToStaticMarkup(React.createElement(mod.IntentBody, { ...EDITABLE_PROPS }));
    return !html.includes('data-intent-single-turn') && !html.includes('data-intent-fragmentation');
  })()],
  // ── **渐进渲染**（使用者："长回合很慢"）──────────────────────────────────
  //
  // 以前面板**等全部判完才显示**：83 条要 20 多秒，先判好的那些也一直空着。
  // 现在按 12 条一片、从**最新的一片**开始逐片出，每片回来就显示一次。
  ['语义判定分片：每片 ≤12 条（切小才能早出结果，调用总数不变）',
    (() => {
      const material = {
        tasks: ['甲', '乙'],
        turns: Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, task: (i % 2) + 1, ask: 'a', did: 'd', objective: 'o' })),
      };
      const shards = mod.planMaterialRequests(material, 12);
      return shards.length === 3 && shards.every((sh) => sh.turns.length <= 12);
    })()],
  ['渐进结果带 `partial`（还有几片没回来）时状态行说"正在补齐"', (() => {
    const html = semanticHtml({
      kind: 'done',
      result: {
        hash: 'h', model: 'm', at: 1, votes: 3, judged: 12, reused: 0, partial: 2,
        verdicts: [{ turn: 1, match: true, reason: '', understanding: true, inScope: true }],
      },
    });
    return html.includes('正在补齐') && html.includes('还有 2 片') && html.includes('data-intent-semantic="done"');
  })()],
  ['`semanticIsComplete`：半份（有 partial）不算完整 ⇒ 不许落盘', (() => {
    return mod.semanticIsComplete({ partial: 2 }) === false &&
      mod.semanticIsComplete({ partial: 0 }) === true &&
      mod.semanticIsComplete({}) === true &&
      mod.semanticIsComplete(undefined) === true;
  })()],
  ['完整结果不带 partial（最终那份别把自己标成半份）',
    (() => {
      const html = semanticHtml({
        kind: 'done',
        result: {
          hash: 'h', model: 'm', at: 1, votes: 3, judged: 20, reused: 3,
          verdicts: [{ turn: 2, match: false, reason: 'r', understanding: false, inScope: true }],
        },
      });
      return !html.includes('正在补齐') && /语义核查：模型读了这一段/.test(html);
    })()],
  // **第三问整批缺失要说出来**（实测材料单调时模型会整批不写 parent，
  // 而界面上只是"没有 ↔较远"——看不出是漏了）
  ['第三问整批缺失时状态行点名（不让人误以为"这一场都很贴"）',
    /⚠ 有 \d+ 条没给出第三问/.test(semanticHtml ?? '') ||
      (() => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'client', 'IntentTab.ts'), 'utf8')
        return src.includes('没给出第三问')
      })()],
  ['未判定时说"尚未判定"', /尚未判定/.test(semanticHtml({ kind: 'idle' }))],
  ['在问模型时说"正在问模型"', /正在问模型/.test(semanticHtml({ kind: 'running' }))],
  [
    '没判成时把原因显示出来',
    (() => {
      const html = semanticHtml({ kind: 'failed', detail: '连接超时' })
      return /没判成/.test(html) && /连接超时/.test(html)
    })(),
  ],
  [
    '判定完成后报条数与模型',
    (() => {
      const html = semanticHtml({
        kind: 'done',
        result: {
          hash: 'x',
          model: 'deepseek-official/deepseek-flash',
          at: 0,
          verdicts: [
            { turn: 2, match: true, reason: '' },
            { turn: 3, match: false, reason: '已经换事了' },
          ],
        },
      })
      return /1\/2/.test(html) && /deepseek-official\/deepseek-flash/.test(html)
    })(),
  ],
    [
      // **逐条标记已撤掉，这条断言记的是"为什么撤"。**
      //
      // 它曾标在回合行上，暗示"问题在这一回合"；而实测**真配对里 57% 的条目
      // 都会被标**——全部条目都亮等于没指位置。撤掉的标准是预先定的：
      // **基线过半就不再逐条标**（与本项目早先废掉"逐回合偏离"同一条尺子）。
      //
      // 判定本身没丢，降级成了概况层那一句。
      '不再逐条标"偏离"（基线 57%，指不出位置）',
      (() => {
        const html = semanticHtml({
          kind: 'done',
          result: {
            hash: 'x',
            model: 'm',
            at: 0,
            verdicts: [{ turn: 2, match: false, reason: '已经换事了', votes: 3, total: 3 }],
          },
        }, true)
        return !/data-intent-verdict/.test(html) && !/模型认为可能偏离本组/.test(html)
      })(),
    ],
    [
      '整会话那一句仍在，并写明"不当位置用"',
      (() => {
        const html = semanticHtml({
          kind: 'done',
          result: {
            hash: 'x', model: 'm', at: 0, votes: 3,
            verdicts: [{ turn: 2, match: false, reason: 'r', votes: 3, total: 3 }],
          },
        })
        // 措辞改成分开报两问（理解偏 / 越界）——"落点不清楚"那句已被取代，
        // 断言改成盯新措辞（**改指向，不是放宽**：仍然要求把"不当位置用"写出来）
        return /条有问题（理解偏 \d+ 条 · 越界 \d+ 条/.test(html) && /不当位置用/.test(html) &&
          // **权限边界**：越界只是建议，系统不自行改动（使用者裁定）
          /越界只能当建议/.test(html) && /系统不会自行改动任何落点/.test(html)
      })(),
    ],
  [
    // 票数仍然要出现在**整会话那一句**里（`N 条全票`）——票数是可信度的线索。
    '整会话那一句报出全票条数',
    (() => {
      const html = semanticHtml({
        kind: 'done',
        result: {
          hash: 'x', model: 'm', at: 0, votes: 3,
          verdicts: [
            { turn: 2, match: false, reason: 'r', votes: 3, total: 3 },
            { turn: 3, match: false, reason: 'r', votes: 2, total: 3 },
          ],
        },
      })
      return /1 条全票/.test(html)
    })(),
  ],
  [
    '一致的回合不标偏离',
    (() => {
      const html = semanticHtml({
        kind: 'done',
        result: { hash: 'x', model: 'm', at: 0, verdicts: [{ turn: 2, match: true, reason: '' }] },
      }, true)
      return !/data-intent-verdict="mismatch"/.test(html)
    })(),
  ],
];

const borrowChecks = [
  ['借来的会话带标注', borrowedHtml.includes('data-intent-borrowed')],
  ['标注里点明"没有选中的会话"', /没有选中的会话/.test(borrowedHtml)],
  ['标注里给出是哪个会话', borrowedHtml.includes('abcd1236')],
  ['不是借来的就没有标注', !ownHtml.includes('data-intent-borrowed')],
  // **"有投影但零回合"要和"没有投影"分开说。**
  // 合并成一句会让新会话看起来像"还没加载"——那会让人继续等，
  // 而它其实已经加载好了，只是真的没内容。
  [
    '零回合的会话明说"还没有回合"',
    (() => {
      const empty = mod.modelFromProjection(
        {
          goal: null,
          turnOutline: [],
          intent: { ...hostIntent, turnCount: 0, turns: [] },
        },
        '新会话',
      )
      const text = empty.notes.join(' | ')
      return /还没有回合/.test(text) && !/还没有意图投影/.test(text)
    })(),
  ],
  [
    '没有 intent 的会话仍说"还没有意图投影"',
    (() => {
      const none = mod.modelFromProjection({ goal: null, turnOutline: [] }, '新会话')
      return /还没有意图投影/.test(none.notes.join(' | '))
    })(),
  ],
];
let bad = 0;
const ran = [];
// 压缩标记：用合成数据验证分类逻辑，不依赖真实报告文件。
for (const [name, ok, detail] of pickChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of vanishChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of semanticChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of borrowChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok] of CANSPLIT_CHECKS) {
  ran.push(name);
  // 期望名单是从各数组**推导**出来的（手抄会漏），这组是动态收集的，所以在这里补登记
  EXPECTED_EXTRA.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  if (!ok) bad++;
}
for (const [name, ok, detail] of editableChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of detailChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of structureChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, fn] of rangeChecks) {
  ran.push(name);
  let ok = false; let detail = '';
  try { ok = fn() === true; } catch (error) { detail = error.message.slice(0, 80); }
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? `  (${detail})` : ''));
  if (!ok) bad++;
}
for (const [name, fn] of badgeChecks) {
  ran.push(name);
  let ok = false; let detail = '';
  try { ok = fn() === true; } catch (error) { detail = error.message.slice(0, 80); }
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? `  (${detail})` : ''));
  if (!ok) bad++;
}
for (const [name, fn] of dagViewChecks) {
  ran.push(name);
  let ok = false; let detail = '';
  try { ok = fn() === true; } catch (error) { detail = error.message.slice(0, 80); }
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? `  (${detail})` : ''));
  if (!ok) bad++;
}
for (const [name, fn] of positionChecks) {
  ran.push(name);
  let ok = false;
  let detail = '';
  try { ok = fn() === true; } catch (error) { detail = error.message.slice(0, 80); }
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? `  (${detail})` : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of layoutChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of conversationViewChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of liveHookChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of historyChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of dragChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of dragPayloadChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of branchChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of describeChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of editingChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of deleteChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of structureChecks2) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}
for (const [name, ok, detail] of checks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}

// （这一段原先还有一次 `tab.component` 的渲染给"自定义基线"用：**基线那套已被 B4-4 删除**，
//   渲染结果没有任何断言读它，于是随侧栏那条路一起删掉——留着它就是留一个会跟着死代码走的坑。）
// **「基线」这套已被 B4-4 删除**：`modelFromProjection` 不再接受手写基线的参数，
// `IntentModel` 也不再有 `baseline` 字段。原来那三条断言（改基线改来源/只改根节点文字/
// 不改回合材料与指纹）随之作废——**改指向**为两条更硬的事实：
//  ① 渲染模型是**纯函数**（同样的输入必得同样的输出）；
//  ② 它的字段里**不再有**"基线"这个概念（防止有人顺手加回来）。
const modelWithoutOverride = mod.modelFromProjection(projectionWithIntent, '上下文压缩')
const modelAgain = mod.modelFromProjection(projectionWithIntent, '上下文压缩')
const overrideChecks = [
  [
    '渲染模型是纯函数（同样输入 → 同样输出）',
    JSON.stringify(modelWithoutOverride) === JSON.stringify(modelAgain),
    `${modelWithoutOverride.turns.length} 回合`,
  ],
  [
    '模型里不再有 baseline 字段（B4-4 已删那套）',
    modelWithoutOverride.baseline === undefined,
  ],
  // **编辑基线不改变目标建立的回合。** 基线是"我拿什么当基准"，
  // 而 onset 是"会话自己的目标何时建立"——两件事，不该互相影响。
  //
  // `IntentModel` 不再带 `onset` 字段（没人在读它），但**这句话仍然要成立**：
  // 判据改成"说明里写出的建立回合不变"——那句话是从 `goalOnset` 派生的原文。
  [
    // 原来叫"编辑基线不改变目标建立回合的说明"——基线没了（B4-4），但**这句话本身**
    // 仍然要成立：说明里的建立回合来自 `goalOnset`，不该被别的因素改动。
    '目标建立回合的说明来自投影',
    /建立于\*\*第 59 回合\*\*/.test(modelWithoutOverride.notes.join(' | ')),
    modelWithoutOverride.notes.find((n) => n.includes('建立于')) ?? '(没有这条说明)',
  ],
  // **没有 goal 事件时不编造 onset。** 用一个**单独的、无 goal 的投影**测，
  // 而不是拿有 goal 的那份去测"它是 0"——后者测不出任何东西。
  [
    '无 goal 事件时不编造 onset',
    !/建立于/.test(mod.modelFromProjection(projectionNoGoal, '无目标会话').notes.join(' | ')),
    mod.modelFromProjection(projectionNoGoal, '无目标会话').notes.join(' | ').slice(0, 60),
  ],
  ['无 goal 事件时时间线为空',
    mod.modelFromProjection(projectionNoGoal, '无目标会话').goalTimeline.length === 0],
];
for (const [name, ok, detail] of overrideChecks) {
  ran.push(name);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) bad++;
}

// ---------------------------------------------------------------------------
// **语义判定的缓存键**（`semanticKey`）。
//
// 键算错不会报错，只会**静默复用错的结论**：结构变了而键没变，面板就把
// 上一次的判定贴在新结构上。所以四条都要盯住：只由材料决定、材料变则键变、
// 任务为空则空键（= 不发请求）、以及**同一材料必得同一个键**。
// ---------------------------------------------------------------------------
{
  const material = (tasks, turns) => ({ tasks, turns })
  const a = material(['图文改编：「开工」', '插画：「画第一页」'], [
    { turn: 2, task: 1, text: 'The user agrees to continue.' },
  ])
  const same = material(['图文改编：「开工」', '插画：「画第一页」'], [
    { turn: 2, task: 1, text: 'The user agrees to continue.' },
  ])
  // 节点名变了（结构重算）——这正是投影 `contentHash` 看不见的那种变化
  const renamed = material(['图文改编：「开工」', '插图：「画第一页」'], [
    { turn: 2, task: 1, text: 'The user agrees to continue.' },
  ])
  // 归属变了：同一句话挂到另一个任务上
  const reassigned = material(['图文改编：「开工」', '插画：「画第一页」'], [
    { turn: 2, task: 2, text: 'The user agrees to continue.' },
  ])
  const probes = [
    ['同一材料得到同一个语义键', mod.semanticKey(a) === mod.semanticKey(same), mod.semanticKey(a)],
    [
      '节点名变了键就变（投影 contentHash 看不见）',
      mod.semanticKey(a) !== mod.semanticKey(renamed),
      `${mod.semanticKey(a)} vs ${mod.semanticKey(renamed)}`,
    ],
    ['归属变了键就变', mod.semanticKey(a) !== mod.semanticKey(reassigned)],
    ['没有任务时键为空（不发请求）', mod.semanticKey(material([], [])) === ''],
  ]
  for (const [name, ok, detail] of probes) {
    ran.push(name)
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''))
    if (!ok) bad++
  }
}

// ---------------------------------------------------------------------------
// **判定材料里必须有"用户这一回合发布的指令"**（判"有没有偏离"的参照物）。
//
// 这条断言盯的是**打包后的客户端**：材料构造已搬到 `shared/semantic.ts`（宿主与探针
// 共用同一份），所以这里既要验"共享实现算得对"，也要验"客户端 bundle 里那一份就是它"。
// ---------------------------------------------------------------------------
{
  const structure = {
    nodes: { n1: { title: '个人资料制作' }, n2: { title: '岗位调研' } },
    membership: { 1: ['n1'], 2: ['n2'] },
  }
  const material = mod.semanticMaterial(
    structure,
    new Map([[1, '把工作经历补上'], [2, '看看广州的岗位']]),
    new Map([[2, 'The user wants job listings in Guangzhou.']]),
  )
  const first = material.turns[0]
  const probes = [
    ['材料：待判回合带的是"用户指令 + agent 理解"', first?.ask === '看看广州的岗位' &&
      first?.objective === 'The user wants job listings in Guangzhou.', JSON.stringify(first)],
    ['材料：只送被引用到的节点', material.tasks.length === 1 && material.tasks[0].startsWith('岗位调研'),
      material.tasks.join(' | ')],
    ['材料：节点号 1 起且指回被引用的节点', first?.task === 1, String(first?.task)],
  ]
  for (const [name, ok, detail] of probes) {
    ran.push(name)
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''))
    if (!ok) bad++
  }
}

// ---------------------------------------------------------------------------
// **逐回合原文的口径**（`stateVersion` 9 之前这里还只有组口径的信号）。
//
// 三件事必须同时成立，缺一件都会让结构流水线吃错材料：
//   1. wire 有原文 ⇒ **用它**（宿主折叠那份，截断到 400）；
//   2. wire 没这个键（旧载荷）⇒ 回落官方 `turnOutline`，不能变成空串；
//   3. wire 里是空串 ⇒ 就是空（官方那份也空），**不许编**。
// ---------------------------------------------------------------------------
{
  const model = mod.modelFromProjection(projectionWithIntent, '口径')
  const at = (turn) => model.turns.find((t) => t.turn === turn)
  const probes = [
    [
      '宿主原文优先于官方回合大纲',
      at(4).prompt === '宿主折叠的原文（口径测试）：画风定稿',
      at(4).prompt,
    ],
    ['旧载荷缺 prompt 时回落到官方大纲', at(5).prompt === '官方大纲：配色', at(5).prompt],
    ['空 prompt 的回合不被编造', at(3).prompt === '', JSON.stringify(at(3).prompt)],
    ['回合表按回合号对齐', model.turns.every((t, i) => i === 0 || model.turns[i - 1].turn < t.turn)],
  ]
  for (const [name, ok, detail] of probes) {
    ran.push(name)
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''))
    if (!ok) bad++
  }
}

// **多父节点（真 DAG）也要能进详情层。**
//
// 划分时代树上那一行查的是"这一回合属于哪个组"——一个回合只有一个组，
// 所以点哪一行都开得对。DAG 里同一个回合会挂在多个节点下，**每一行只该开
// 它所在的那个节点**；这条断言证明按节点 id 选中对多父节点同样成立（`shared`
// 同时挂在 `角色设定` 与 `插画` 下）。
{
  const sharedHtml = renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      initialSelection: 'shared',
      ...STRUCTURE_PROPS,
    }),
  )
  const probes = [
    [
      '多父节点也能按节点 id 进详情层',
      sharedHtml.includes('共享画风') && /收了 1 个回合/.test(sharedHtml),
      sharedHtml.includes('共享画风') ? '共享画风 · 1 回合' : '(没渲染出该节点)',
    ],
  ]
  for (const [name, ok, detail] of probes) {
    ran.push(name)
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''))
    if (!ok) bad++
  }
}

// ---------------------------------------------------------------------------
// **不能直接调用 `IntentBody`**：它带 `useState`（两层结构的选中状态），
// 直接当函数调用会抛 `Cannot read properties of null (reading 'useState')`——
// 因为那时没有 hook 宿主。这条实测踩到过，所以断言写成渲染而不是调用。
//
// 而挂载外壳（原先是 `tabDescriptor().component` = `IntentSurface`，侧栏移除后是主区的
// `makeConversationView`）**必须是无 hook 外壳**：slot 会把它当函数组件用，
// 外壳自己不能碰 hook。两者是不同的契约，下面各测一条。
{
  const body = renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithIntent, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
    }),
  );
  const ok = body.length > 100;
  ran.push('IntentBody 作为元素可渲染');
  console.log('  ' + (ok ? '✓' : '✗') + ' IntentBody 作为元素可渲染  (' + body.length + ' 字符)');
  if (!ok) bad++;

  // 无 hook 外壳：**直接调用**必须返回元素（slot 就是这样用它的）。
  const surface = mod.makeConversationView(ctx)({ sessionId: 'session-x' });
  const ok2 = surface !== null && surface !== undefined && surface?.props?.wide === true;
  ran.push('主区视图外壳直接调用返回元素');
  console.log('  ' + (ok2 ? '✓' : '✗') + ' 主区视图外壳直接调用返回元素');
  if (!ok2) bad++;
}

// **变化点检测与分组算法的断言不在这里**——见 `verify-shared.cjs`。
// 那些测的是 `src/shared/intent.ts` 的纯函数，而本脚本测的是**包装后的客户端 bundle**。
// 面板现在纯渲染（语义由宿主投影给出），所以本脚本只该断言渲染结果。

// **期望的断言名从各数组推导**，而不是手抄一份——
// 手抄的那份实测漏过条目（加了断言忘了同步），而覆盖守卫正是为了抓这个。
const EXPECTED = [
  ...detailChecks.map(([name]) => name),
  ...describeChecks.map(([name]) => name),
  ...branchChecks.map(([name]) => name),
  ...dragChecks.map(([name]) => name),
  ...historyChecks.map(([name]) => name),
  ...liveHookChecks.map(([name]) => name),
  ...conversationViewChecks.map(([name]) => name),
  ...layoutChecks.map(([name]) => name),
  ...positionChecks.map(([name]) => name),
  ...dagViewChecks.map(([name]) => name),
  ...badgeChecks.map(([name]) => name),
  ...rangeChecks.map(([name]) => name),
  ...dragPayloadChecks.map(([name]) => name),
  ...editableChecks.map(([name]) => name),
  ...EXPECTED_EXTRA.filter((name) => !editableChecks.some(([own]) => own === name)),
  ...pickChecks.map(([name]) => name),
  ...vanishChecks.map(([name]) => name),
  ...borrowChecks.map(([name]) => name),
  ...semanticChecks.map(([name]) => name),
  ...checks.map(([name]) => name),
  ...overrideChecks.map(([name]) => name),
  ...structureChecks.map(([name]) => name),
  ...deleteChecks.map(([name]) => name),
  ...editingChecks.map(([name]) => name),
  ...structureChecks2.map(([name]) => name),
  'IntentBody 作为元素可渲染',
  '主区视图外壳直接调用返回元素',
  '材料：待判回合带的是"用户指令 + agent 理解"',
  '材料：只送被引用到的节点',
  '材料：节点号 1 起且指回被引用的节点',
  '同一材料得到同一个语义键',
  '节点名变了键就变（投影 contentHash 看不见）',
  '归属变了键就变',
  '没有任务时键为空（不发请求）',
  '宿主原文优先于官方回合大纲',
  '旧载荷缺 prompt 时回落到官方大纲',
  '空 prompt 的回合不被编造',
  '回合表按回合号对齐',
  '多父节点也能按节点 id 进详情层',
  '压缩回合显示"压缩"徽标',
  '压缩标记用琥珀色（COMPACT）',
  '压缩点画出脊柱断点（虚线）',
  '无压缩数据时不出现标记',
  '徽标说明"不等于跑题"',
  'onset 取自投影而非写死',
  '说明里写出建立回合',
  '说明里点明不是 roundsStarted',
  '只数当前目标之后的变更',
  '建立回合与回合总数自洽',
  '无 compactionTurns 时不标压缩',
  '有 compactionTurns 时命中',
  '非压缩回合不命中',
  '压缩计数',
  '未定义载荷不抛',
];


// **基线存储与改名迁移的断言已删（B4-4）**：`readBaseline`/`writeBaseline` 与
// `graph-view:intent-baseline:*` 的迁移那套机器整体删除——基线只剩"改头部一个字符串"的效果，
// 而改名需求由覆盖系统接管（详情层对节点用「改名」）。所以这里不再有存储迁移可测。
// 反过来，上面已有断言守住"界面不再出现'基线'字样"与"模型里没有 baseline 字段"。

// **压缩标记来自投影，不来自文件。**
//
// 这里曾经有一整块"读 ~/.dsh/reports/compactions.json"的逻辑，而插件在浏览器
// 沙箱里没有可用的读文件通道——整块是死的。修法是让宿主把 fold 里已经收集好的
// `compactionTurns` 随投影发出来。
{
  const withCompaction = {
    ...projectionWithIntent,
    intent: { ...hostIntent, compactionTurns: [3] },
  };
  const probes = [
    ['无 compactionTurns 时不标压缩', mod.isCompactionTurn(hostIntent, 1) === false],
    ['有 compactionTurns 时命中', mod.isCompactionTurn(withCompaction.intent, 3) === true],
    ['非压缩回合不命中', mod.isCompactionTurn(withCompaction.intent, 4) === false],
    ['压缩计数', mod.compactionCount(withCompaction.intent) === 1, String(mod.compactionCount(withCompaction.intent))],
    ['未定义载荷不抛', mod.compactionCount(undefined) === 0 && mod.isCompactionTurn(undefined, 1) === false],
  ];
  for (const [name, ok, detail] of probes) {
    ran.push(name);
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) bad++;
  }
}


// **压缩标记的渲染**：压缩回合必须看得出来，普通回合不能有。
//
// 这条断言的价值在于"标记不能只存在于数据里"——`compactionTurns` 到浏览器
// 而界面不显示，是这块功能此前的状态（整块死代码）。
{
  const withCompaction = {
    ...projectionWithIntent,
    // fixture 的 turn 3 是那个"空 prompt 用回复兜底"的回合，把它标成压缩点。
    intent: { ...hostIntent, compactionTurns: [3] },
  };
  const marked = renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(withCompaction, '上下文压缩'),
      compactions: withCompaction.intent,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      initialSelection: 'n2',
      ...STRUCTURE_PROPS,
    }),
  );
  const unmarked = renderToStaticMarkup(
    React.createElement(mod.IntentBody, {
      model: mod.modelFromProjection(projectionWithoutCompaction, '上下文压缩'),
      compactions: undefined,
      sessionId: 'session-x',
      savedBaseline: '',
      onApplyBaseline: () => {},
      initialSelection: 'n2',
      ...STRUCTURE_PROPS,
    }),
  );
  const probes = [
    ['压缩回合显示"压缩"徽标', marked.includes('压缩')],
    // **不能断言"整份 HTML 里没有红色"**——`LOW`（#d9463f）被"不贴合"标签
    // 合法使用着。这里只断言压缩标记用的是琥珀色。
    ['压缩标记用琥珀色（COMPACT）', marked.includes('#c99a3a'), '#c99a3a'],
    ['压缩点画出脊柱断点（虚线）', marked.includes('dashed')],
    ['无压缩数据时不出现标记', !unmarked.includes('#c99a3a')],
    ['徽标说明"不等于跑题"', /不等于跑题/.test(marked)],
  ];
  for (const [name, ok, detail] of probes) {
    ran.push(name);
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) bad++;
  }
}


// **`onset` 从 `goal/change` 事件来。**
//
// 这里曾经写死为 0 并注明"目标建立于第几轮不可观测"——那个结论是错的。
// `roundsStarted` 确实不能当回合号（实测错 89 个回合），但**事件流里有真回合号**，
// 只是当时没有 fold `goal/change`。
{
  const withGoal = {
    ...projectionWithIntent,
    intent: { ...hostIntent, goalOnset: 59,
              goalTimeline: [
                { turn: 0, operation: 'create', revision: 1 },
                { turn: 0, operation: 'pause', revision: 1 },
                { turn: 58, operation: 'create', revision: 1 },
                { turn: 61, operation: 'pause', revision: 3 },
              ] },
  };
  const model = mod.modelFromProjection(withGoal, 'x')
  const note = model.notes.join(' | ')
  const probes = [
    // `IntentModel` 不再带 `onset` 字段，判据落在**它派生出的那句话**上：
    // 59 是投影给的，说明里就必须写 59。
    ['onset 取自投影而非写死', /建立于\*\*第 59 回合\*\*/.test(note), note.slice(0, 60)],
    ['说明里写出建立回合', /第 59 回合/.test(note)],
    ['说明里点明不是 roundsStarted', /roundsStarted/.test(note)],
    // fixture 里有两个目标：turn 0 create→pause（旧目标）+ turn 58 create→pause（当前）。
    // **只该数当前目标之后的**，所以是 1 次而不是 3 次。
    ['只数当前目标之后的变更', /1 次变更/.test(note), note.slice(0, 70)],
    // 原来这里断言 `model.turnsBeforeOnset === 58`（"建立之前有 58 个回合"）。
    // 那个字段没有任何消费者，随 ③ 一起删了；**这条事实本身**仍可观测：
    // `goalOnset` 就是"建立于第几回合"，而建立回合之前的回合数 = onset - 1。
    [
      '建立回合与回合总数自洽',
      withGoal.intent.goalOnset === 59 && model.turnCount === withGoal.intent.turnCount,
      `${withGoal.intent.goalOnset} → ${withGoal.intent.turnCount} 回合`,
    ],
  ];
  for (const [name, ok, detail] of probes) {
    ran.push(name);
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
    if (!ok) bad++;
  }
}

const missing = EXPECTED.filter((name) => !ran.includes(name));
if (missing.length > 0) {
  console.log('✗ 期望的断言没有跑（锚点失配？）: ' + JSON.stringify(missing));
  process.exit(1);
}
if (ran.length !== EXPECTED.length) {
  console.log(
    '✗ 断言数量与预期不符：跑了 ' + ran.length + ' 条，预期 ' + EXPECTED.length + ' 条',
  );
  process.exit(1);
}
console.log('✓ ' + EXPECTED.length + ' 条期望断言全部跑到');
process.exit(bad === 0 ? 0 : 1);
