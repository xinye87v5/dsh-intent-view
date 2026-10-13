// 选一个**最近不活跃**的会话，离线构建与插件完全相同的判定材料。
import { statSync } from 'node:fs'
import path from 'node:path'
import { buildTurns, collectSessions, readEvents, usableTurns } from '../session-log.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// **路径从脚本位置推**，不写死：写死的路径换台机器就废了（这正是把它们
// 从 /tmp 搬进仓库的原因——那批结论原先活在一个会被清空的目录里）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const shared = await import(path.join(ROOT, 'tools', 'probes', 'grouping.mjs'))
const OUT = path.join(HERE, '.out')
mkdirSync(OUT, { recursive: true })

const used = new Set(['session-abcd1239', 'session-abcd1235', 'session-abcd1240'])
const rows = []
for (const c of collectSessions()) {
  if ([...used].some((u) => c.id.startsWith(u))) continue
  let u
  try { u = usableTurns(buildTurns(readEvents(c.log))) } catch { continue }
  const terms = u.turns.map((t) => shared.bigrams(t.prompt + t.response))
  const groups = shared.groupTurns(terms)
  if (groups.length < 2) continue
  const prompts = u.turns.map((t) => t.prompt)
  // 与产品同口径：每组送**这一组里用户说过的话**（首/中/尾三条）
  const objectives = groups.map((g) => {
    const picks = [g[0], g[Math.floor((g.length - 1) / 2)], g[g.length - 1]]
    return [...new Set(picks)].map((x) => prompts[x].slice(0, 140)).filter((t) => t).join(' ')
  })
  const gof = new Map(); groups.forEach((g, i) => g.forEach((x) => gof.set(u.turns[x].turn, i + 1)))
  const judged = []
  for (const t of u.turns) {
    if (t.early === '' || shared.bigrams(t.prompt).size >= shared.BRIEF_PROMPT) continue
    const st = shared.goalStatement(t.early)
    if (st === '') continue
    judged.push({ turn: t.turn, group: gof.get(t.turn), text: st })
  }
  if (judged.length < 12) continue
  rows.push({ id: c.id, mtime: statSync(c.log).mtimeMs, turns: u.turns.length, groups: groups.length,
              objectives, judged, sessionPrompts: u.turns.map((t) => t.prompt),
              allTurns: u.turns.map((t) => ({ turn: t.turn, prompt: t.prompt })) })
}
// 最近不活跃 = 日志修改时间最早
rows.sort((a, b) => a.mtime - b.mtime)
const picked = rows[0]
// 另一个会话的用户话（当"别人的任务"的对照）——取候选里的第二个
const otherSessionContext = (rows[1]?.sessionPrompts ?? [])
  .filter((x) => x)
  .filter((_, i) => i % Math.max(1, Math.floor((rows[1]?.sessionPrompts?.length ?? 1) / 5)) === 0)
  .slice(0, 5)
  .map((x) => x.slice(0, 140))
  .join(' ')
console.log('候选（按最后写入时间由早到晚）:')
for (const r of rows.slice(0, 5)) {
  console.log(`  ${r.id.slice(8,16)}  ${new Date(r.mtime).toISOString().slice(0,16)}  ${r.turns} 回合 · ${r.groups} 组 · ${r.judged.length} 条可判`)
}
const turns = picked.judged.slice(0, 24)
/** 逐条配对要用**全部回合**去找"最近一条实质指令"，不只是被判的那些。 */
const allTurnRows = picked.allTurns ?? []
const material = { id: picked.id, hash: 'deadbeef-' + turns.length,
                   sessionId: picked.id, groups: picked.objectives, turns }
writeFileSync(path.join(OUT, 'material.json'), JSON.stringify(material))

// **打乱配对**：每条理解配给「另一个组」的目标。
// 组号必须落在 1..组数 里（宿主会校验），所以按组数轮转。
const n = picked.objectives.length
const shuffled = turns.map((t) => ({ ...t, group: ((t.group - 1 + 1) % n) + 1 }))
// 若轮转后有"恰好还是本组"的（组数为 1 时），就再挪一格
for (const t of shuffled) {
  const original = turns.find((x) => x.turn === t.turn)
  if (original && t.group === original.group) t.group = (t.group % n) + 1
}
const changed = shuffled.filter((t) => {
  const original = turns.find((x) => x.turn === t.turn)
  return original && original.group !== t.group
}).length
writeFileSync(path.join(OUT, 'material-shuffled.json'),
  JSON.stringify({ ...material, hash: 'feedface-' + turns.length, turns: shuffled }))
