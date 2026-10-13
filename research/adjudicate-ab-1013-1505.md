# 定期根裁定的效果 A/B（1013-1505）

会话 `afd7a9b6` · 前缀走法 `20,70,120,170,220,270,313` · 走宿主真路（`structure-via-host.mjs`）。
两臂**只差** `DSH_INTENT_ADJUDICATE`；定期判整理在两边都是默认关（0）。

```
=== 臂 off（DSH_INTENT_ADJUDICATE=0）===
  实例: http://127.0.0.1:3098/?token=X3wOoQbF9llYck9-7MKFi7TUbSC7QPVuw7a7V_YJngk
  ── 前缀 20 回合
     耗时 2.9 秒
     meta: {"calls":3,"batches":0,"mode":"full","firstWindow":20,"chunk":12,"adjudication":"merged","inherited":0,"reasked":0,"elapsedMs":2902}
     节点 10 个 · 线 1 条（单线）
     覆盖 20/20 · 全覆盖
     多归属回合 0 个 · 多父节点 0 个
       ✓ 结构里有节点  (10)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 20/20）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 70 回合
     耗时 5.6 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":3,"reasked":0,"elapsedMs":5608}  ← 增量
     节点 19 个 · 线 1 条（单线）
     覆盖 70/70 · 全覆盖
     多归属回合 3 个（#23、#44、#69） · 多父节点 0 个
       ✓ 结构里有节点  (19)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 70/70）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 120 回合
     耗时 6.3 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":13,"reasked":0,"elapsedMs":6252}  ← 增量
     节点 33 个 · 线 1 条（单线）
     覆盖 120/120 · 全覆盖
     多归属回合 3 个（#23、#44、#69） · 多父节点 0 个
       ✓ 结构里有节点  (33)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 120/120）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 170 回合
     耗时 4.1 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":8,"reasked":0,"elapsedMs":4053}  ← 增量
     节点 33 个 · 线 1 条（单线）
     覆盖 170/170 · 全覆盖
     多归属回合 3 个（#23、#44、#69） · 多父节点 0 个
       ✓ 结构里有节点  (33)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 170/170）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 220 回合
     耗时 4.8 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":4,"reasked":0,"elapsedMs":4828}  ← 增量
     节点 33 个 · 线 1 条（单线）
     覆盖 220/220 · 全覆盖
     多归属回合 8 个（#23、#44、#69、#176、#210、#211、#214、#218） · 多父节点 0 个
       ✓ 结构里有节点  (33)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 220/220）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 270 回合
     耗时 6.0 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":3,"reasked":0,"elapsedMs":5973}  ← 增量
     节点 48 个 · 线 1 条（单线）
     覆盖 270/270 · 全覆盖
     多归属回合 8 个（#23、#44、#69、#176、#210、#211、#214、#218） · 多父节点 0 个
       ✓ 结构里有节点  (48)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 270/270）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 313 回合
     耗时 5.0 秒
     meta: {"calls":4,"batches":4,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":43,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":1,"reasked":0,"elapsedMs":4966}  ← 增量
     节点 49 个 · 线 1 条（单线）
     覆盖 313/313 · 全覆盖
     多归属回合 9 个（#23、#44、#69、#176、#210、#211、#214、#218、#287） · 多父节点 0 个
       ✓ 结构里有节点  (49)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 313/313）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
=== 臂 on（DSH_INTENT_ADJUDICATE=1）===
  实例: http://127.0.0.1:3098/?token=qNpz2Q8-aWhuCK0-_JuKJTyYX1tqns6q1ACpbIzX_3I
  ── 前缀 20 回合
     耗时 3.7 秒
     meta: {"calls":3,"batches":0,"mode":"full","firstWindow":20,"chunk":12,"adjudication":"merged","inherited":0,"reasked":0,"elapsedMs":3707}
     节点 10 个 · 线 1 条（单线）
     覆盖 20/20 · 全覆盖
     多归属回合 0 个 · 多父节点 0 个
       ✓ 结构里有节点  (10)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 20/20）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 70 回合
     耗时 5.5 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":2,"reasked":0,"elapsedMs":5467}  ← 增量
     节点 13 个 · 线 1 条（单线）
     覆盖 70/70 · 全覆盖
     多归属回合 3 个（#23、#50、#69） · 多父节点 0 个
       ✓ 结构里有节点  (13)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 70/70）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 120 回合
     耗时 5.0 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":10,"reasked":0,"elapsedMs":5002}  ← 增量
     节点 17 个 · 线 1 条（单线）
     覆盖 120/120 · 全覆盖
     多归属回合 3 个（#23、#50、#69） · 多父节点 0 个
       ✓ 结构里有节点  (17)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 120/120）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 170 回合
     耗时 4.8 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":3,"reasked":0,"elapsedMs":4756}  ← 增量
     节点 25 个 · 线 1 条（单线）
     覆盖 170/170 · 全覆盖
     多归属回合 3 个（#23、#50、#69） · 多父节点 0 个
       ✓ 结构里有节点  (25)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 170/170）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 220 回合
     耗时 5.0 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":11,"reasked":0,"elapsedMs":4978}  ← 增量
     节点 32 个 · 线 1 条（单线）
     覆盖 220/220 · 全覆盖
     多归属回合 4 个（#23、#50、#69、#211） · 多父节点 0 个
       ✓ 结构里有节点  (32)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 220/220）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 270 回合
     耗时 5.5 秒
     meta: {"calls":5,"batches":5,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":50,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":7,"reasked":0,"elapsedMs":5486}  ← 增量
     节点 35 个 · 线 1 条（单线）
     覆盖 270/270 · 全覆盖
     多归属回合 4 个（#23、#50、#69、#211） · 多父节点 0 个
       ✓ 结构里有节点  (35)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 270/270）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
  ── 前缀 313 回合
     耗时 4.4 秒
     meta: {"calls":4,"batches":4,"mode":"incremental","consolidated":false,"adjudicated":false,"adjudicateGroups":0,"nodesAtConsolidate":10,"consolidateOps":0,"consolidateApplied":0,"consolidateRejected":0,"chunk":12,"addedTurns":43,"ignoredPlacements":0,"collidedNodes":0,"firstWindow":0,"adjudication":"merged","inherited":2,"reasked":0,"elapsedMs":4426}  ← 增量
     节点 38 个 · 线 1 条（单线）
     覆盖 313/313 · 全覆盖
     多归属回合 4 个（#23、#50、#69、#211） · 多父节点 0 个
       ✓ 结构里有节点  (38)
       ✓ 有根（线）  (1)
       ✓ 覆盖 ≥ 90%（实测 313/313）
       ✓ 每个节点都有标题
       ✓ 归属里的节点 id 都存在
```

