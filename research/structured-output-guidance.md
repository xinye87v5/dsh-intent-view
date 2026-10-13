# 让模型稳定输出"结构"的成熟做法（调研）

起因：我在**手工试错**——一遍遍改提示词、加 schema 字段，每次只跑一次。
使用者问："你应该先调研一下如何让模型更好的表述这类形状？" 下面是查到的两条硬结论。

---

## 一、**结构失败与语义失败是两条轴，得分开治**（这是最要紧的一条）

[Constrained Decoding Eliminates Structural Failures in Small LLMs but Reveals
a Scale-Dependent Semantic Gap](https://arxiv.org/abs/2609.23742)（arXiv:2609.23742）
——5 个模型 × 14 个结构化输出任务 × 三种解码（native / Outlines / XGrammar）：

> **约束解码把结构性失败全部消除**（schema 有效率 **78.6–92.9% → 100%**），
> 但**内容准确性上仍有一道与模型规模相关的语义鸿沟**：
> **type coercion 类失败可以被约束解码救回，而 instruction-semantic 类失败
> （例如多步函数调用）对约束解码免疫。**
>
> *"Schema conformance is necessary but not sufficient for semantic correctness;
> CD's reach ends exactly where schema conformance ends."*

他们还提出**两轴评测**：`structural correctness`（schema 合法）与
`semantic correctness`（内容正确）**分开量**。

### 对照我这一路踩的坑

| 我的失败 | 属于哪条轴 | 该怎么治 |
|---|---|---|
| `"nodes":[n6]` 裸标识符 | **结构** | 约束解码 / 更严的格式（**不该靠改提示词**） |
| ` ```json ` 围栏、前后夹话 | **结构** | 同上 |
| 输出被 `maxTokens` 截断 | **结构** | 预算 / 分批 |
| 两个 sudo 兄弟没合并 | **语义** | 约束解码**救不了**——要改任务分解 |
| 给"评价句"挂节点 | **语义** | 同上 |
| 根给 8 个（要 3 个） | **语义** | 同上 |

⇒ **我把两条轴混在一起数了。** 解析失败与结构错都记成"不通过"，
于是分不清"是格式没管好"还是"语义没做对"——**这也是我前面几轮结论偏弱的原因之一。**

---

## 二、**用 patch（增量修改）而不是重新生成；而且别用数组下标**

[JSON Whisperer: Efficient JSON Editing with LLMs](https://arxiv.org/abs/2510.04717)
（arXiv:2510.04717，EMNLP 2025 industry）：

> 让模型生成 **RFC 6902 diff patch**（只写必要的修改）而不是整个文档：
> **token 少 31%**，编辑质量与"整份重新生成"**相差 5% 以内**，
> 在**复杂指令**与**列表操作**上还有优势。
>
> 他们指出 patch 编辑的两个难点：
> 1. **模型生成孤立 patch 时常常漏掉相关的更新**；
> 2. **数组操作要跟踪下标位移，而模型对下标处理很差**。
>
> 解法 **EASE（Explicitly Addressed Sequence Encoding）**：
> **把数组变成带稳定键的字典**，从而**消掉下标算术**。

### 对照我的 schema

- 我一直在做"增量"（`newNodes` / `memberships` / `reparent`）——**方向与文献一致**；
- 但我把 `membership` 写成**数组** `[{turn, nodes}]`、节点 id **数字与字符串混用**——
  **正是文献点名"模型处理很差"的那种形状**；
- 而 `"nodes":[n6]` 那个非法 JSON，本质就是**下标/标识符混用**的产物。

---

## 三、据此的改法（下一次动手时照这个来）

**形状（按 EASE 的思路：一切用稳定字符串键，不用数组下标）**

```json
{
  "nodes": { "n_a": {"parents": ["root"], "title": "部署脚本排障", "kind": "task"} },
  "membership": { "t21": ["n_a", "n_aside"] },
  "ops": [
    {"op": "merge", "from": ["n_sudo1", "n_sudo2"], "into": "n_sudo", "title": "sudo 处理"}
  ]
}
```

- **id 一律字符串**（`n_a` / `t21`），**不出现数字 id、不出现位置数组**；
- **membership 是字典**（turn 键 → 节点列表），不是数组；
- **ops 是显式操作列表**：`merge` / `split` / `retitle` / `reparent` / `newNode`
  ——这样"合并两个兄弟"才有地方写（我上一版正是缺 `merge`）；
- **结构可自动校验**（id 解析、覆盖、父子关系），**语义另外量**。

**评测（两轴，分开报）**

| 轴 | 怎么量 | 能不能被约束解码救 |
|---|---|---|
| 结构 | schema 合法性 · id 是否解析得出 · 回合是否覆盖 | ✅ 能（但本 API 只支持 `json_object`，见下） |
| 语义 | 八条人工标记推出的五条规则 | ❌ 不能——只能改任务分解与重复次数 |

**本项目的现实约束**：DSH 里走的是 `ctx.llm.stream`（本机 `deepseek-official`），
**只支持 `response_format: {type:"json_object"}`，不是 Outlines/XGrammar 那样的
全 schema 约束**。所以"约束解码"这一支只能用**替代手段**顶上：

1. **把每次输出压小、压平**（一屏能看完、易校验），而不是一次要一整棵树；
2. **能推导的就别让模型写**（例如区间由 membership 现算——这一点已经做了）；
3. **校验失败要报清楚是哪条轴**，别混着数；
4. **每版跑 ≥3 次、比分布**（单例比较不算证据，这条我自己前面就栽过）。

---

## 四、这条调研改了我什么

1. **不再把"格式错"与"结构错"算成一件事**——之前 4 条标准里混着两种失败；
2. **不再靠提示词去修格式问题**（裸标识符、围栏、截断）——那是解码/形状的问题；
3. **schema 改成"稳定字符串键 + 显式 ops"**，而且 **`merge` 这类操作必须存在**，
   否则"该合并却拆成兄弟"这个错**在表达层面就修不了**；
4. **语义问题（合并/评价/根数）要靠任务分解**——
   "一次一小步 + 每步可校验"，而不是"一次给整棵树"。
