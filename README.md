# dsh-intent-view

在 DSH 里查看**会话的意图**：把一段会话折成一棵**任务结构树（DAG）**——
哪些事情在做、它们怎么长出来（父节点可以不止一个）、每个回合落在哪几件事上。

本插件注册**两个面**，都属于同一件事：

| 面 | 内容 | 数据从哪来 |
|---|---|---|
| **意图 tab** | 任务结构。概况层（树）+ 详情层（选中节点的回合）+ 语义核查状态行 | 宿主侧投影 + 宿主侧四段流水线（模型调用走可注入的 `llm`） |
| **host 投影单元** | `intent` 键：逐回合材料（原文 / agent 的理解）+ 压缩点 + 目标时间线 | 会话事件流 |

两个面是同一条数据通路的消费端与计算端，**不是两件事**。

**契约依据**（DSH 官方的 capability-seam three-way split）：

> 框架拥有订阅、watermark 缓存、变更通知；**领域宿主插件贡献纯折叠
> （pure fold）+ 可选的客户端视图**；载体消费快照与变更流；两侧互不知道对方。
>
> *"How a value is rendered is the slot system's business, never this layer's."*

所以**语义在宿主侧算，浏览器只渲染**——这条在代码里可验证：
`src/client/**` 对 `bigrams(` 的调用数为 **0**；任务结构**也不是在浏览器里算的**
（走宿主路由 `/api/intent.structure` 的四段流水线），人工调整走
`/api/intent.overrides` + 覆盖表。

## 依赖面

实际依赖：

| 包 | 何时需要 | 用在哪 |
|---|---|---|
| `@deepseek-ai/cordis` | 编译期 | `Context` 类型、`name` / `inject` / `apply` 三件套 |
| `@deepseek-ai/dsh-session` | 运行期 | `SessionSeq`（投影状态的品牌类型） |
| `@deepseek-ai/dsh-session-projection` | **编译期** | **声明合并**：让 `ctx.sessionProjections` 与投影键表认得 `intent` |
| `zod` | 运行期 | `host/intentProjection.ts` 的 `stateSchema` / `viewSchema` |
| `react` | 运行期 | client 渲染（由 DSH 客户端运行时提供） |

**没有第三方依赖**：右侧栏那条路（`dsh-better-sidebar`）已移除（2026-10-14），
面板只挂 DSH 自带的 `conversation.view` slot。

**后四个是投影架构的代价**：`ctx.sessionProjections.register` 与 `SessionSeq`
都是 DSH 框架的——语义放到宿主投影里，就必须用框架的类型。
（这一条与本项目的核心决定同源，见上面"契约依据"。）

`@deepseek-ai/dsh-session-projection` 的 side-effect import 是**编译期**必需的：
去掉它，`ctx.sessionProjections` 与 `declare module` 的合并都会失效
（实测两条 `tsc` 报错）。运行期它是 no-op——DSH 已经加载过那个包。

## 这是一个独立项目

```
~/dsh-intent-view    本插件（独立 git 仓库）
```

**纯意图展示。** 它此前还注册过一个"查看 graph-view 产物"的文件查看器，
**已移除**：意图展示与图渲染是两件事，各有各的数据通路。

安装：

```bash
dsh plugin --profile <name> add ./dsh-intent-view
```

## 纯 Node，零 Python

构建链全是 Node，**没有任何 Python 依赖**：

```
scripts/wrap-client.mjs        把 tsc 的 ESM 内联包装成 DSH 浏览器侧模块格式
scripts/check-client.mjs       构建期检查：产物已包装 / 宿主半边可加载
scripts/client-harness.cjs     在 Node 里跑真实产物，验证注册逻辑（用真的 react）
scripts/verify-shared.cjs      共享纯函数 + 语义层 + 压缩回合收集的断言（36 条）
scripts/verify-intent-tab.cjs  渲染层与改名迁移的断言（114 条）
scripts/verify-task-graph.cjs / verify-task-overrides.cjs / verify-override-storage.cjs
                               任务图纯函数、人工调整的校验、浏览器侧持久化
scripts/verify-task-pipeline-port.cjs / verify-task-structure.cjs / verify-task-tree.cjs
                               流水线提示词搬运、宿主单元、树渲染
scripts/e2e-panel.mjs          真浏览器端到端（CDP 直连，零依赖）
```

**移植时做的一件有用的事**：把新实现的**产物与旧实现逐字比对**。
`wrap-client.mjs` 第一版多出 8 个空行——原因是 `'a\n'.split('\n')` 在 JS 里
给出 `['a', '']`，而 Python 的 `splitlines()` 给出 `['a']`，空串落在每个文件的
内联边界上。补齐之后产物**逐字一致**，于是"移植没改变行为"成了可验证的断言，
而不是"我看着差不多"。

`e2e-panel.mjs` 不用 playwright：它需要的能力只有"开浏览器、求值一段 JS、
收 console 事件"，而 **Chrome DevTools Protocol 直连就够了**——Node 22 自带
`WebSocket`，所以整条检查零依赖（也不必为此拉一份浏览器）。

## 名字的由来