## 两臂曲线（从落盘响应算）

### 臂 A：裁定关（`DSH_INTENT_ADJUDICATE=0`）
| 前缀 | 节点 | 顶层线 | 单回合节点 | 模式 | 本次补裁定 | 调用 | 墙钟(s) |
|---|---|---|---|---|---|---|---|
| 120 | 33 | 1 | 16 | incremental | 否 | 5 | 6.3 |
| 170 | 33 | 1 | 13 | incremental | 否 | 5 | 4.1 |
| 20 | 10 | 1 | 4 | full | — | 3 | 2.9 |
| 220 | 33 | 1 | 10 | incremental | 否 | 5 | 4.8 |
| 270 | 48 | 1 | 12 | incremental | 否 | 5 | 6.0 |
| 313 | 49 | 1 | 10 | incremental | 否 | 4 | 5.0 |
| 70 | 19 | 1 | 4 | incremental | 否 | 5 | 5.6 |

### 臂 B：裁定开（`DSH_INTENT_ADJUDICATE=1`）
| 前缀 | 节点 | 顶层线 | 单回合节点 | 模式 | 本次补裁定 | 调用 | 墙钟(s) |
|---|---|---|---|---|---|---|---|
| 120 | 17 | 1 | 2 | incremental | 否 | 5 | 5.0 |
| 170 | 25 | 1 | 6 | incremental | 否 | 5 | 4.8 |
| 20 | 10 | 1 | 4 | full | — | 3 | 3.7 |
| 220 | 32 | 1 | 11 | incremental | 否 | 5 | 5.0 |
| 270 | 35 | 1 | 11 | incremental | 否 | 5 | 5.5 |
| 313 | 38 | 1 | 9 | incremental | 否 | 4 | 4.4 |
| 70 | 13 | 1 | 1 | incremental | 否 | 5 | 5.5 |

