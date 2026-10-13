#!/usr/bin/env node
/**
 * 那个"来源不同的第二个信号"到底有没有用——**对照实验**。
 *
 * ## 背景
 *
 * `research/reasoning-phases.md` 测出一条干净的位置结构：**靠前的思考在重申目标**
 * （前 0.0559 / 后 0.0180，错配对照 0.0142，6/6 会话方向一致）。
 * 那里只证明了**信号存在**，没证明**它有用**。
 *
 * > 把"本回合前段思考与当前组的相关度"当成**第二个分界判据**，分段质量会不会变好？
 *
 * ## 设计上最容易犯的两个错（第一版两个都犯了）
 *
 * **① 拿不同阈值比。** 第一版比的是 `or@0.04` 与 `base@0.08`，于是"变好了"
 * 完全可能只是**把阈值调低了**（切得更少），新信号一点没参与。
 * ⇒ 现在**在同一阈值上**比：`or@T` vs `base@T`，逐 T 看**边际**效果。
 *
 * **② 没有安慰剂。** 新信号只是让"切得更少"或"切得更多"成立是不够的——
 * 随便换个信号也能做到。⇒ 加 `orShuf`：把每回合的前段思考**换成另一个回合的**
 * （会话内旋转 7 位），同一套算法再跑一遍。**若打乱后的成绩与真的相当，
 * 那功劳不在信号内容里。**
 *
 * ## 两种真值（各自都有弱点，缺一不可）
 *
 * - **自定真值**：`scripts/segment-quality.mjs` 那套（相邻窗口连续性的局部谷底）。
 *   与算法**同族同窗口**，有自我循环成分。
 * - **事件锚定的外部真值**：真实的 `goal/change`（`create`/`clear`）与
 *   `session/title` 变更。**不是我们算的**。但 n 很小（逐个会话如实报数），
 *   只作定性锚点。
 *
 * 用法：`node tools/test-early-reasoning-signal.mjs [最少回合数=40]`
 */
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns } from './session-log.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))
const {
  averageSegment,
  labelsFromBoundaries,
  labelsFromGroups,
  naiveGroups,
  pk,
  truthBoundaries,
  windowDiff,
} = await import(path.join(ROOT, 'scripts', 'segment-quality.mjs'))

const MIN_TURNS = Number(process.argv[2] ?? 40)
/** 前段思考取多少字符——与 `research/reasoning-phases.md` 的窗口一致。 */
const WINDOW = 400
/** 阈值扫描。**基准也用同一组**，否则比出来的是阈值不是信号。 */
const THRESHOLDS = [0.04, 0.06, 0.08, 0.1, 0.12]
/** 安慰剂：会话内旋转这么多位，把"这一回合的前段思考"换成别回合的。 */
const SHUFFLE_SHIFT = 7

/**
 * 分组。两个累积集合**各滚各的**：连续性滚 `prompt + response` 的词，
 * 前段思考滚前段思考的词——混在一起就分不出是哪个信号在起作用。
 *
 * `variant` 为 `base` 时必须与 `shared.groupTurns` **逐位一致**（脚本会自检）。
 */
function group(terms, earlyTerms, variant, threshold) {
  const groups = []
  let current = []
  let currentTerms = new Set()
  let currentEarly = new Set()
  for (let index = 0; index < terms.length; index += 1) {
    const item = terms[index]
    const early = earlyTerms[index]
    if (current.length === 0) {
      current = [index]
      currentTerms = new Set(item)
      currentEarly = new Set(early)
      continue
    }
    const continuity = shared.overlap(currentTerms, item)
    // **前段思考缺失时这个信号没有发言权**：回落到"不切"，而不是当成 0 去切
    const earlyFit = early.size === 0 ? Number.POSITIVE_INFINITY : shared.overlap(currentEarly, early)
    const split =
      variant === 'base'
        ? continuity < threshold
        : variant === 'or'
          ? continuity < threshold || earlyFit < threshold
          : variant === 'and'
            ? continuity < threshold && earlyFit < threshold
            : earlyFit < threshold
    if (split || current.length >= shared.MAX_GROUP) {
      groups.push(current)
      current = [index]
      currentTerms = new Set(item)
      currentEarly = new Set(early)
    } else {
      current.push(index)
      for (const term of item) currentTerms.add(term)
      for (const term of early) currentEarly.add(term)
    }
  }
  if (current.length > 0) groups.push(current)

  const merged = []
  for (const item of groups) {
    if (merged.length > 0 && item.length < shared.MIN_GROUP) merged[merged.length - 1].push(...item)
    else merged.push(item)
  }
  return merged
}