原名 `dsh-graph-view`。改名是因为审计发现**名字与描述只覆盖了当时三个面里的一个**
——而且是最旧的那个（文件查看器，现已移除）。意图展示才是主体。

## 挂在哪里

只有一个挂载点：**主区对话视图**（与 Chat / Trajectory 同级），走 DSH 自带的 slot。

| | 主区对话视图 |
|---|---|
| 与谁同级 | **Chat / Trajectory** |
| 机制 | DSH 自带 `ctx.slots.register('conversation.view', …)` |
| 版式 | 宽区（限宽 1100、摘要 96 字、每节点不截断、区间 10 个一组） |
| 自动验证 | ✅ `npm run check:live:panel <url>` 能点开并渲染出面板 |

`slots` 是**软依赖**（`ctx.get('slots')`，**故意不写进 `inject`**）：取不到就静默不注册，
`apply` 其余部分照常跑（诊断钩子也在）。

> 右侧栏那条路（第三方 `betterSidebar.registerTab`）**已移除**（2026-10-14）。去留取舍见
> `research/sidebar-vs-main-view-2026-10-10.md`。移除的直接好处：
> **发布出去的树里不再有任何第三方依赖**。

## 安装（源码发布：**自己打包**）

本仓库**只发源码，不含构建产物**（`lib/` 在 `.gitignore` 里）。原因：产物与源码容易不一致，
而构建只要一条命令。由于 `package.json` 的 `main` 指向 `lib/index.js`，**必须先构建**：

```bash
git clone https://github.com/xinye87v5/dsh-intent-view.git && cd dsh-intent-view
npm install && npm run build          # 产出 lib/（类型检查 + 打包自检 + 550 条断言）
dsh plugin --profile <name> add ./dsh-intent-view   # 本地路径安装
```

从 git 直接安装的场景（npm 会跑 `prepare`，等于自动构建一次）：

```bash
dsh plugin --profile <name> add git+https://github.com/xinye87v5/dsh-intent-view.git
```

**依赖**：**没有第三方运行时依赖**。宿主侧只用 DSH 自带服务（`sessionProjections` /
`sessions` / `llm`）；客户端只用自带的 `slots` 与宿主已提供的 React。

## 一个扩展点：`conversation.view`

| 面 | 看什么 | 数据来源 |
|---|---|---|
| **「意图」视图** | **活的会话意图**，随回合实时演变 | 会话投影 `ctx.get('sessions').list` |

会话作用域的标准 props 由 slot 给（注册时声明 `inject: (sessionId) => ({ sessionId })`）；
面板真正要的**任务意图**走 `ctx.sessionProjections.register()` 自己贡献投影单元——也就是
在宿主侧建一条通路（`src/host/intentProjection.ts`）。代价是真实的（多一个宿主单元、
多一个投影键），换来的是**数据是活的**：意图本来就是随时间演变的东西，静态产物表达不了它。

### 必须导出 `inject`，否则 `apply` 永远不会被调用

```ts
export const inject: string[] = []   // 现在是空的：只挂主区，而它要的 slots 是软依赖
```

Cordis 靠 `inject` 知道要等哪些服务就绪，在那之前**不激活插件的 fiber**。

**这个 bug 的失败模式极难查**，所以单独记下来：

| 现象 | 实际 |
|---|---|
| 模块在 `loadCache` 里 | ✅ 加载了 |
| 页面零错误 | ✅ 没有异常 |
| bundle 里有注册代码 | ✅ 代码在 |
| **面板不出现** | ❌ `apply` 从未被调用 |

查法：对比同类插件的导出。参考实现 `dsh-brief-sidebar` 是
`inject = ['betterSidebar','locale','slots']`，而我只导出了 `apply`。

只声明真正用到的服务——多声明会让你在缺少它们的组合里被无谓地卡住。
本插件因此**一个都不声明**（`slots` 走软依赖）。

自检里因此有断言盯着这件事（`导出了 inject` / `inject 里不再有第三方服务`）。

### 面板不会替你滚

DSH 的视图容器**不替内容滚动**（`overflow: hidden`）——每个视图自己的内容负责滚。

不设的实测后果：内容高 **9764px**、可视区 **965px**，被裁掉且滚不动。

```ts
const SCROLL: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,          // ← 关键：flex 项默认 min-height:auto 会按内容撑开
  overflowY: 'auto',
  overflowX: 'hidden',
}
```

自检里有两条断言守着它（`根容器可滚动` / `根容器可收缩`）。

### 树是主体，对话在节点里

概况层画的是**任务结构树**：原生 `<details>/<summary>` 嵌套（无 state、无 JS 时默认
全展开），每个节点下直接列出**它收的回合号与原文**；点一条进详情层看这个节点的全部回合。

**扁平的话题组列表已撤**（使用者裁定：每个对话在节点里面展示更好）。它曾经是
"一组一行 + 组内贴合度条"，而**划分表达不了重叠归属**：一个回合可以落在多个任务节点上，
一个节点也可以有多个父节点（实测 `n3 部署脚本通用化` 的父是 `库存看板` + `作品集网站`）。

结构不可用时（还没算、或算失败）**不发明划分**：换成按会话顺序列回合的列表——
没有结构时，一个"看起来有含义的划分"比没有更糟。

