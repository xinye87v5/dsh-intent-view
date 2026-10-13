#!/usr/bin/env node
/**
 * **流水线的唯一执行体**：分批把三段跑完（真实会话一次给不完）。
 *
 * ## 为什么要分批
 *
 * 合成语料只有 32 回合，一次就能输出完；真实会话 139 回合，
 * 一次让它回 119 个回合的归属，JSON 必然被截断（`max_tokens` 是硬闸）。
 * 所以按窗口滚动：
 *
 * ```
 * 第一段 BUILD(1..firstWindow)                     建基础结构
 * 之后每 chunk 个回合一次 ASSIGN(节点清单 + 这一段) 只判归属、不带 ops 词汇表
 * 每 consolidateEvery 段（以及最后）一次 CONSOLIDATE 只做节点层面的合并/改名
 * finalize：结构闸门（顶层恰好 1 个非插话）→ strip（只留最具体落点）
 * ```
 *
 * ## 为什么要 dependency injection
 *
 * `complete` 由调用方传进来，于是这段分批逻辑可以**离线**测
 * （`scripts/verify-task-dag-pipeline.cjs` 用一个假 completer 跑，
 * 断言各段调用次数、覆盖完整、闸门与 strip 都生效）——
 * 而"分批"正是真实会话最容易出错的地方。
 */
import {
  BUILD_PROMPT, ASSIGN_PROMPT, CONSOLIDATE_PROMPT, ADJUDICATE_PROMPT, SYS,
  fillPrompt, renderTurns, nodeList, renderRoots, applyAssign, applyConsolidate, applyAdjudication,
  finalize, rootSummary, carryForward, isContinuation,
} from './pipeline.mjs'

/** 把模型回复解析成对象；失败时报清是**哪一段、第几批**。 */
function parse(text, where) {
  try {
    return JSON.parse(text)
  } catch (error) {
    const preview = String(text).slice(0, 120).replace(/\s+/g, ' ')
    throw new Error(`${where} 的回复不是合法 JSON：${error.message}｜开头：${preview}`)
  }
}

/**
 * @param complete - `(system, user, options) => Promise<string>`
 * @returns 状态、各段调用次数、闸门与 strip 的账
 */