const boundsOfLabels = (labels) => {
  const out = []
  for (let i = 1; i < labels.length; i += 1) if (labels[i] !== labels[i - 1]) out.push(i)
  return out
}

const mean = (list) => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length)
const median = (list) => {
  if (list.length === 0) return null
  const sorted = list.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const fmt = (v, digits = 4) => (v === null ? '  —  ' : v.toFixed(digits))

// ── 载入会话 ────────────────────────────────────────────────────────────────
const loaded = []
for (const candidate of collectSessions()) {
  let usable
  try {
    usable = usableTurns(buildTurns(readEvents(candidate.log)))
  } catch {
    continue
  }
  if (usable.turns.length < MIN_TURNS) continue
  loaded.push({ id: candidate.id.slice(0, 14), ...usable })
}

if (loaded.length === 0) {
  console.error(`✗ 没有 ≥${MIN_TURNS} 回合的会话`)
  process.exit(2)
}

// ── 自检：base 必须等于插件真身 ──────────────────────────────────────────────
{
  const probe = loaded[0]
  const terms = probe.turns.map((t) => shared.bigrams(t.prompt + t.response))
  const empty = terms.map(() => new Set())
  const mine = JSON.stringify(group(terms, empty, 'base', shared.SPLIT_AT))
  const real = JSON.stringify(shared.groupTurns(terms))
  if (mine !== real) {
    console.error('✗ 自检失败：本脚本的 base 与 shared.groupTurns 不一致——先修这个再读数字')
    console.error(`  脚本 ${mine.slice(0, 120)}`)
    console.error(`  真身 ${real.slice(0, 120)}`)
    process.exit(3)
  }
  console.log(`✓ 自检：base 与 shared.groupTurns 逐位一致（${probe.id}，${terms.length} 回合）`)
}

console.log(`会话 ${loaded.length} 个（≥${MIN_TURNS} 回合）· 阈值扫描 ${THRESHOLDS.join(' / ')}\n`)

const cells = new Map()
const key = (variant, threshold) => `${variant}@${threshold}`
for (const variant of ['base', 'or', 'and', 'early', 'orShuf', 'andShuf']) {
  for (const threshold of THRESHOLDS) {
    cells.set(key(variant, threshold), { wd: [], pk: [], groups: [], anchor: [], added: [], addedHit: [] })
  }
}

const anchorsBySession = []
for (const session of loaded) {
  const terms = session.turns.map((t) => shared.bigrams(t.prompt + t.response))
  const early = session.turns.map((t) => shared.bigrams(t.early))
  const shuffled = early.map((_, index) => early[(index + SHUFFLE_SHIFT) % early.length])
  const total = terms.length
  const anchors = [...session.goalAnchors, ...session.titleAnchors]
  anchorsBySession.push({ id: session.id, total, goal: session.goalAnchors, title: session.titleAnchors })

  const truthLabels = labelsFromBoundaries(truthBoundaries(terms, shared), total)
  const naive = labelsFromGroups(naiveGroups(total), total)
  const k = Math.max(1, Math.round(averageSegment(truthLabels) / 2))

  console.log(
    `── ${session.id}  ${total} 回合 · 真值 ${new Set(truthLabels).size} 段 · k=${k} · ` +
      `锚点 goal ${session.goalAnchors.length} + title ${session.titleAnchors.length} · ` +
      `朴素 WindowDiff ${windowDiff(truthLabels, naive).toFixed(4)}`,
  )

  for (const [variant, signal, baseline] of [
    ['base', undefined, undefined],
    ['or', early, undefined],
    ['and', early, undefined],
    ['early', early, undefined],
    ['orShuf', shuffled, undefined],
    ['andShuf', shuffled, undefined],
  ]) {
    for (const threshold of THRESHOLDS) {
      if (variant === 'base' && threshold !== shared.SPLIT_AT && false) continue
      const groups = group(terms, signal ?? terms.map(() => new Set()), variant === 'orShuf' || variant === 'andShuf' ? (variant === 'orShuf' ? 'or' : 'and') : variant, threshold)
      const labels = labelsFromGroups(groups, total)
      const cell = cells.get(key(variant, threshold))
      cell.wd.push(windowDiff(truthLabels, labels))
      cell.pk.push(pk(truthLabels, labels))
      cell.groups.push(groups.length)

      // 锚点距离：预测的每个分界离最近锚点多远；以及**新增**的分界命中率
      const bounds = boundsOfLabels(labels)
      if (anchors.length > 0 && bounds.length > 0) {
        for (const bound of bounds) {
          const near = Math.min(...anchors.map((a) => Math.abs(a - bound)))
          cell.anchor.push(near)
        }
      }
      if (baseline !== undefined) void baseline
      const baseBounds = boundsOfLabels(labelsFromGroups(group(terms, terms.map(() => new Set()), 'base', shared.SPLIT_AT), total))
      const added = bounds.filter((b) => !baseBounds.includes(b))
      if (anchors.length > 0 && added.length > 0) {
        cell.added.push(added.length)
        cell.addedHit.push(added.filter((b) => Math.min(...anchors.map((a) => Math.abs(a - b))) <= 2).length)
      }
    }
  }
}

console.log('\n=== 同一阈值下的对照（关键：`or`/`and` 与同阈值的 `base` 比）===')
console.log('阈值    base WD   or WD    and WD   early WD | base 组  or 组  and 组 | orShuf WD  andShuf WD')
for (const threshold of THRESHOLDS) {
  const get = (variant, field) => cells.get(key(variant, threshold))[field]
  console.log(
    `${String(threshold).padEnd(8)}${fmt(mean(get('base', 'wd')))}  ${fmt(mean(get('or', 'wd')))}  ` +
      `${fmt(mean(get('and', 'wd')))}  ${fmt(mean(get('early', 'wd')))} | ` +
      `${fmt(mean(get('base', 'groups')), 1).padStart(6)}${fmt(mean(get('or', 'groups')), 1).padStart(7)}` +
      `${fmt(mean(get('and', 'groups')), 1).padStart(7)} | ` +
      `${fmt(mean(get('orShuf', 'wd')))}   ${fmt(mean(get('andShuf', 'wd')))}`,
  )
}

console.log('\n=== Pk（同上）===')
console.log('阈值    base Pk   or Pk    and Pk   orShuf Pk')
for (const threshold of THRESHOLDS) {
  const get = (variant, field) => cells.get(key(variant, threshold))[field]
  console.log(
    `${String(threshold).padEnd(8)}${fmt(mean(get('base', 'pk')))}  ${fmt(mean(get('or', 'pk')))}  ` +
      `${fmt(mean(get('and', 'pk')))}  ${fmt(mean(get('orShuf', 'pk')))}`,
  )
}

console.log('\n=== 外部锚点（goal/change 与标题重算；n 很小，只作定性锚点）===')
for (const row of anchorsBySession) {
  console.log(`  ${row.id}  ${row.total} 回合 · goal 锚点 ${row.goal.length} 个${row.goal.length ? ` (${row.goal.join(',')})` : ''} · 标题重算 ${row.title.length} 个${row.title.length ? ` (${row.title.join(',')})` : ''}`)
}
console.log('  分界到最近锚点的距离（中位 / 命中 ±2 的比例）：')
console.log('  阈值     base 中位  命中 |  or 中位  命中 | orShuf 中位  命中')
for (const threshold of THRESHOLDS) {
  const line = [threshold]
  for (const variant of ['base', 'or', 'orShuf']) {
    const list = cells.get(key(variant, threshold)).anchor
    const med = median(list)
    const hit = list.length === 0 ? null : list.filter((d) => d <= 2).length / list.length
    line.push(`${med === null ? '—' : String(med).padStart(4)}  ${hit === null ? '—' : ((hit * 100).toFixed(0) + '%').padStart(4)}`)
  }
  console.log(`  ${String(line[0]).padEnd(8)}${line[1]} | ${line[2]} | ${line[3]}`)
}

console.log('\n读法：')
console.log('  · **只在同一阈值上比**。`or@T` 与 `base@T` 的差才是新信号的边际效果。')
console.log('  · `orShuf` 是安慰剂：把前段思考换成别的回合的。**打乱后一样好 = 功劳不在信号内容里**。')
console.log('  · 自定真值与算法同族（自我循环）；外部锚点与算法无关但 n 小。两支一起看。')