### 空 prompt 要用回复兜底

真实会话里有 `prompt` 为空但回复有内容的回合（实测 `#36`、`#37`）。
退回笼统的"（空）"会丢掉图上唯一可读的信息。没有提问的回合往往正是"继续"这类回合，
所以用回复当标签。自检里有一条断言守着。

### 分层：语义在宿主，浏览器纯渲染

| | 位置 | 职责 |
|---|---|---|
| 共享纯函数 | `src/shared/**` | 二元组 / 目标句抽取 / 任务图 / 流水线提示词 / 覆盖校验与存储 |
| 宿主 | `src/host/**` | fold（每回合 O(1)）+ wire + 四段流水线 + 两条路由 |
| 渲染 | `src/client/**` | **零语义**（`bigrams(` 调用数为 0；结构来自宿主路由） |

真机实测（零 console 错误）：任务结构树带节点数与几条线、`分叉点`、`没挂任何节点`
那一行，语义核查状态行，全部来自宿主；面板只渲染。

**一处如实标注的降级**：编辑基线只影响**根节点显示**，结构不会因这段文字重算
（结构由宿主按会话内容算）。断言守着这个事实（`编辑基线不改回合材料（语义已归宿主）`）。

**空态**：`intent` 缺失时面板说明原因，而不是一片空白——冷启动时
`projectionValues` 确实是空的。

### 历史：话题组路线与它的度量

面板与判据原先都围着"话题组"：把会话切成连续、不重叠的组，每组一个**从内容派生**的
目标（实测低重回合 56.2% → 6.6%）。那条路线**已撤**（使用者裁定：只保留 DAG），
连同它的度量一起下线：

- "TS ↔ Python 两个独立实现逐字一致"的分组交叉校验；
- `WindowDiff` / `Pk` 的分段质量对照（我们 0.4906 vs 朴素基线 0.6146，且**自证有
  自我循环成分**：真值与算法同族同窗口）。

完整论证与数字留在 `research/group-vs-dag-2026-10-10.md` 与 git 历史里。
算法本体的**冻结副本**在 `tools/probes/grouping.mjs`（手工从 TS 抄成 JS，
只做历史复现），交叉校验在 `tools/probes/grouping-crosscheck.mjs`
（12/12：379 回合 → 35 组、区间逐字一致、转向 0 个）。两者**都不在 build 里**
——它们测的是研究侧，不是产品。

### 共享层：`src/shared/**`

纯函数（无 React / 无 DOM / 无宿主依赖），**宿主与浏览器两侧共用**：

```
src/shared/intent.ts         ← bigrams / snippet / goalStatement + 三个阈值
src/shared/semantic.ts       ← 语义核查的材料、提示词、指纹、模型输出校验
src/shared/taskGraph.ts      ← 任务图：祖先闭包、落点覆盖、人工调整（覆盖操作）
src/shared/taskPipeline.ts   ← 四段流水线的提示词与纯函数（与研究工具逐字交叉校验）
src/shared/overrideStorage.ts← 人工调整的浏览器侧持久化（localStorage）
```

话题分组与话题转向**曾经也住在这里，已整块删除**（见上）。

断言：`node scripts/verify-shared.cjs`（36 条）。它现在**反过来**断言产品侧不再导出
那 17 个已删的名字——删掉的东西悄悄回来（复制粘贴，或"顺手再写一个"）同样是
"语义变成两处"的开始。

**差异的根因已查清**：不是算法，也不是消息选择，是**投影缓存**
（`~/.dsh/storages/session_projcache`）里混着不同构建写下的 `intent` 行
——同一会话的 `terms`（当时每回合存的二元组集合，现已删）数出现过 **253 / 102 / 0** 三种。

清掉缓存里的 `intent` 行后重新折叠，当时那套（分组）结果与独立模拟逐字一致。

契约对此的警告实测成立：

> A row is never authoritative, only a fold shortcut.

**所以改折叠语义时必须同时加 `stateVersion`**——它挡不住"同一版本号下语义改过"。

**一个必须记住的约束**：冷启动时 `projectionValues` 是**空的**（连官方 `goal`/`turnOutline` 也没有）；
打开有历史的会话、其日志被加载后值才出现。所以面板**不能假设它随时可读**。

### 意图投影：逐回合材料的唯一去处（宿主侧）

**架构依据是 DSH 官方的 capability-seam three-way split**
（`@deepseek-ai/dsh-session-projection` 契约原文）：

> 框架拥有订阅、watermark 缓存、变更通知；**领域宿主插件贡献纯折叠（pure fold）
> + 可选的客户端视图**；载体消费快照与变更流；两侧互不知道对方。

所以正确的形状是：**计算在宿主侧（投影 + 两条路由），浏览器只渲染。**
（契约原文：*"How a value is rendered is the slot system's business, never this layer's."*）

```
src/host/intentProjection.ts   ← 纯折叠 + wire view（回合材料 / 压缩点 / 目标时间线）
src/host/taskStructureUnit.ts  ← 四段流水线（模型调用），按 会话+指纹 缓存
src/client/**                  ← 面板（零语义：组织材料 + 渲染）
```

