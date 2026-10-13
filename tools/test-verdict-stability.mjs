#!/usr/bin/env node
/**
 * 那条语义判定**稳不稳**——同一份内容问 5 次，看它改几次口。
 *
 * ## 为什么这条比"多快好省"重要
 *
 * 面板上会显示「**N 条理解的意图已偏离所在组**」。而实测同一会话同一内容，
 * 两次调用给出过不同的结论（一次"11/11 一致"，一次"1/11 偏离"）。
 *
 * 一个会飘的判定**比没有判定更糟**：用户会以为"意图变了"，
 * 而那只是采样噪声。所以在把它当判据用之前，必须先量**重测一致性**。
 *
 * ## 测什么
 *
 * - **逐条翻面率**：同一个回合的判定，在 N 次里出现过几种答案；
 * - **逐轮聚合**：每一轮报出的"偏离条数"（这才是界面上显示的数）；
 * - **多数票后还剩多少**：若 5 次里有 1 次说偏离、4 次说一致，多数票能消掉它；
 *   若长期五五开，这条判定就不能用。
 *
 * ## 这是**代理**，不是插件那条路
 *
 * 插件走宿主 `ctx.llm.stream`（provider `deepseek-official`）；这里直接打
 * DeepSeek 的 HTTP API。模型系列相同、温度相同（0），所以**关于稳定性的结论
 * 可以外推**，但**具体数字不等于插件那条路**。这一点必须写在结论里。
 *
 * 用法：`node tools/test-verdict-stability.mjs [会话数=2] [重复次数=5]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns } from './session-log.mjs'
import { complete, usage } from './llm-client.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))
const semantic = await import(path.join(ROOT, 'lib', 'shared', 'semantic.js'))

const SESSION_LIMIT = Number(process.argv[2] ?? 2)
const ROUNDS = Number(process.argv[3] ?? 5)

/** 取真实会话里的判定材料：**用插件自己那几个函数**（分组、组目标、目标句）。 */
function materialOf(turns) {
  const terms = turns.map((turn) => shared.bigrams(`${turn.prompt}${turn.response}`))
  const groups = shared.groupTurns(terms)
  const prompts = turns.map((turn) => turn.prompt)
  const objectives = groups.map((group) => shared.groupObjective(group, terms, prompts))
  const groupOf = new Map()
  groups.forEach((group, index) => group.forEach((item) => groupOf.set(turns[item].turn, index + 1)))
  const judged = []
  for (const turn of turns) {
    if (turn.early === '') continue
    if (shared.bigrams(turn.prompt).size >= shared.BRIEF_PROMPT) continue
    const statement = shared.goalStatement(turn.early)
    if (statement === '') continue
    const group = groupOf.get(turn.turn)
    if (group === undefined) continue
    judged.push({ turn: turn.turn, group, text: statement })
  }
  return { groups: objectives, turns: judged.slice(0, 40) }
}

const sessions = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  const material = materialOf(usable.turns)
  if (material.turns.length < 4) continue
  sessions.push({ id: candidate.id.slice(8, 14), material })
  if (sessions.length >= SESSION_LIMIT) break
}
if (sessions.length === 0) {
  console.error('✗ 没有找到带"简报回合理解"的会话')
  process.exit(2)
}

for (const session of sessions) {
  const { groups, turns } = session.material
  // **与宿主走同一套分批**（`planBatches` / `batchTokenBudget`）——
  // 工具里另写一套的话，量出来的就不是插件的行为。
  const batches = semantic.planBatches(groups, turns)
  const allowed = turns.map((turn) => turn.turn)
  console.log(`  （分成 ${batches.length} 批，每批 ≤ ${semantic.BATCH_TURNS} 条）`)
  console.log(
    `\n=== ${session.id}：${groups.length} 组 · 待判 ${turns.length} 条 · 重复 ${ROUNDS} 次 ===`,
  )

  /** 每一轮的判定：回合号 → match。 */
  const rounds = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const verdicts = []
    for (const [batchIndex, batch] of batches.entries()) {
      const raw = await complete(
        semantic.SEMANTIC_SYSTEM,
        semantic.semanticPrompt(batch.groups, batch.turns),
        { json: true, maxTokens: semantic.batchTokenBudget(batch.turns.length), temperature: 0 },
      )
      const got = semantic.parseVerdicts(
        raw,
        batch.turns.map((turn) => turn.turn),
      )
      // **第一次跑就发现 0 条**：把原文打出来看，而不是继续猜。
      if (got.length === 0 && round === 0 && batchIndex === 0) {
        console.log(`    ⚠ 第一批解析失败。待判回合号：[${batch.turns.map((t) => t.turn).join(',')}]`)
        console.log(`    原文（前 400）：${raw.slice(0, 400)}`)
      }
      verdicts.push(...got)
    }
    const map = new Map(verdicts.map((item) => [item.turn, item.match]))
    rounds.push(map)
    const mismatches = verdicts.filter((item) => item.match === false).length
    console.log(
      `  第 ${round + 1} 轮：解析出 ${verdicts.length}/${turns.length} 条 · ` +
        `判为不一致 ${mismatches} 条${verdicts.length < turns.length ? '（有缺失）' : ''}`,
    )
  }

  // 逐条翻面
  let flipped = 0
  let missing = 0
  const detail = []
  for (const turn of turns) {
    const answers = rounds.map((map) => map.get(turn.turn))
    const present = answers.filter((value) => value !== undefined)
    if (present.length < ROUNDS) missing += 1
    const unique = new Set(present)
    if (unique.size > 1) {
      flipped += 1
      detail.push({ turn: turn.turn, answers: answers.map((a) => (a === undefined ? '—' : a ? '一致' : '偏离')).join('/') })
    }
  }
  console.log(
    `  逐条翻面：${flipped}/${turns.length} 条在 ${ROUNDS} 次里出现过不同答案` +
      `（${((flipped / turns.length) * 100).toFixed(0)}%）` +
      `${missing > 0 ? ` · ${missing} 条有轮次缺答案` : ''}`,
  )
  for (const item of detail.slice(0, 6)) {
    console.log(`    #${item.turn}: ${item.answers}`)
  }

  // 多数票之后还剩多少
  const majorityMismatch = []
  for (const turn of turns) {
    const present = rounds.map((map) => map.get(turn.turn)).filter((v) => v !== undefined)
    if (present.length === 0) continue
    const no = present.filter((value) => value === false).length
    if (no * 2 > present.length) majorityMismatch.push(turn.turn)
  }
  const unanimous = turns.filter((turn) => {
    const present = rounds.map((map) => map.get(turn.turn)).filter((v) => v !== undefined)
    return present.length === ROUNDS && new Set(present).size === 1
  }).length
  console.log(
    `  一致性：${ROUNDS} 次完全一致的 ${unanimous}/${turns.length} 条` +
      ` · 多数票判为"偏离"的 ${majorityMismatch.length} 条` +
      `${majorityMismatch.length > 0 ? `（#${majorityMismatch.join(' #')}）` : ''}`,
  )
}

console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
console.log('⚠️ 这是**代理**：走 DeepSeek 的 HTTP API，不是插件的 `ctx.llm.stream`。')
console.log('   模型系列与温度(0)相同，所以"稳不稳"的结论可以外推；具体数字不能。')
