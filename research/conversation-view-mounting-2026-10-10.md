# 挂载层调查：从右侧栏 tab 到主区对话视图（步骤 ①）

目标：判断"意图面板从 `dsh-better-sidebar` 的右侧栏 tab 扩到 DSH 主区的**对话视图**
（`conversation.view` slot）"是否可行、代价多大。**本文只记只读调查，不改代码**。

## 两套挂载机制（不是同一件事）

| | 现在用的 | 目标那套 |
|---|---|---|
| 服务 | `ctx.get('betterSidebar').registerTab(descriptor)` | `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id, order, label, children, inject }))` |
| 归属 | **第三方插件**（peer `dsh-better-sidebar >=0.18.1 <0.20.0`） | **DSH 自带**（`@deepseek-ai/dsh-client-ui-slots`，仓库里已在 `node_modules` 下） |
| 位置 | 右列 tab 条（Files / Changes / Tasks / Terminal / 意图…） | 主区对话页的视图 tab（**Chat / Trajectory 同级**） |
| 证据 | `src/client.ts` 的 `apply()`；探针 `panel-tab-open-check.mjs` 里 `tabs()` 的输出（⚠️ **该探针已随侧栏那条路一起删除**，2026-10-14——它读的 `service`/`tabs`/`serviceKeys` 诊断成员不再存在；当事人看现在是 `tools/probes/conversation-view-check.mjs`） | `dsh-client-ui-trajectory/lib/client.js` 第 8224 行起的注册；`dsh-client-ui-conversation/lib/types/client/contract/views.d.ts` |

## 主区视图这套契约（已读到的部分）

**它就是一个 tab**：`views.d.ts` 里 `interface ViewTab { id: string; label: string }`
——"projected from a 'conversation.view' slot entry's registration options
（label 缺省时回落到 entry id）"。也就是说注册进去就出现在对话页的 tab 条上。

**会话自己有"当前视图"状态**：`ConversationStoreState.view: string | null`
（"Preferred `conversation.view` entry id; **null resolves to Chat** when registered"）。
它还带 `viewRequest`（指向某个 view id 的一次性 focus 请求）——如果以后要"从对话跳到意图面板的某一行"，那是现成的入口。

**注册项的通用形状**（`dsh-client-ui-slots/lib/types/index.d.ts`）：

- `SlotKind = 'single' | 'list' | 'keyed' | 'chain'`
- `SlotScope = 'root' | 'session-maybe' | 'session'`
- `SlotEntryDef { …, inject?: object }`——"每个注册项通过注入面拿到自己那份 props"

**轨迹页的实战用法**（照抄它最稳）：

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'trajectory',
  order: 10,
  locale: NS,
  label: () => t('view.trajectory'),
  children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
  inject: (sessionId) => ({ /* 这个视图要的数据 */ }),
}))
```
另外它还用 `ctx.uiSession.provide({ hooks: ['trajectory'], resolve })` 挂了一个**会话钩子**
——我们**不需要**：面板读的是 `intent` 投影与 `sessions` 快照，没有自己的会话状态。

**这个 slot 的 props 很重**（`contract/slots.d.ts` 的 import 面）：会话快照、工作区快照、
composer（draft/附件/输入状态）、`store`、`locale`、`renderSlots`、`inject` 面……
我们只用得到其中的 **`sessionId`**（以及可选的 `t`）。⇒ 组件侧零风险，但**接线时要挑着取**。

## 还没读、下一步必须读清的（不许猜）

1. `dsh-client-ui-slots/lib/types/renderer.d.ts` 里 `register` 的**完整签名**（`component` /
   body 到底怎么给：轨迹页的 `inject` 只提供了数据，**视图的 React 组件挂在哪儿**我还没找到）；
2. `children` / `kind: 'single'` / `scope: 'session'` 的语义（我们要不要自己的子 slot）；
3. 插件的 `inject` 数组要不要加 `slots`（现在只声明了 `betterSidebar`）以及
   `uiSession` / `uiConversation` 是否必需；
4. 主区 tab 在**无头窗口**里能否被 CDP 打开（这决定 B2 那条限制能否划掉）。

## 为什么值得做（与"为什么保留侧栏"）

**值得**：① 宽度——树的缩进、`#12–18` 徽标、`↔N`、回合摘要、编辑栏选择器、诊断块都在挤，
而这套密度是为窄列调的；② **少一个第三方 peer 依赖**（发布净收益）；③ 很可能让
"真浏览器点不了面板"这条限制消失（Chat/Trajectory 启动就在 `[role=tab]` 里）。

**保留侧栏**：右侧栏能"边聊边瞄"，而主区要切走对话页。所以计划是**两条都留**，
组件主体 `IntentBody` 是挂载无关的（512 条断言全打在它上面），加一条挂载路径 ≈ 零组件改动。

## 步骤 ②～⑤（留档）

② 新增主区 view 薄壳 + 声明 `inject: ['slots']`，侧栏注册不动；
③ CDP 验"主区 tab 能否点开并渲染出 `data-intent-structure`"，成了就补活体点击探针、更新 README；
④ 宽屏版式最小调整（观感交用户看）；
⑤ 写"侧栏 tab 去留"的取舍文档交用户定。

## 步骤②③的实测结果（本轮补记）

- **契约最后一块**：`ctx.slots.register(entryDef, Component)` ——**第二个参数就是视图组件**
  （轨迹页 `}, TrajectoryView));`）。步骤①里"组件挂在哪"的疑问到此闭环。
- **软依赖做法**：`slots` 不写进 `inject` 数组、用 `ctx.get('slots')` 取，注册整体 try/catch
  软失败 ⇒ 缺这个服务的组合仍走侧栏，行为与之前一致。
- **`ctx` 从闭包拿**（不在 slot props 里找）：面板要 `ctx.get('sessions')`，而 slot props 很重。
- **活体读数**（3098 + CDP，先点会话行）：tab 条出现 `["Chat","Trajectory","意图"]`，
  点开后 `data-intent-structure` 与编辑栏都在 ⇒ **主区视图是可自动点开的**，
  而侧栏那条 `openTab` 空转 ⇒ README 里"真浏览器点不了面板"这条限制**已关闭**。
- 仍未做：④ 宽屏版式（现在这套密度是为窄列调的）、⑤ 侧栏 tab 去留的取舍文档。