**已实测通过**（`session-efc6a0`，133 回合）：

| 对照项 | 投影 | 官方 `turnOutline` |
|---|---|---|
| 回合数 | **133** | **133** |
| 末回合响应长度 | **120** | **120** |
| 首回合 prompt 长 | — | 32（官方不过滤注入，故更长） |
| `promptChars` | 3271 | — |

#### 这一步抓到的四个真缺陷（都不是推测）

| # | 缺陷 | 症状 |
|---|---|---|
| 1 | 相对导入缺 `.js` | **整个 `dsh` 启动失败**：`ERR_MODULE_NOT_FOUND`。宿主是纯 ESM 由 Node 直接 import；客户端半边永远不会暴露它，因为包装脚本把相对导入内联掉了 |
| 2 | 少 `inject` | `cannot get property "sessionProjections" without inject` → 同样启动失败。官方写法：`static inject = ["agents", "sessionProjections"]` |
| 3 | 产物未包装 | 手动跑 `npx tsc` 会**覆盖**已包装的 `lib/client.js`，客户端整体 boot 失败，而报错指向**别的模块** |
| 4 | `prompt` 取不到文本 | `user/message` 的文本在 **`data.content`**（不是 `data.message.content`）；且必须按 **`source.kind === 'user'`** 过滤注入——实测 133 回合的会话里有 151 条 `user/message`，其中 19 条是 `plugin`/`goal`/`agent-instructions` 等注入 |

前三条现在都有**构建期断言**守着（`scripts/check-client.mjs`）：宿主相对导入必须带扩展名、客户端产物必须已包装。

### 压缩事件：从投影来，不读文件

**曾经的做法**：读 `~/.dsh/reports/compactions.json`（由外部脚本产出）。
**整块是死的**——插件在浏览器沙箱里**没有可用的读文件通道**：
`api.fsRead` 曾是 better-sidebar 的私有内部对象（侧栏那条路已移除），不在任何 ctx 服务上，
也不在它的 exports 里；`ctx.get('remote')` 是 object 但没有 `call`。
三条路都实测过。于是 `loadCompactions` 恒返回 `undefined`，后面的一切都走不到。

**现在的做法**：宿主 fold 从 `compaction/start` 事件收集 `compactionTurns`
（那个事件自带 `turn`），**随投影一起发出去**。客户端不读任何文件。

```ts
// host/intentProjection.ts —— apply 里就地收集
if (type === 'compaction/start') {
  const turn = Number((event.data as { turn?: unknown })?.turn)
  if (!Number.isInteger(turn) || turn < 1) return state   // 不关心就返回同一引用
  return { ...state, compactionTurns: [...state.compactionTurns, turn].sort((a, b) => a - b) }
}
```

实测（真机）：`compactionTurns: [61]`。

> **教训**：投影状态里已经算好的字段就该发出去。为了一个手边就有的字段
> 另开一条数据通路，等于让整块功能依赖一个不存在的通道。

**为什么压缩回合值得显示**：压缩之后历史被丢，之后回合与历史的**字面重合**会下降。
（原先这还会让"话题转向检测"把每一次压缩都报成一次转向；那条检测已随组口径删除，
但标记本身仍要显示——读这段会话的人需要知道**历史在哪里被截断**。）
这与 `ctx-compression/docs/21` 记的"窗口混淆"**同类**：*"高压缩层的 0% 是窗口收缩的
产物，不是发现。"*

**但要说清是同类、不是同一个量**：那边指的是"可观测机会变少"；而"压缩之后回合与
历史的**字面重合**会下降"是**机制推断，本项目至今零实测**。这条区别是被一份外部
评审逐条核对引文时指出的（`research/review-2026-09-23-by-ctx-compression.md` §1）——
**而我批评别人"靠模型自报"时用的正是同一把尺子。**

**压缩回合随投影来**（`compactionTurns`，宿主 fold 从 `compaction/start` 收集），
客户端不读任何文件——原先的"压缩距离"字段随转向检测一起删了。

### 压缩标记长什么样

概况层给一行汇总（`本会话压缩 4 次 · 落在 #55 #86 #115 #197`）；
**详情层的回合行上画成时间轴的断点**：

| 元素 | 表现 | 为什么 |
|---|---|---|
| 脊柱上半段 | **琥珀虚线** | `compaction/start` 的 `turn` 语义是"压缩发生在该回合**开始前**"，所以那一段正是历史被截断的位置 |
| 回合圆点 | 琥珀外环（不覆盖填充色） | 压缩点**同时还是个普通回合**，不该被标记盖掉 |
| 标签 | `压缩` 徽标 | 文字冗余一层，颜色不是唯一线索（色觉差异） |

**颜色刻意不是 `LOW`（红）**：压缩不是错误，也不是价值判断，它是"历史在这里被
截断了"这个事实。红色会让读者以为出了问题。琥珀只表示"注意这里有件事"。

实测（真机计算样式）：

```
border-left: 1px dashed rgb(201, 154, 58)
color:       rgb(201, 154, 58)   border: 1px solid rgb(201, 154, 58)
box-shadow:  rgb(201, 154, 58) 0 0 0 2px
```

