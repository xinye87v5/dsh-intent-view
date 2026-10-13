/**
 * 压缩标记：哪些回合发生过上下文压缩。
 *
 * ## 数据从投影来，不从文件来
 *
 * 这里曾经有一整套"读 `~/.dsh/reports/compactions.json`"的逻辑：一个路径常量、
 * 一个 `loadCompactions()`、以及围绕它的分类函数。**整块是死的**——
 * 插件在浏览器沙箱里**没有可用的读文件通道**（`api.fsRead` 是 better-sidebar
 * 的私有内部对象，不在任何 ctx 服务上，也不在它的 exports 里；实测过三条路都走不通）。
 * 于是 `loadCompactions` 恒返回 `undefined`，后面的一切都走不到。
 *
 * **而数据本来就在手边**：宿主投影的 fold 从 `compaction/start` 事件收集了
 * `compactionTurns`（那个事件自带 `turn`），并且**已经随投影发出去**
 * （见 `host/intentProjection.ts` 的 `wire.view`）。这里只是读它。
 *
 * > **教训**：投影状态里已有的东西就该发出去。为了一个已经算好的字段
 * > 去另开一条数据通路，是让整块功能依赖一个不存在的通道。
 *
 * ## 为什么显示压缩回合：**当语境，不当判据**
 *
 * 有一条很顺的机制推断：压缩丢掉历史 → 之后回合与历史的字面重合下降 →
 * **不区分就会把压缩点报成话题转向**。
 *
 * **这条推断已被本项目实测否掉。** `tools/test-compaction-confound.py`：
 * 去重后 19 组，压缩前后的组内贴合度 `0.4243 → 0.4334`（**上升** 0.0091），
 * 而 80 组安慰剂 `0.5415 → 0.5167`（下降 0.0249）——**方向与推断相反**。
 *
 * ⇒ 所以这个模块**不做任何因果判定**。它只回答"哪几个回合压缩过"，
 * 由读者自己决定那和附近的转向有没有关系。界面上的措辞同样是这个口径：
 * 只说"压缩后 N 回合内"，**不**说"可能由窗口收缩造成"。
 *
 * > 顺带记一处更早的误引：`ctx-compression/docs/21` 说的窗口混淆是
 * > *"可观测机会变少"*，与本项目那个"字面重合下降"**同族但不是同一个量**。
 * > 见 `research/review-2026-09-23-by-ctx-compression.md` §1。
 */

/** 投影里 `intent` 键中和压缩有关的部分。 */
export interface IntentCompaction {
  /** 发生过压缩的回合号，升序。 */
  compactionTurns?: number[]
}

/**
 * 某个回合是不是压缩点。
 *
 * @param info - 投影里的 `intent` 载荷（或它的压缩子集）。
 * @param turn - 回合号。
 */
export function isCompactionTurn(info: IntentCompaction | undefined, turn: number): boolean {
  return info?.compactionTurns?.includes(turn) ?? false
}

/** 压缩点总数。 */
export function compactionCount(info: IntentCompaction | undefined): number {
  return info?.compactionTurns?.length ?? 0
}
