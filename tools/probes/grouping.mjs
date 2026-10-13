/**
 * 研究侧的**分组 / 转向语义**：冻结快照 + 活语义的转发。
 *
 * ## 这是什么
 *
 * 下面那一大段原本住在 `src/shared/intent.ts`，是插件的语义层。使用者裁定
 * 「话题组可以抛弃掉，只保留 DAG 路线」之后，产品侧已把它整块删除（提交 ④）。
 *
 * **为什么还留一份**：它是过去那些对照实验的**基线**——`research/group-vs-dag-2026-10-10.md`
 * 的"话题组 vs DAG 冲突规模"、`segment-quality` 的 WindowDiff/Pk、以及
 * "TS 与 Python 两个独立实现算出同一份分组"的交叉校验，全部由它算出。
 * 基线的意义就在于**不随产品变**，所以这里冻结成快照：**不再修改**，
 * 只做历史复现。要改产品的语义请改 `src/shared/`。
 *
 * ⚠️ 断言不再盯这份副本：`verify-shared.cjs` 反过来断言产品侧**没有**这些导出，
 * 唯一还依赖它的是 `tools/probes/grouping-crosscheck.mjs`（那份交叉校验）。
 *
 * ## 从 TypeScript 到 JavaScript 是**手工搬运**，所以有一条独立的守卫
 *
 * 这份快照是从 `src/shared/intent.ts` 逐函数抄下来的（去掉类型标注）。
 * 抄错一个阈值、抄漏 `MIN_GROUP` 的合并，都会让历史复现悄悄失真——
 * 所以 `grouping-crosscheck.mjs` 拿 **Python 参考值**（379 回合 → 35 组、
 * 区间逐字一致、转向 0 个）来钉住它。那条断言是这份文件的正确性证据。
 */

// 活的共享语义（`bigrams` / `snippet` / `goalStatement` / 阈值）从构建产物转发，
// 这样研究工具只 import 这一个文件就够，不必自己分辨哪一半是冻结的。
export * from '../../lib/shared/intent.js'

import { snippet } from '../../lib/shared/intent.js'

// ── ↓↓↓ 冻结快照开始（从 src/shared/intent.ts 原样搬出，仅去掉类型） ↓↓↓ ──

/**
 * 一个回合的话题有多大比例落在目标上。
 *
 * 除以**回合**规模而不是目标规模。目标在实践中被写成很长的状态报告
 * （实测有一份 1350 字，含"已完成 ①②…剩余 ③…"），除以目标规模会让每个回合
 * 都趋近 0——一个不区分任何东西的度量等于没有度量。
 */
export function reach(goalTerms, turnTerms) {
  if (turnTerms.size === 0) return 0
  let shared = 0
  for (const term of turnTerms) if (goalTerms.has(term)) shared += 1
  return shared / turnTerms.size
}

/**
 * 双向包含度的较小者。
 *
 * 只用一侧会让长组吞掉所有短回合：长组几乎覆盖短回合的全部内容，
 * 于是"连续"永远成立，分组退化成一个大组。
 */
export function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1
  return Math.min(shared / left.size, shared / right.size)
}

/** 组内贴合度：一个回合有多少内容能在**同组其他回合**里找到。 */
export function localFit(terms, others) {
  if (terms.size === 0) return 0
  let shared = 0
  for (const term of terms) if (others.has(term)) shared += 1
  return shared / terms.size
}

// ── 分组 ────────────────────────────────────────────────────────────────────

/**
 * 与当前话题组的连续性低于它就另起一组。
 *
 * **阈值是量出来的**（`research/intent-grouping.py`，8 会话 / 1116 回合）：
 *
 * | 阈值 | 组数 | 组大小中位 | 最大组 | 组内低重率 |
 * |---|---|---|---|---|
 * | 0.04 | 151 | 6 | 28 | 29.6% |
 * | **0.08** | **82** | **10** | **55** | **6.8%** |
 * | 0.12 | 54 | 12 | **95** | 2.8% |
 *
 * 0.08 之后收益递减而最大组在膨胀——**组太大时"组内其他回合"退化成模糊团**，
 * 后面那些更低的数字是假象。
 */
export const SPLIT_AT = 0.08

/** 一组最多多少个回合：防止高度自相似的会话合成一个巨型组。 */
export const MAX_GROUP = 40

/** 一组最少多少个回合：切得太碎会让组目标退化成单条 prompt。 */
export const MIN_GROUP = 3

/** 组内贴合度低于它就标为"不贴合"。 */
export const LOCAL_FLOOR = 0.12

/** 渲染端画条形用的阈值。与 `LOCAL_FLOOR` 同值；语义判定用后者。 */
export const REACH_FLOOR = LOCAL_FLOOR

/**
 * 把连续回合切成话题组。
 *
 * **为什么分组**：用一个固定的全局目标去量每个回合，实测 56–78% 被判"远离目标"。
 * 而根因是**目标本身在会话中途换过**（`ctx-compression/docs/08`：
 * "状态是连续量，转换点不是某个事件，而是跃变时刻"）。
 * 按话题切组、每组一个从内容派生的目标，实测低重率 56.2% → **6.6%**。
 *
 * @param terms - 逐回合的话题集合，顺序即回合顺序。
 * @param splitAt - 与当前组的连续性低于它就另起一组。
 * @returns 每组的下标列表，覆盖全部回合且按序不重叠。
 */