### 诊断钩子

在 `localhost` / `127.0.0.1` 上，插件会挂 `window.__intentViewDiagnostics`，
暴露服务与注册表：

```js
__intentViewDiagnostics.tabs().map(t => t.id)   // 注册表里到底有什么
__intentViewDiagnostics.intentProbe()           // 宿主算的 intent 投影读到了吗
__intentViewDiagnostics.serviceKeys()           // 服务上真实有哪些成员
```

**只在回环上挂**——它暴露服务对象本身，在别人的浏览器里是没必要的攻击面。
但它的价值已经证明过：`apply` 没被调用这个 bug 就是靠它定位的。

### 「意图」tab：任务结构树 + 语义核查

面板分两层：

| 层 | 回答的问题 | 内容 |
|---|---|---|
| **概况层** | 这段会话由哪些任务组成 | 任务结构树（多父节点标 `↩ 同 nX`、分叉点、没挂上任何节点的回合）+ 状态行（节点数 / 几条线 / 几次调用 / 补问与承接继承的账）+ 语义核查状态行 |
| **详情层** | 这个任务里发生了什么 | 该节点收的逐回合：回合号、用户原文、（抽得到时）agent 当时把任务理解成了什么，以及**逐回合的人工判定**（`✓` / `理解偏` / `越界` / 还原 · 另有一组 `父枝：近/远/不适用`）|

**结构从哪来**：宿主四段流水线（建结构 → 分批判归属 → 判整理 → 根裁定），
按 `会话 + 内容指纹` 缓存。判归属漏掉的回合先**补问一次**，补不到再用**承接继承**补齐
（实测 `d5b0e76c` 33/45 → 45/45、`58bc797f` 108/124 → 124/124：**承接继承是主力，
补问不可靠**）。它不在浏览器里算，也不读任何外部文件。

**它是增量的**：同一会话的新回合**接在已有结构上**，不整场重算——实测"前 30 回合全量
5 次调用 → 扩到 45 回合只花 2 次"，且已有 13 个节点的 id / 标题 / 父子关系**逐字未变**
（这也保证你手动改的落点不会被下一次刷新冲掉）。前缀被改写（压缩）或换会话时**回退全量**
（`research/structure-incremental-2026-10-10.md`）。

**人工调整**：落点错了由人改（选中回合改落点、节点改名/合并），改动存在浏览器侧
（localStorage，按会话键控），刷新不丢——而不是再写一条判据去猜。

**语义核查是提示，不是判据**：判的是 **agent 有没有偏离用户交办的事**——
材料是"用户这一回合发布的指令 + agent 当时的理解"，外加任务节点上下文。
判哪三类回合：**简报回合**（用户只说"同意"/"继续吧"）、**新增节点的起点回合**（新任务在这里出现）、
**上下文压缩过的回合**（历史被截断之后最容易做偏）——使用者裁定，理由是"中间过程是比较难偏移的"。
实测一场 377 回合的会话：真材料被标 22–28%（同一材料重跑差 2 条）、把指令两两对调后 67%
（`research/semantic-compliance-2026-10-10.md`）。**模型给的理由读着合理，但它仍然只是提示**
——界面上的话是"不当位置用"。

**判定是增量的**：宿主有**逐回合**缓存（键 = 这一条的指令/理解 + 它自己那个节点的材料行），
所以材料里变了几条就只重判几条——实测 36 条里改 1 条 ⇒ `新判 1 条 · 复用 35 条`（3 次调用 / 8 秒，
而不是 12 次 / 31 秒）；没被选中的新回合连请求都不发。状态行会写出"新判 N 条 / 全部复用上次结论"，
**账是露出来的**（`research/semantic-incremental-2026-10-10.md`）。

**数据可用性实测（52 个会话）**：`turnOutline` 有 26 个会话有数据，`goal` **只有 2 个**
——所以目标是**可选锚点**，面板不能把它当必需节点。

**`onset` 从 `goal/change` 事件来**。这里曾写死 0 并注明"目标建立于第几轮不可观测"
——**那个结论是错的**：`roundsStarted` 确实不能当回合号（实测错 89 个回合），
但事件流里带着**真实回合号**，宿主 fold 了它（`goalTimeline`），"目标改过几次"
才有据可依。

## 用法

在主区顶部（与 Chat / Trajectory 同级）点「意图」。它订阅会话投影，**随回合实时更新**——
不需要手工生成任何文件。

**两层**：概况层是任务结构树（每个节点下直接列出它收的回合），点一个回合进详情层
（这个节点的逐回合）。详情层有「← 回到结构」。

**语义核查判三问**（第三问 2026-10-10 加的，与工作偏离**分开报**）：

| 问 | 判什么 | 取值 | 进不进"偏离"标记 |
|---|---|---|---|
| 一 | agent 把任务理解成的是不是用户要的 | 是/否 | 进 |
| 二 | 回复里动过的对象是否都在该节点对象之内 | 是/否 | 进 |
| **三** | 这一回合做的事与**父枝的目标**是否靠近 | 靠近 / 较远 / 不适用 | **不进**（面板上单独一档 `↔较远`） |

