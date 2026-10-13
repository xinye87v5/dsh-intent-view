# 侧栏 tab 与主区视图：去留取舍（步骤 ⑤，交使用者定）

现在面板有**两条挂载路**，都在跑：

| | 主区对话视图 | 右侧栏 tab |
|---|---|---|
| 挂载 | `ctx.slots.register('conversation.view', …, Component)`（DSH 自带 slots） | `betterSidebar.registerTab(descriptor)`（第三方） |
| 位置 | 主区，与 **Chat / Trajectory 同级** | 右列 tab 条（Files / Changes / Tasks / … 旁边） |
| 宽度 | 宽（`layoutFor(true)`：限宽 1100、摘要 96 字、每节点 12 条） | 窄列（摘要 44 字、每节点 6 条） |
| 依赖 | 只用 DSH 自带服务（`slots` 还是**软依赖**：取不到就只少这一条路） | **peer 依赖** `dsh-better-sidebar >=0.18.1 <0.20.0` |
| 自动验证 | ✅ **可点开**（`npm run check:live:panel`：tab 条出现「意图」，点开 `data-intent-structure` 渲染） | ❌ 注册得到（`tabs()` 里有 `intent-view:intent`）但 `openTab` 空转，无头窗口打不开 |
| 用法 | 要**切走对话页**才能看（或自行分屏） | **边聊边瞄**：右侧栏与对话同屏 |

## 三条可选的收敛方式

**A. 两条都留（现状）**
- 好处：既能边聊边瞄（侧栏），又能在宽区细看/编辑（主区）；主区那条还撑着活体验证。
- 代价：两处维护（版式两档、两条注册路）、发布时多一个第三方 peer 依赖。

**B. 只留主区**
- 好处：**少一个第三方 peer 依赖**（对发布是净收益）、只维护一档版式、
  唯一那条路就是**可自动验证**的那条。
- 代价：丢掉"边聊边瞄"——看结构必须切走对话页（除非用户自己分屏）。
  另外 `dsh-better-sidebar` 那套 `single`/`dedupeKey` 语义带来的"每会话一个 tab"要确认主区也有
  （主区视图看起来是**每会话一个 view 选中态**，语义等价）。

**C. 只留侧栏**
- 好处：与对话同屏。
- 代价：**放弃唯一能自动验证的挂载路**，且发布仍带第三方依赖。**不建议。**

## 我的建议

**先按 A 跑一段，按使用习惯定 B/C。** 判据很具体：

1. 你实际用的时候，**更多是"边聊边瞄"还是"切过去细看"**？
   —— 前者留侧栏，后者可以直接 B；
2. 发布时**第三方 peer 依赖**你介意吗？（介意 ⇒ B 更省事，`betterSidebar` 那段代码可以整块删掉）

如果你要 B，我会做的事（可预估）：删 `betterSidebar` 注册与 `inject` 声明、删 `TabComponentProps`
那条 import、把 `IntentSurface` 的适配层收进 conversationView、README 的安装段去掉 peer 依赖说明、
把 e2e 探针里读侧栏 `tabs()` 那段改成读主区 tab 条；断言改指向。**约一两轮的量**。

## 现状读数（留档）

```
① 选会话 → ② tab 条: ["Chat","Trajectory","意图"] → ③ 点「意图」→ ④ panel=true · outline=true · editbar=true
```

`npm run check:live:panel <url>` 可复现；侧栏那条的"打不开"证据在
`tools/probes/panel-tab-open-check.mjs` 与 README「活面板验证到哪一层」。（⚠️ 2026-10-14 补记：侧栏那条路已移除，该探针随之删除；主区那条路的活体探针是 `tools/probes/conversation-view-check.mjs`，仍可用。）
