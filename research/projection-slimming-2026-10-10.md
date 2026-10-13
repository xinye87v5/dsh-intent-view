# 投影瘦身：话题组口径整块离开 wire（`stateVersion` 9）

> 目标第三步。前两步见 `group-vs-dag-2026-10-10.md`（① 判据换容器）、② 面板弃组
> （提交 `3c9e971` / `0f17401`）。这一步把**宿主投影**里已经没人读的字段删掉。

## 一句话

面板改成 DAG 结构树之后，投影里那套"话题组"口径（`groups` / `localFit` /
`promptSize` / `brief` / `lowFitCount` / `shifts`）**一个消费者都没有了**；
留给浏览器就是留一份"没人维护但看起来有值"的视图，所以整块删除，`stateVersion`
8 → 9。现在 wire 上只剩回合材料：`turn` / `prompt?` / `statement?` 与压缩、目标时间线。

## 走了哪些字段，为什么每个都能走

| 字段 | 语义 | 为什么可以删 |
| --- | --- | --- |
| `groups[]` | 话题组（划分）+ 派生目标 + 组内语料 | 划分表达不了**重叠归属**（一个回合同时推两件事）；面板与语义判定的容器都已换成 DAG 节点（①②） |
| `localFit` | 逐回合的组内贴合度 | 依赖"组"这个容器；界面上的贴合度条已随 ② 撤掉 |
| `promptSize` / `brief` | 承接/指令型回合的判据 | 只有旧的组口径界面在用。**没有在浏览器里重算**——阈值与二元组都在 `shared/intent.ts`，再写一份就是"同一语义两处实现"。宿主侧仍然现算 `bigrams(prompt).size`，那一条只用来决定**要不要抽 `statement`** |
| `lowFitCount` | 组内低贴合计数 | 同上，且 ② 已把"低贴合"那行字撤掉 |
| `shifts[]` | 话题转向点 | 词面转向判据随组口径一起下线（② 已撤显示） |

留在 wire 上的只有三样：`turn`、`prompt?`（宿主折叠的原文，结构流水线的材料）、
`statement?`（简报回合那句 agent 理解，语义核查的材料）。

## 两个被断言抓住的问题

### 1. 语义判定的缓存键漏了"归属"

`contentHash` 覆盖的是**会话内容**（逐回合原文 + agent 理解），而语义判定现在判的是
**节点**：同一个 `contentHash` 下结构重算一次，节点名与归属就可能变。第一版把
`contentHash` 直接当判定键 ⇒ 结构变了而键没变，**旧结论被贴到新结构上**。

于是新增客户端纯函数 `semanticKey(material)`（`IntentTab.ts`，已导出供断言），
按**送出去的材料**现算，复用共享原语 `semanticFingerprint`（宿主侧算 `contentHash`
用的也是它）。

写这个键时又踩了一次：第一版只把**文本**编进指纹，于是我写下的断言
「归属变了键就变」当场变红——把同一句话从节点 1 改挂到节点 2，键不变。
修法是把三样都编进去（回合号、所挂节点、那句理解），因为**三样都出现在提示词里**
（`shared/semantic.ts` 的 `semanticPrompt` 逐行写"回合号 | 节点 N | 理解"）。

> 教训：指纹要覆盖"会影响判定的**全部**输入"，而不是"看起来像内容的那些"。
> 这条断言是本步唯一"写的时候就预计会红"的一条——它确实红了。

### 2. 删字段也要升 `stateVersion`（老问题的新一次）

`stateVersion` 的日志里写着"加字段也算变"。**删**同样算：旧缓存行仍然带着那六个键，
而 `IntentView` 已经把它们删了——浏览器若还按老形状读，读到的是一份**没人再维护**的
视图（`undefined` 而不报错）。所以 8 → 9，并把这轮登记的注释写进 `stateVersion` 上方。

## 一个工具链陷阱（这一轮白查过一次）

`tsc -p tsconfig.json` **会写 `lib/`**，而 `lib/client.js` 是 `wrap-client.mjs`
产出的**包装后**客户端包。跑一次裸 `tsc -p` 就把它覆盖成未包装的 ESM，
断言脚本随后报：

```text
SyntaxError: Cannot use import statement outside a module
    at Object.<anonymous> (scripts/verify-intent-tab.cjs:13:1)
```

这个错误看起来像"包装脚本坏了"，实际是**我自己上一步把产物踩了**。
以后只跑 `npm run typecheck`（`--noEmit`）或 `npm run build`。

## 实测

- **离线**：`npm run build` 全绿——`verify-shared` 44、`verify-task-graph` 19、
  `verify-task-overrides` 15、`verify-override-storage` 12、`verify-task-pipeline-port` 19、
  `verify-task-structure` 11、`verify-task-tree` 8、`verify-intent-tab` **110 → 114**。
  新增的四条：语义键（同材料同键 / 节点名变则变 / 归属变则变 / 空材料空键）。
  另有三条改指向而不是放宽：`groups` 那两条改成"编辑基线不改**回合材料与指纹**"，
  `onset`/`turnsBeforeOnset` 那两条改成断言**它派生出的说明句**（字段本身没有消费者了）。
- **3098 实测**（`webtest3098`，重启后跑 `scripts/e2e-panel.mjs`）：
  模块加载 55 个、`hasMine: true`、**console/page 错误 0**；
  投影键含 `intent`，样本 `session-302cfe` 91 回合、`promptCount: 83`、
  `statementCount: 34`、`compactionTurns: [62]`——**新 wire 的 `prompt` 真的到了浏览器**。

## 这一步**没有**验的

1. **结构流水线换材料源之后的真模型复跑**：客户端送出的材料从"官方 `turnOutline`
   的短截断"换成了"宿主折叠的原文（400 字）"，我这次没再花调用去跑一遍
   `/api/intent.structure`（上一次跑通是 `task-structure-e2e-2026-10-10.md`）。
   离线断言覆盖的是"选哪一份文本、跳过空回合"，不是"模型拿到更长的原文会怎样"。
2. **浏览器里点树进详情的真交互**：离线断言覆盖到"多父节点按节点 id 也能进详情层"
   （`shared` 挂在两个父下），但没在真浏览器里点过。