第三问的定位是**弱信号**：它判"挂得贴不贴"，不是"agent 做没做错"。读数是 12 条人工真值上
精确率 100% / 召回率 100%（`research/semantic-parent-proximity-2026-10-10.md`），但**顶层枝的
领域偏移仍会漏**，而且它**不驱动任何写操作**——要不要挪由你定。
顶层枝（父是根）的口径是**只判领域**：不拿会话大目标去卡具体操作。
详情层可以逐回合人工修正这一问（`父枝：近/远/不适用`），与两问的修正分开存、分开用。

**两层各自的编辑面**（刻意分开）：结构编辑（拖回合=移动 / 「复制到…」=多挂 / 拖枝条=合并 /
回收站 / 改名 / 拆分）只在**概况层**，要先开「编辑落点」；**详情层只有一种编辑——逐回合的
人工判定**（修正模型那条结论，人给的赢，随时「还原」）。判定是标注不是结构改动，
所以不需要先进编辑态：就在你读到那一段原文的地方点。反过来，**编辑栏里不放人工判定**
（那条栏只做结构：移动 / 多挂 / 清空落点 / 还原落点），免得同一件事分散在两处。

**删枝 = 删掉这个枝连同它下挂的整棵子树**（标准树语义），子树里所有回合随之变成
**独立回合**（出现在"没挂任何节点"那一行）。挂在删除范围之外、只是**顺带**挂在这一枝上的
节点不会被连坐——它外面还有父，只是摘掉被删的那个父（多父共享的情形）。
回收站在松手前就把后果写出来（"删除枝条 X 及下挂 N 个枝——其中 M 个回合变成独立回合"，
数字与实际执行共用同一份计算），并且可以一键撤销。

**人工调整**存在浏览器侧（localStorage，按会话键控），刷新不丢；
结构本身按 `会话 + 内容指纹` 在宿主侧缓存，"算过一次就不再花调用"。

**空态**：`intent` 投影缺失时面板会说明原因（新会话、或日志尚未加载），
而不是一片空白——冷启动时 `projectionValues` 确实是空的。

## 活面板验证到哪一层（B2 的结论，2026-10-10）

真浏览器里能自动验的与**验不了**的，分开写清楚——免得把"离线断言全绿"读成"界面一定对"：

| 层 | 怎么验 | 状态 |
|---|---|---|
| 插件真的注册 | `npm run e2e <url>`（CDP：模块加载缓存 + 零 console 错误 + 投影键） | ✅ |
| 宿主折叠 → 浏览器 | 同上（`intentProbe` 读投影样本：回合数/自述理解/压缩点/目标建立回合） | ✅ |
| 覆盖存储往返 | `npm run check:live:storage <url>`（调 `overrideRoundTrip`，**不需要打开面板**） | ✅ 写读一致、刷新后仍在、键按会话隔离 |
| **面板渲染与交互** | 离线：550 条断言打在 `renderToStaticMarkup` 的结果上 | ✅（静态） |
| **在真浏览器里点面板** | `npm run check:live:panel <url>`（先点会话行，再点「意图」tab） | ✅ |

**这一条现在是通的**（2026-10-14，侧栏那条路移除之前就通了）：主区视图与 Chat / Trajectory
同级，无头窗口里点得开。实测读数：

```
① 选会话: rows 8 · picked "信用与分配学术研究方向"
② tab 条: registered=true · tabs=["Chat","Trajectory","意图"] · panel=false
③ 点「意图」: clicked=true
④ 末态: panel=true · outline=true · editbar=true
✓ 主区视图渲染出来了（面板 DOM 在）
```

```bash
npm run e2e <url>                  # 注册 + 零错误 + 投影
npm run check:live:storage <url>   # 覆盖存储往返（刷新后仍在）
npm run check:live:panel <url>     # 真的点开主区「意图」视图
```

## 安全与隐私

### 面板本身不执行任何东西
只渲染自己算出来的文本与数字，**不注入 HTML、不执行脚本**。

### 会把什么发给模型（这条最重要）
这个插件有两条模型调用通路，都会把**会话正文**发出去，请按此评估：

| 通路 | 发出去的内容 | 截断 |
|---|---|---|
| 结构流水线（建结构/归属/整理/裁定） | 用户回合原文（`prompt`） | 每次调用只带那一窗/那批回合 |
| 语义核查（逐回合判定） | 用户指令 + agent 自述理解 + 回复摘要 + 该节点上下文 | 指令/摘要各 ≤400 字，节点上下文只带被判定回合引用到的节点 |

**不发**：工具调用参数、文件内容、附件。联系方式打码只做在**探针导出**的语料上（`tools/probes/session-turns.mjs`），
面板这条通路**不做打码**——发给模型的就是原文（截断后）。

### 存在哪儿

| 位置 | 内容 | 键/路径 |
|---|---|---|
| 浏览器 `localStorage` | 人工覆盖（结构）、人工判定、会话名覆盖、历史标题索引 | `dsh-intent-view:overrides:v1:<会话>`、`:verdicts:v1:<会话>`、`:session-title:v1:<会话>`、`:titles:v1:<会话>` |
| 宿主磁盘 | 逐回合判定缓存、结构缓存 | `~/.dsh/storages/intent-view/semantic-turns.json`、`structures.json` |
| 宿主内存 | 结构缓存（LRU）+ 会话级 memo | 进程退出即失 |