export async function runPipeline({
  turns,
  complete,
  firstWindow = 20,
  chunk = 12,
  consolidateEvery = 0,
  /** 根裁定最多问几轮（默认 1）；>1 时若上一轮并出了项目节点就再问一轮。 */
  adjudicationRounds = 1,
  maxTokens = { build: 2500, assign: 1600, consolidate: 1200 },
  log = () => {},
}) {
  if (typeof complete !== 'function') throw new Error('runPipeline 需要传 complete 函数')
  if (turns.length === 0) throw new Error('没有回合可跑')
  const calls = { build: 0, assign: 0, consolidate: 0, adjudicate: 0 }
  const unknownOps = []
  const droppedRefs = []

  const head = turns.slice(0, Math.min(firstWindow, turns.length))
  const built = parse(
    await complete(SYS, fillPrompt(BUILD_PROMPT, { turns: renderTurns(head) }), { json: true, maxTokens: maxTokens.build }),
    `建结构（第 1–${head.length} 回合）`,
  )
  calls.build += 1
  let state = { nodes: built.nodes ?? {}, membership: built.membership ?? {} }
  log(`建结构：${head.length} 回合 → ${Object.keys(state.nodes).length} 个节点`)

  const rest = turns.slice(head.length)
  for (let start = 0; start < rest.length; start += chunk) {
    const slice = rest.slice(start, start + chunk)
    const reply = parse(
      await complete(SYS, fillPrompt(ASSIGN_PROMPT, { nodes: nodeList(state.nodes), turns: renderTurns(slice) }), { json: true, maxTokens: maxTokens.assign }),
      `判归属（第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合）`,
    )
    calls.assign += 1
    const applied = applyAssign(state, reply)
    if (applied.dropped.length > 0) droppedRefs.push(...applied.dropped)
    state = { nodes: applied.nodes, membership: applied.membership }
    const done = start + slice.length
    const batchNo = start / chunk + 1
    const totalBatches = Math.ceil(rest.length / chunk)
    log(`判归属 ${batchNo}/${totalBatches}：第 ${slice[0].turn}–${slice[slice.length - 1].turn} 回合 · 节点 ${Object.keys(state.nodes).length}`)
    if (consolidateEvery > 0 && batchNo % consolidateEvery === 0 && done < rest.length) {
      const reply2 = parse(
        await complete(SYS, fillPrompt(CONSOLIDATE_PROMPT, { nodes: nodeList(state.nodes) }), { json: true, maxTokens: maxTokens.consolidate }),
        `判整理（第 ${batchNo} 批之后）`,
      )
      calls.consolidate += 1
      const out = applyConsolidate(state, reply2.ops)
      unknownOps.push(...out.unknown)
      state = { nodes: out.nodes, membership: out.membership }
      log(`判整理（第 ${batchNo} 批之后）：节点 ${Object.keys(state.nodes).length}`)
    }
  }

  const consolidated = parse(
    await complete(SYS, fillPrompt(CONSOLIDATE_PROMPT, { nodes: nodeList(state.nodes) }), { json: true, maxTokens: maxTokens.consolidate }),
    '判整理（收尾）',
  )
  calls.consolidate += 1
  const afterConsolidate = applyConsolidate(state, consolidated.ops)
  unknownOps.push(...afterConsolidate.unknown)
  // **根裁定**：只在顶层有 ≥2 个非插话节点时问；`adjudicationRounds>1` 时可递归再问
  // （但上一轮什么都没并就不再问，免得白花钱）。
  let adjudication = { asked: false, groups: [], applied: false, merged: [], rounds: [] }
  const rootsBefore = rootSummary({ nodes: afterConsolidate.nodes, membership: afterConsolidate.membership }, turns)
  let consolidatedNodes = afterConsolidate.nodes
  for (let round = 1; round <= Math.max(1, adjudicationRounds); round += 1) {
    const liveRoots = rootSummary({ nodes: consolidatedNodes, membership: afterConsolidate.membership }, turns)
    if (liveRoots.projects.length < 2) break
    if (round > 1 && !adjudication.applied) break
    const verdict = parse(
      await complete(SYS, fillPrompt(ADJUDICATE_PROMPT, {
        roots: renderRoots({ nodes: consolidatedNodes, membership: afterConsolidate.membership }, turns),
      }), { json: true, maxTokens: 400 }),
      `根裁定（第 ${round} 轮，${liveRoots.projects.length} 个顶层）`,
    )
    calls.adjudicate += 1
    adjudication.asked = true
    const appliedAdj = applyAdjudication({ nodes: consolidatedNodes, membership: afterConsolidate.membership }, verdict, liveRoots.projects)
    consolidatedNodes = appliedAdj.state.nodes
    adjudication.groups = (verdict.groups ?? []).map((g) => ({ name: String(g.name ?? ''), roots: (g.roots ?? []).length }))
    adjudication.applied = appliedAdj.applied
    adjudication.merged = appliedAdj.merged
    adjudication.rounds.push({
      round,
      roots: liveRoots.projects.length,
      groups: adjudication.groups,
      merged: appliedAdj.merged.map((m) => m.title),
    })
    log(`根裁定（第 ${round} 轮）：分成 ${adjudication.groups.length} 组` +
      (appliedAdj.applied ? ` → 建 ${appliedAdj.merged.length} 个项目节点（` + appliedAdj.merged.map((m) => `「${m.title}」${m.count} 条`).join('、') + '）' : '（没有需要合并的组）'))
  }

  // **覆盖**：真实会话里有 5–27% 的回合没有归属（五场实测）。
  // 分两类处理：实质内容补问一次；承接语（"继续/同意"）留给 carryForward 继承上一回合。
  let stateForCoverage = { nodes: consolidatedNodes, membership: afterConsolidate.membership }
  const missing = turns.filter((t) => (stateForCoverage.membership[String(t.turn)] ?? []).length === 0)
  const substantive = missing.filter((t) => !isContinuation(t.prompt))
  const coverage = { missing: missing.length, continuations: missing.length - substantive.length, reasked: 0, stillMissing: 0 }
  if (substantive.length > 0) {
    const reply = parse(
      await complete(SYS, fillPrompt(ASSIGN_PROMPT, { nodes: nodeList(stateForCoverage.nodes), turns: renderTurns(substantive) }), { json: true, maxTokens: maxTokens.assign }),
      `补问归属（${substantive.length} 个漏掉的回合）`,
    )
    calls.assign += 1
    coverage.reasked = substantive.length
    const applied = applyAssign(stateForCoverage, reply)
    if (applied.dropped.length > 0) droppedRefs.push(...applied.dropped)
    stateForCoverage = { nodes: applied.nodes, membership: applied.membership }
    log(`补问归属：${substantive.length} 个实质回合 → 补上 ${substantive.length - substantive.filter((t) => (stateForCoverage.membership[String(t.turn)] ?? []).length === 0).length} 个`)
  }
  const carried = carryForward(stateForCoverage, turns)
  stateForCoverage = carried.state
  coverage.inherited = carried.inherited.length
  coverage.inheritedContinuations = carried.inherited.filter((x) => x.continuation).length
  coverage.stillMissing = turns.filter((t) => (stateForCoverage.membership[String(t.turn)] ?? []).length === 0).length
  if (carried.inherited.length > 0) {
    log(`承接：${carried.inherited.length} 个回合继承上一回合的落点（其中 ${coverage.inheritedContinuations} 个是"继续/同意"这类话）`)
  }

  const folded = stateForCoverage.membership
  const finished = finalize({ nodes: stateForCoverage.nodes, membership: stateForCoverage.membership }, turns)
  let foldedAway = 0
  for (const [turn, ids] of Object.entries(folded)) {
    foldedAway += ids.length - (finished.state.membership[turn] ?? []).length
  }

  return {
    state: finished.state,
    /** 根的报告：几条线、各自从第几回合开始（分叉点）。**不做任何合并**。 */
    roots: finished.roots,
    adjudication,
    coverage,
    foldedAway,
    calls,
    unknownOps,
    droppedRefs,
    batches: Math.ceil(rest.length / chunk),
    /** 覆盖检查：哪些回合最后没有归属。 */
    uncovered: turns.filter((t) => (finished.state.membership[String(t.turn)] ?? []).length === 0).map((t) => t.turn),
  }
}