export function groupTurns(terms, splitAt = SPLIT_AT) {
  const groups = []
  let current = []
  let currentTerms = new Set()

  for (let index = 0; index < terms.length; index += 1) {
    const item = terms[index]
    if (current.length === 0) {
      current = [index]
      currentTerms = new Set(item)
      continue
    }
    if (overlap(currentTerms, item) < splitAt || current.length >= MAX_GROUP) {
      groups.push(current)
      current = [index]
      currentTerms = new Set(item)
    } else {
      current.push(index)
      for (const term of item) currentTerms.add(term)
    }
  }
  if (current.length > 0) groups.push(current)

  // 太小的组并进前一组：切得过碎会让组目标退化成单条 prompt。
  const merged = []
  for (const group of groups) {
    if (merged.length > 0 && group.length < MIN_GROUP) merged[merged.length - 1].push(...group)
    else merged.push(group)
  }
  return merged
}

/**
 * 组内最"中心"的回合在 `group` 里的位置。
 *
 * 中心度 = 与组内其他回合的平均重合度。**取中心而不是取最长**：
 * 最长的那条往往是插入的长引用，不是这一段在做什么。
 */
export function groupObjectiveIndex(group, terms) {
  if (group.length <= 1) return group[0] ?? 0
  let best = group[0]
  let bestScore = -1
  for (const index of group) {
    let total = 0
    for (const other of group) {
      if (other !== index) total += overlap(terms[index], terms[other])
    }
    const score = total / (group.length - 1)
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  }
  return best
}

/** 派生一个组的目标：取组内最"中心"的那个回合的 prompt。 */
export function groupObjective(group, terms, prompts) {
  if (group.length === 0) return '（空组）'
  const index = groupObjectiveIndex(group, terms)
  return snippet(prompts[index], 100) || '（本轮无提问）'
}

// ── 话题转向 ────────────────────────────────────────────────────────────────

/**
 * 滑动窗大小（回合数）。**窗口 6 是量出来的**：窗口 2/3/4/6/8/12 对应的
 * "平均每会话变化点数"是 20.4 / 11.5 / 6.8 / **1.9** / 1.0 / 0.4——
 * 6 是拐点（斜率从 6.8 骤降到 1.9）。
 */
export const SHIFT_WINDOW = 6

/** 连续性降到局部中位数的这个比例以下，就认为存在转向。 */
export const SHIFT_DROP = 0.5

/** 低于这么多回合不做转向检测：样本不足以建立局部基线。 */
export const SHIFT_MIN_TURNS = 24

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function unionOf(sets) {
  const out = new Set()
  for (const item of sets) for (const term of item) out.add(term)
  return out
}

/**
 * 找出话题转向点：连续量上的**变化点**，不是逐回合判定。
 *
 * **为什么不用逐回合判定**：第一版给每个回合打布尔标记，实测 239 个长 prompt 里
 * **78.5% 被判"偏离"**——一个标了 78.5% 的标记没有信息量。
 *
 * **为什么单回合比较必然不稳**：`ctx-compression/docs/20` 实测 147 组问题里
 * "只有 4% 能切开""93% 的回答是单块"。滑动窗 vs 滑动窗则稳得多。
 *
 * `turnsAfterCompaction` 的 `0` 含义：**最近压缩点不早于这一回合**（含恰好同回合），
 * 或没有压缩记录——不是"在压缩点之前"。
 */
export function findTopicShifts(turnTerms, compactionTurns = []) {
  if (turnTerms.length < SHIFT_MIN_TURNS) return []

  const series = []
  for (let i = SHIFT_WINDOW; i + SHIFT_WINDOW <= turnTerms.length; i += 1) {
    const left = unionOf(turnTerms.slice(i - SHIFT_WINDOW, i))
    const right = unionOf(turnTerms.slice(i, i + SHIFT_WINDOW))
    series.push({
      index: i,
      value: overlap(left, right),
      history: Math.min(left.size, right.size),
    })
  }
  if (series.length < 8) return []

  const threshold = median(series.map((point) => point.value)) * SHIFT_DROP
  const compactions = [...compactionTurns].sort((a, b) => a - b)

  return series
    .filter((point) => point.value < threshold)
    .map((point) => {
      let last = 0
      for (const value of compactions) {
        if (value <= point.index + 1) last = value
        else break
      }
      return {
        turn: point.index + 1,
        continuity: point.value,
        historySize: point.history,
        turnsAfterCompaction: last === 0 ? 0 : point.index + 1 - last,
      }
    })
}

/** 转向点的摘要文字，供界面直接显示。 */
export function describeShift(shift) {
  const base = `连续性 ${shift.continuity.toFixed(3)}`
  if (shift.turnsAfterCompaction === 0) return base
  return shift.turnsAfterCompaction <= SHIFT_WINDOW
    ? `${base} · 压缩后 ${shift.turnsAfterCompaction} 回合内（成因未证实）`
    : `${base} · 压缩后第 ${shift.turnsAfterCompaction} 回合`
}