全部**本机**，不上传任何第三方；删掉这些文件/键就等于清空缓存与人工改动。

### 覆盖默认值（一行一个，按需设）

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `DSH_INTENT_STRUCTURE_CACHE` | `~/.dsh/storages/intent-view/structures.json` | 结构缓存文件位置 |
| `DSH_INTENT_STRUCTURE_NOCACHE` | 关 | 置 `1` ⇒ 结构缓存不读不写（排查用） |
| `DSH_INTENT_SEMANTIC_CACHE` | `~/.dsh/storages/intent-view/semantic-turns.json` | 逐回合判定缓存位置 |
| `DSH_INTENT_CONSOLIDATE_EVERY` | **0（关）** | 定期判整理：攒够 N 个新节点补一次整理。实测对健康结构是空操作（日志 8/8 次 `节点 X → X`），所以默认关；要开就设 6 |
| `DSH_INTENT_SEMANTIC_CONCURRENCY` | **3** | 语义判定的并发数（1 = 串行）。实测 83 条冷判定：**1 → 82 秒 · 3 → 29 秒 · 5 → 18 秒**，调用数与结论两臂完全一致（都是 21 次调用、83 条判完、0 条结论不同） |
| `DSH_INTENT_ADJUDICATE` | 开 | 定期根裁定（增量路上顶层线 ≥2 条时补跑一次）。置 `0` 关掉 |
| `DSH_INTENT_REMAP_BY_TITLE` | 开 | 读取时把"指向已消失节点"的落点按标题接回新 id（只对 `setPlacement`、标题唯一才接）。置 `0` 关掉，回到"只列失效" |

## 怎么验（发布后照跑）

```bash
npm run build                 # 全部离线：类型 + 打包自检 + 13 个断言脚本（共 550 条）
npm run check:judge           # 语义判据回归门：32 条人工真值样例（需要跑着的宿主 + token）
npm run check:judge:parent    # 第三问（归属贴近度）12 条人工真值
npm run check:override-matrix # 规则缺口矩阵：6 种 op × 5 条约束两两试
npm run e2e <url>             # 真浏览器：插件真的注册了 + 零 console 错误 + 投影到浏览器
npm run check:live:storage <url>  # 真浏览器：人工改动写读一致、刷新后仍在
npm run check:live:panel <url>    # 真浏览器：点开主区「意图」视图并确认面板 DOM 在
```

### 量「结构质量」之前先看这一条（血的教训）

**同材料、同前缀走法、两跑之间结构可以差 30%**（2026-10-14 实测：同一场 313 回合的会话，
末态 19 vs 13 个节点、4 vs 1 个单回合节点）。所以：

- 任何「某个开关/提示词让结构变好了」的结论，都必须**重复跑或配对设计**，单跑对照是噪声；
- 量之前先有**可观测口径**（面板现在有：节点数、顶层线数、碎片数 `data-intent-fragmentation`）；
- 完整实验与读数见 `research/adjudicate-ab-1013-1505.md`（含一次**否定性**结果：
  定期根裁定在「只有一条顶层线」的会话上是空开关——它要求顶层 ≥2）。

### 一个探针侧的坑（已修，写下来免得再踩）

`structure-via-host.mjs` 传**固定 `--hash`** 时，第二个前缀请求会直接回缓存
（`cached: true`、0.0 秒），增量根本不跑 ⇒ 读数是「旧结构覆盖 20/70」，很容易被误读成
「结构没长」。宿主原来命中缓存时**不比较请求带的回合数**；现在 `meta.turnsCovered` +
`canServeCached()` 把这条堵上了（请求更长就走增量），老缓存条目保持旧行为。

`build` 是唯一的硬门（退出码）。其余几条要真宿主或真浏览器，**分清楚哪条验到哪一层**
（见上面「活面板验证到哪一层」）。

**语料是中性化过的**：研究语料与断言 fixture 里的专有名词（站名、角色名、书名、项目名）
已统一替换成中性词（`示例站`／`角色甲`／`示例小说`／`个人资料`…），映射一致、语义不变。
换名之后**两个 judge 门重跑复验过**：

```
npm run check:judge          → 与人工真值一致 44/44 · 精确率 100% · 召回率 100%（TP 16 / FP 0 / FN 0）
                               第三问：一致 12/12 · far 精确率 100% · 召回率 100%（TP 5 / FP 0 / FN 0）
```

⇒ 之前"32 条 + 12 条人工真值 100%/100%"的读数在换名后**依然成立**。

## 已知限制（发布说明里必须带着）

1. **自动验证到"面板渲染出来"为止**：`npm run check:live:panel` 能在真浏览器里点开并确认
   面板 DOM 在，但**拖拽/撤销/选择器这些交互**只有离线断言与纯函数断言，没有活体操作验证
   （CDP 里模拟 pointer 拖拽这件事没做）；