console.log(`打乱后有 ${changed}/${turns.length} 条的组号确实变了（剩下的说明组号轮转回了原组）`)

// ── 会话级对照：把"组"换成**整个会话的任务** ──────────────────────────────
//
// 上面那份材料问的是"这条理解与它那个**词面聚类出来的组**是不是同一件事"。
// 而那个组是 `groupTurns` 用字面重合切出来的——拿它当"任务"去问，
// 模型判"不是同一件事"是应该的：同一段任务里的不同侧面本来就不同。
//
// 所以另出一份：**只有一组**，内容是这场会话里用户说过的话（跨全程抽样），
// 问的问题变成"这条理解还在不在**这场会话的任务**里"。
// 使用者的直觉是"方向偏离约 5%"，这一份才是能验证那个直觉的口径。
const allPrompts = picked.sessionPrompts.filter((x) => x !== '')
const sessionSamples = [0, 0.25, 0.5, 0.75, 1]
  .map((f) => allPrompts[Math.min(allPrompts.length - 1, Math.floor(f * (allPrompts.length - 1)))])
const sessionContext = [...new Set(sessionSamples)].map((x) => x.slice(0, 140)).join(' ')
writeFileSync(path.join(OUT, 'material-session.json'), JSON.stringify({
  ...material, hash: 'cafe0000-' + turns.length,
  groups: [sessionContext],
  turns: turns.map((t) => ({ ...t, group: 1 })),
}))
// 对照：配给**另一个会话**的任务
writeFileSync(path.join(OUT, 'material-session-other.json'), JSON.stringify({
  ...material, hash: 'cafe1111-' + turns.length,
  groups: [otherSessionContext ??
    '（另一个会话：把一份长篇小说按章节逐章审读，修掉前后矛盾的设定，并同步设定文档）'],
  turns: turns.map((t) => ({ ...t, group: 1 })),
}))
console.log(`会话级材料：1 组（${sessionContext.slice(0, 60)}…）· ${turns.length} 条理解都指向它`)

// ── 第三种口径：**最近一条实质指令** ────────────────────────────────────────
//
// 前两种都答错了问题：
//   · 组级问的是"与这个**词面聚类**出来的组是不是同一件事" —— 组的边界本身
//     就是字面重合切出来的，判"不是"是应该的；
//   · 会话级把 5 条互不相干的 prompt 拼成"任务" —— **没有哪一句话能等于一堆话**，
//     于是偏离率反而更高（91%）。
//
// 使用者真正问的是："**agent 有没有理解你刚才让它做的事**"。
// 简报回合（"同意"）自己没有实质内容 —— 它的任务是**前面最近那条实质指令**。
// 所以这一份：每条理解配给**它之前最近的那条实质 prompt**（逐条一个组）。
const substantive = turns
  .map((t) => {
    const before = allTurnRows.filter((x) => x.turn <= t.turn && shared.bigrams(x.prompt).size >= shared.BRIEF_PROMPT)
    const recent = before[before.length - 1]
    return recent === undefined ? null : recent.prompt.slice(0, 200)
  })
writeFileSync(path.join(OUT, 'material-recent.json'), JSON.stringify({
  ...material, hash: 'beef0000-' + turns.length,
  groups: substantive.map((x) => x ?? '（这条之前没有实质指令）'),
  turns: turns.map((t, i) => ({ ...t, group: i + 1 })),
}))
// 对照：配给**别处的**实质指令（错位一格）
writeFileSync(path.join(OUT, 'material-recent-shift.json'), JSON.stringify({
  ...material, hash: 'beef1111-' + turns.length,
  groups: substantive.map((_, i) => substantive[(i + 7) % substantive.length] ?? '（空）'),
  turns: turns.map((t, i) => ({ ...t, group: i + 1 })),
}))
console.log(`逐条材料：${substantive.filter((x) => x !== null).length}/${turns.length} 条配到了"最近一条实质指令"`)
console.log(`\n选中 ${picked.id.slice(8,16)}（最后写入 ${new Date(picked.mtime).toISOString().slice(0,16)}）· 送 ${material.turns.length} 条`)
