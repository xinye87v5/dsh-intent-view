# 归档话题组路线：产品侧删掉分组与转向，研究侧冻结副本

> 目标第四步（前一步见 `projection-slimming-2026-10-10.md`）。
> 使用者裁定：「话题组可以抛弃掉，只保留 DAG 路线」。

## 一句话

判据的容器换成 DAG 节点（①）、面板撤掉组口径显示（②）、投影不再发组口径字段（③）
之后，分组/转向那套纯函数在**产品里一个消费者都没有了**。这一步把它整块删除，
并在研究侧留一份**冻结副本 + 交叉校验**，让过去的对照实验仍可复跑。

## 删了什么

| 位置 | 内容 |
| --- | --- |
| `src/shared/intent.ts` | `reach` / `overlap` / `localFit` / `groupTurns` / `groupObjectiveIndex` / `groupObjective` / `findTopicShifts` / `describeShift` / `median` / `unionOf`，以及常量 `SPLIT_AT` / `MAX_GROUP` / `MIN_GROUP` / `LOCAL_FLOOR` / `REACH_FLOOR` / `SHIFT_WINDOW` / `SHIFT_DROP` / `SHIFT_MIN_TURNS` / `TopicShift` |
| `src/client/shifts.ts` | 整个文件。**它其实一直没有消费者**——`verify-intent-tab` 里那个 `describeShift` 导出检查命中的是 `shared/intent.ts` 的同名函数（包装器把被内联模块的导出一并绑定），所以那个文件是死代码，这次一并删掉 |
| `scripts/segment-quality.mjs` | 整块（含 `package.json` 的 build 步骤与 `check:segments`）。它量的是**分组算法**的 WindowDiff/Pk——那条路线已经不走了，留着就是给一个不存在的算法守门 |
| `scripts/verify-shared.cjs` | 6 条组口径断言（fixture 回合数 / 分组数 / 区间逐字一致 / 转向数 / 覆盖不重叠 / overlap 对称）+ 4 条转向距离断言 |

留在 `shared/intent.ts` 的只有三样，都有活的消费者：`bigrams`（宿主 fold 判"承接/指令"）、
`goalStatement`（抽 agent 的理解）、`snippet`（界面摘要）；外加 `BRIEF_PROMPT` /
`STATEMENT_LIMIT` / `SAMPLE` 三个阈值。**44 → 36 条**断言，另外**新增两条守卫**：

1. 「产品侧不再导出分组/转向的语义」——17 个名字逐个断言 `undefined`。
   删掉的东西悄悄回来（复制粘贴、或"顺手再写一个"）同样是语义变成两处的开始；
2. 「留下的几个还在」——`bigrams` / `snippet` / `goalStatement` / `BRIEF_PROMPT === 12`。
   防止"删干净"删过头。

## 为什么可以删（依据不是"我觉得"）

- **判据换容器**已经在 ① 做过并复验（`group-vs-dag-2026-10-10.md`：真配对 42% / 乱配对 92% 量级守住）；
- **面板无依赖**：② 撤掉贴合度条、低贴合计数、转向区，回退视图改成按会话顺序列回合；
- **投影无依赖**：③ 把 `groups` / `localFit` / `promptSize` / `brief` / `lowFitCount` / `shifts`
  从 wire 上删掉并升 `stateVersion` 到 9；
- **无其他调用点**：`grep` 之后剩下的全是注释里的历史叙述（已逐处标注为历史或改指向）。

## 研究侧：冻结副本 + 交叉校验（历史结论仍可复跑）

`tools/probes/grouping.mjs` 是那套语义的**冻结快照**（手工从 TS 抄成 JS，去掉类型），
头部写明"不再修改，只做历史复现"。所有研究工具（`group-vs-dag` / `agenda-segmentation` /
`meeting-anchors` / `pick` / `test-early-reasoning-signal` / `test-language-mixing` /
`test-verdict-stability` / `test-goal-statement-signal` / `test-llm-intent-matching` /
`test-semantic-space` / `measure-reasoning-phases`，共 11 个）改为从它取数；
它还转发还活着的 `bigrams` / `snippet` / `goalStatement`，所以研究工具只需一个 import。

**手工搬运最容易悄悄失真**（抄错阈值、漏掉 `MIN_GROUP` 的合并，历史就能复现出另一组数字），
所以有 `tools/probes/grouping-crosscheck.mjs`：拿 **Python 参考值**钉它——
fixture 379 回合 → **35 组**、区间逐字一致、转向 **0** 个，外加 4 条转向距离边界
（不传压缩点 = 0 / 之前 = 距离 / **恰好落在转向处 = 1** / 之后 = 0）与阈值锚。
**12/12 通过**。这份不在 `npm run build` 里：它测的是研究侧，不是产品。

顺带说明**没有** Python 可删：目标里提到的 `parse_intent.py` **不在本仓库**
（它在 `graph-view` 项目里，`git log --all -- '*parse_intent*'` 为空）。
本仓库里与它对应的只有 `research/fixture-f1cd07.json` 与那组参考值——它们没删，
被上面那份交叉校验接手了。

## 实测

- `npm run typecheck` 干净；`npm run build` 全绿：
  `verify-shared` **36**、`verify-task-graph` 19、`verify-task-overrides` 15、
  `verify-override-storage` 12、`verify-task-pipeline-port` 19、`verify-task-structure` 11、
  `verify-task-tree` 8、`verify-intent-tab` 114；
- `node tools/probes/grouping-crosscheck.mjs` → 12/12；
- 11 个研究工具的冻结模块指向**逐个断言过**（文件存在 + 引用了它）。

## 遗留（下一步，不在本次提交里）

**README 还是组口径的**：开头写着"话题分组、话题转向、组内贴合度"，文件地图与
"分段质量与它的反证""按语义分组，每组一个局部目标"等小节描述的功能已经不存在。
它是产品门面，该按 DAG 口径重写一遍——但那是**文档**而不是算法，所以单独一次提交，
免得把"删代码"和"改叙述"混在一个 diff 里看不清。
