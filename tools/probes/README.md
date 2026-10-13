# 真机探针（`tools/probes/`）

这些脚本**不在 `npm run build` 的检查里**，因为它们要求一个**在跑的实例**，
而且其中几个**会真的调模型（花钱）**。它们撑着 `research/reasoning-phases.md`
与 `research/semantic-space.md` 里那些数字——**那几个数字原先只有 /tmp 里的一份**，
`/tmp` 一清就不可复现，所以搬进仓库并把路径改成从脚本位置推。

## 前提

| 需要什么 | 说明 |
|---|---|
| **一个在跑的测试实例** | 默认按 `http://127.0.0.1:3098/?token=…` 传参。**别对着 3080 跑**——这些探针会往那个进程发模型调用 |
| **`DSH_INTENT_SEMANTIC_NOCACHE=1`** | 量"同一份内容重跑会不会改口"**必须**绕过宿主缓存，否则第二次起拿到的是上一次的结论，永远是 100% 一致。用环境变量而不是请求字段，因为请求字段在生产里可能被误发，而这个**要花钱** |
| **Python + playwright** | 只有 `stability.py` / `discriminate.py` / `anchors.py` / `log-inspect.py` 需要（浏览器用来带上网关的鉴权头）。Node 侧那几个不需要 |
| **chromium 的共享库** | `scripts/e2e-panel.mjs` 会自己找；这几个 Python 探针用 `LD_LIBRARY_PATH=/tmp/chlibs`，见该文件的 `libDir()` |
| **`lib/` 已构建** | Node 探针要 `import ../../lib/shared/intent.js`：先跑一次 `npm run build` |

## 谁做什么、产出过什么数

| 脚本 | 作用 | 产出（写进了哪一节） |
|---|---|---|
| `pick.mjs` | **不花模型钱**。挑一个会话（默认**日志最后写入时间最早**的那个 = 最近不活跃），按插件同一套函数离线构建判定材料，同时产出一份**打乱配对**的副本 | 材料喂给下面两个；"最近不活跃"这个选法是使用者指定的 |
| `stability.py` | 同一份材料连问 N 次（默认 5），量**逐条翻面率**与逐轮聚合 | 单票 **18%** 翻面；多票后 **0/47** |
| `discriminate.py` | 真配对 vs 打乱配对，量**区分力**（基线差） | 一句话目标 70% vs 84%（差 14）；整组语料 57% vs 84%（差 26）；仅全票 57% vs 93%（差 36） |
| `log-inspect.py` | 摊开一个会话日志：事件类型分布、`assistant/message` 的**思考块**、`tool/call` 的名字与参数 | "思考与工具调用在不在事件流里"那一节的全部数字 |
| `quote.mjs` | 看**英文思考里夹的中文**到底是什么（抽样打印上下文） | "那 28% 是引用不是语义"的证据 |
| `continuation.mjs` | 数抽出的目标句里有多少含**显式承接语**（building on / 接着 / 之前…） | "承接"这条度量为何失败的旁证 |
| `anchors.py` | 统计每个会话有多少**外部锚点**（`goal/change`、`session/title` 重算） | 论证"外部锚点检验功效不足"（n 太小） |

`pick.mjs` 的输出落在 `tools/probes/.out/`（已 gitignore，可再生）。

## 用法

```bash
# 1) 起一个测试实例，带着缓存旁路
DSH_INTENT_SEMANTIC_NOCACHE=1 dsh --profile webtest3098 --port 3098 --no-open

# 2) 构建材料（不花钱）
node tools/probes/pick.mjs

# 3) 量稳定性 / 区分力（花钱：每次 3 票 × 批数）
python3 tools/probes/stability.py "http://127.0.0.1:3098/?token=…" 5
python3 tools/probes/discriminate.py "http://127.0.0.1:3098/?token=…" 3

# 4) 量完把实例**恢复**（不带旁路重启），免得以后每次开面板都真花钱
```

## 为什么要花这个钱去量

一句话：**这条功能的价值全在"它读不读内容"与"它指不指得出位置"两件事上**，
而这两件事都不能靠读代码判断。已经因此改过三次产品形态：

1. 单票 → **多票**（因为量到 18% 翻面）；
2. "偏离"当判据 → **降级为提示**（因为 0% 翻面也不等于对）；
3. 逐条标记 → **撤掉，只留整会话一句**（因为真配对基线 57%，它指不出位置）。

三次都是**先量后改**，而三次的结论都与改之前的直觉不同。

## 任务结构那一条线（按调研重做 schema 的那轮）

| 脚本 | 它回答的问题 |
|---|---|
| `task-dag.mjs` / `task-tree.mjs` | 最早的两版（一次出整棵树/图） |
| `task-dag-incremental.mjs` | 增量版（第一趟建结构、第二趟只给新增回合） |
| `task-dag-v2.mjs` | 按调研改形状：**字典键 + 显式 ops（含 merge）**，两轴分开量 |
| `task-dag-perturn.mjs` | 每回合单独问（任务分解）——**会永久损失合并能力** |
| `task-dag-split.mjs` | 把"归属"与"合并"拆成两问；结论见下 |
| `task-dag-arms.mjs` | **三臂配对**：例子取自本语料 / 语料外 / 无例子，检验"是不是教出来的" |
| `pipeline.mjs` | **冻结的三段提示词 + 纯函数**——这条线唯一的措辞来源 |
| `render-pipeline-doc.mjs` | 由 `pipeline.mjs` 生成 `research/task-dag-pipeline.md`（被 import 时无副作用） |
| `label-sheet.mjs` | 跑一次冻死水线，生成给使用者标记的 `research/dag-label-sheet-<日期>.md` |

**跑法**：`--runs 3` 时**第一趟也要每次重跑**（默认如此）。
`--reuse-base` 只用来隔离 A/B 两问的稳定性——我第一版默认复用过，拿到一个假性 3/3。

**结论写在 `research/structured-output-attempt.md`**，一句话：
结构轴被"稳定字符串键 + 字典"彻底解决；合并必须单独一问（`merge`）；
复合回合的多归属**能稳定拿到（3/3）**，但一句"闲聊不算推进"就会把它压到 1/3；
父子双命中连 v1 原话都复现不出（0/4），而使用者只要求"允许"，故**不计为错**。

## 冻结那件事怎么用（以及我自己踩过的坑）

`pipeline.mjs` 是这条线**唯一**的措辞来源；`research/task-dag-pipeline.md` 由
`render-pipeline-doc.mjs` 生成，`scripts/verify-task-dag-pipeline.cjs` 离线校验两者一致。

⚠️ 固化时我把 `ASSIGN` 里"闲聊"那句从**同句**拆成了两个 bullet，
结果同一份语料 `#21` 从两处落点掉回一处——**冻结动作本身引入了漂移**。
现在 lint 里有一条专门盯着它（关于闲聊的 bullet 只能有一条，且必须自带"不算推进"那半句）。

## 存储形态（2026-10-09 定案）

三段跑完后 `membership` 过一遍 `mostSpecific()`：**只留最具体落点**。
中间层路径由节点的 `parents` 提供，显示时用 `closeUnderAncestors()` 展开
（两种取法逐节点等价）。这样三次运行之间的"层级风格方差"从数据里消失，
`单链多落点` 恒为 0，剩下的多归属只有**异支**（真·两件事）。
定案依据：`research/closure-explained.md`、`research/fairytale-verdict-2026-10-09.md`。