## 末态对照（最后一个前缀）

- 顶层线：关 **1** → 开 **1**
- 节点数：关 **19** → 开 **13**
- 单回合节点：关 **4** → 开 **1**
- 累计墙钟：关 **35s** → 开 **34s**

## 结论与边界（如实）

**这场 A/B 没有测到"根裁定的效果"——因为这条路上它一次都没开火。**

两臂的每个增量步 `本次补裁定` 都是**否**：`定期根裁定` 的触发条件是"顶层非插话节点 ≥2 条"
（`taskStructureUnit.ts`），而这场会话在前 20 回合的全量那一步就被**全量的第 ④ 段**归并成
**1 条线**（`adjudication: "merged"`），此后一路都是单线 ⇒ 增量的定期裁定**没有理由触发**。
`DSH_INTENT_ADJUDICATE` 在"只有一条顶层线"的会话上是**空开关**。

于是下表里两臂的差异**不是裁定的效果，是两次独立跑的结构方差**：

| 前缀 | 节点（关/开） | 单回合节点（关/开） |
|---|---|---|
| 70 | 19 / 13 | 4 / 1 |
| 120 | 33 / 17 | 16 / 2 |
| 170 | 33 / 25 | 13 / 6 |
| 220 | 33 / 32 | 10 / 11 |
| 270 | 48 / 35 | 12 / 11 |
| 313 | 49 / 38 | 10 / 9 |

同样的材料、同样的前缀走法、两臂**都没跑裁定**，末态却是 19 vs 13 个节点、
4 vs 1 个单回合节点 ⇒ **结构在两次独立跑之间的方差很大**（这一条比"裁定的效果"更值钱：
它说明以后任何"结构质量对照"都必须重复多次或做配对设计，否则读数是噪声）。
（与之前"同臂两次 21↔43"的观察一致。）

**它到底有没有用？真实世界的读数（今天 3080 的 journal）**：

- 13:05:37 `定期根裁定：2 条顶层线 → 分成 2 组 · 模型认为该各自成组`（**没改**）
- 14:44:03 同上（**没改**）
- 13:50:07 `定期根裁定：7 条顶层线 → 分成 7 组 · 建 1 个项目节点`（改了 1 处）

⇒ 机制真的会开火（今天 3 次），但**最常见的结论是"该各自成组"**（不改结构）。
要量它的净效果，得挑"确实长出多条顶层线"的会话，或者造一份会分叉的材料，并**重复跑**。

## 一个探针侧的坑（顺手记下）

`--hash` 固定时，第二个前缀请求会**直接回缓存**（`cached: true`、0.0 秒），
**增量根本不会跑**：宿主缓存命中那条路不比较"请求带的回合数"
（`src/host/taskStructureUnit.ts` 的命中分支）。面板不受影响，因为它每次送的是
**随内容变化的内容指纹**。但这意味着：
"同一个指纹 + 更多回合"会拿到**旧结构**——真实使用里若指纹恰好没变
（投影的 `contentHash` 只覆盖一部分内容时），面板会显示旧结构而在日志里看不出异常。
**待办**：命中时比较"缓存覆盖的回合数 vs 请求的回合数"，请求更长就走增量。