2. **语义判据的验证全部来自合成样例**（真实会话标注代价过高）：前两问 32 条、第三问 12 条
   人工真值，都是"机制对不对"的证据，**不是真实分布上的指标**；
3. **第三问会漏、不误报**：顶层枝的领域偏移最容易漏，边界样例在两次运行间会翻面；
4. **结构"越理越好"这件事没做到**：判整理实测是空操作（默认已关），根裁定只管多条顶层线；
   碎片化（一堆只收 1 个回合的节点）仍未解——要解需要一个目标不同的整理，且有改写结构的风险；
5. **定期根裁定的效果没有真机读数**（只验了机制：该跑就跑、不重复跑）。

## 开发

```bash
npm install
npm run build        # tsc → 内联包装 → 客户端接线自检
npm run typecheck
```

### 构建的三步，以及为什么需要第二、三步

1. **`tsc`** 产出纯 ESM。
2. **`scripts/wrap-client.mjs`** 把它内联并包成 DSH 浏览器侧要求的模块格式：

   ```js
   window.__ModuleLoader__.load({ id: "dsh-intent-view", factory: (require) => {…} })
   ```

   **不做这一步会静默失败**：文件确实进了 bundle（连注释都在），但从未注册进
   `__ModuleLoader__`，`apply` 永远不被调用，面板不出现，**且没有任何报错**。
   实测：接进测试 profile 时 bundle 里 307 个 `id:`，没有我的；
   修正后 308 个，有了。

   内联而不是打包：浏览器侧 import 面只有 `react` 和两个同目录文件，为这点规模引入
   rollup/esbuild 不划算，而本项目至今零运行时依赖。

3. **`scripts/check-client.mjs`** 在 Node 里跑**真实产物**，用真实的
   `window.__ModuleLoader__` 假体与**真 react**，断言注册真的接上了（15 项）。

### 挂载外壳的 `component` 必须无 hook

这条契约最初来自第三方侧栏（描述符的 `component` 会被**直接调用**而不经
`createElement`），**规则本身与挂载点无关**：DSH 的视图组件同样可能被渲染器直接调用，
而"直接调用一个用了 hook 的组件"必然抛错。

第一版违反了这条：`component` 直接就是渲染组件，里面用了 `useRef`/`useState`/
`useEffect`/`useMemo`。被**直接调用**时 hook 没有宿主，返回 `undefined`，
React 报 **error #130（元素类型为 undefined）**。

修法是把注册指向一个无 hook 的外壳，状态全部下沉到主体：

```ts
export function makeConversationView(ctx) {           // 无 hook 外壳
  return function IntentConversationView(props) {     // 也无 hook
    return createElement(IntentTab, view)             // 主体：有 hook
  }
}
```

**这个 bug 逃过了前两层检查**：类型检查通过（`createElement` 类型正确）、
语法检查通过、模块也注册成功——因为**只有"直接调用"那条路径会走到它**。
所以检查里加了承重断言：直接调用外壳必须返回元素
（`scripts/client-harness.cjs` 的「组件直接调用返回元素」；
`scripts/verify-intent-tab.cjs` 的「主区视图外壳直接调用返回元素」）。

> 用**真 react** 而不是 stub 做这条检查，也是刻意的：stub 的 `createElement`
> 返回假对象，那条断言就永远为真——检查白做。

### 另一次教训：具名导入

`wrap-client.mjs` 曾把 `import { useRef } from 'react'` 转成命名空间绑定
（`let react = require('react')`），于是函数体里的 `useRef(...)` 成了未定义标识符。
同样是三层检查全绿，只有在 Node 里真跑一遍才暴露。

### 端到端（需要无头浏览器）

```bash
npm run e2e "http://127.0.0.1:3098/?token=<token>"
```

查 `__dshSidebarModuleSystem__.loadCache` 里有没有 `dsh-intent-view`，
并要求**零 console/page 错误**。（不挂钩子：`<link rel=modulepreload>` 让模块在
`domcontentloaded` 之前就注册完了，钩子挂不上。）

**本机可行的浏览器配置**（都是踩出来的，脚本里已固化）：

1. chromium 缺 8 个系统库（`libatk-1.0.so.0` 等）。从 flatpak 运行时**只复制缺失的
   那 8 个**到单独目录——整个 flatpak lib 目录会让 chromium core dump
2. **`--disable-dev-shm-usage` 必须有**：`/dev/shm` 无写权限，缺它直接 core dump。
   这才是最初"库不兼容"的真因
3. 要等约 20 秒再查缓存

实测输出：

```
模块系统: {"ok": true, "count": 48, "hasMine": true, "hasBetterSidebar": true}
错误数: 0
✓ 通过
```

### 在测试 profile 里验证

```bash
dsh plugin --profile webtest3098 add ./dsh-intent-view
dsh --profile webtest3098 --port 3098 --no-open
```

**不要用 3080**，那是日常 GUI。

## 许可证

MIT，见 `LICENSE`。

用这个插件请留意 README「安全与隐私」那一节：**它会把会话正文发给模型**
（两条通路：结构流水线、语义核查），面板这条通路不做打码；
所有缓存与人工改动都只存在本机（浏览器 localStorage + `~/.dsh/storages/intent-view/`）。
