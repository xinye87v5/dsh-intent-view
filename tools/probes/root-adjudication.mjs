#!/usr/bin/env node
/**
 * **根裁定的问法对照**：顶层节点该怎么问，模型才既不会漏合并、也不会错合并。
 *
 * 背景：使用者裁定"根的数量不设阈值、按任务领域的语义划分"。但实测同一场会话
 * 有时给 1 个根、有时平铺成 26 个根。所以要在收尾加**一次语义裁定**，
 * 问题是怎么问。三臂：
 *
 * | 臂 | 问法 |
 * |---|---|
 * | A | 这些顶层节点是**几件独立的大事**，还是**同一件事的不同栏目**？ |
 * | B | 这些顶层节点覆盖的内容**能不能用一句话概括**？ |
 * | C | 请把它们**分组**，使**每组都能用一句话概括** |
 *
 * 四个案例（真值明确）：
 *
 * | 案例 | 来源 | 真值 |
 * |---|---|---|
 * | `fairytale-flat` | 童话真实跑出来的平铺 | 6 个栏目一组 + `幼儿园手工作业` 自成一组 |
 * | `travel-flat` | 旅游人为压平 | 一组 |
 * | `two-domains` | 童话根 + 旅游根拼一张图（人为） | 两组 |
 * | `real-session` | 个人资料会话真实平铺 | 按使用者早先裁定：约 3 条线 |
 *
 * ## 跑法
 *
 * ```bash
 * node tools/probes/root-adjudication.mjs --runs 3
 * node tools/probes/root-adjudication.mjs --cases real-session --arms B,C --runs 3
 * node tools/probes/root-adjudication.mjs --rescore      # 用存下的原始回复离线复评（不花钱）
 * ```
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { complete, usage } from '../llm-client.mjs'
import { ADJUDICATE_PROMPT, ancestorsOf, fillPrompt, isMetaName, mostSpecific } from './pipeline.mjs'
import { loadSessionTurns } from './session-turns.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const SYS = '你是任务结构标注器。只回 JSON，不要解释。'
const RUNS = Number(arg('--runs', 3))
const ARMS = arg('--arms', 'A,B,C').split(',').map((x) => x.trim()).filter((x) => x !== '')
const ONLY = arg('--cases', '').split(',').map((x) => x.trim()).filter((x) => x !== '')
const RESCORE = process.argv.includes('--rescore')

// ── 语料 ───────────────────────────────────────────────────────────────
const corpusOf = (file) => readFileSync(path.resolve(ROOT, 'research', file), 'utf8')
  .split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))
const CORPUS = {
  'synthetic-fairytale': corpusOf('synthetic-fairytale.txt'),
  'synthetic-travel': corpusOf('synthetic-travel.txt'),
}
/**
 * 真实会话的回合在本地（不进版本库）。**必须用它自己的语料**——我第一次给这个
 * 案例填了童话语料，模型看到"个人资料的根标题 + 童话的例句"，编出一个
 * `小红帽图文创作` 组，整批数据作废。
 */
const SESSION_FILE = path.resolve(ROOT, 'research', 'session-abcd1234.txt')
if (existsSync(SESSION_FILE)) CORPUS['session-abcd1234'] = corpusOf('session-abcd1234.txt')
// 车次查询那场（29 回合）：裁定给出 5 条各自独立的线，用它检验"换个问法会不会并"
try { CORPUS['session-abcd1237'] = loadSessionTurns('abcd1237').turns.map((t) => ({ turn: t.turn, prompt: t.prompt })) } catch { /* 本地没有就跳过 */ }

const loadState = (file) => JSON.parse(readFileSync(path.resolve(HERE, '.out', file), 'utf8'))

// ── 四个案例 ───────────────────────────────────────────────────────────
const fairytaleFlat = () => mostSpecific(loadState('fairytale-run2.json'))
const travelFlat = () => {
  const st = mostSpecific(loadState('travel-run3.json'))
  const root = Object.keys(st.nodes).find((id) => st.nodes[id].parents.includes('root') && st.nodes[id].kind !== 'aside')
  const nodes = {}
  for (const [id, n] of Object.entries(st.nodes)) {
    nodes[id] = id === root ? { ...n, parents: ['root'] } : { ...n, parents: n.parents.includes(root) ? ['root'] : n.parents }
  }
  return { nodes, membership: st.membership }
}
const realSession = () => mostSpecific(loadState('session-abcd1234-latest.json'))
const twoDomains = () => {
  const pick = (st) => {
    const root = Object.keys(st.nodes).find((id) => st.nodes[id].parents.includes('root') && st.nodes[id].kind !== 'aside')
    const keep = new Set([root, ...Object.keys(st.nodes).filter((id) => ancestorsOf(st.nodes, id).has(root))])
    return { nodes: Object.fromEntries(Object.entries(st.nodes).filter(([id]) => keep.has(id))), membership: st.membership }
  }
  const states = [pick(mostSpecific(loadState('fairytale-run3.json'))), pick(mostSpecific(loadState('travel-run3.json')))]
  const nodes = {}
  const membership = {}
  states.forEach((state, k) => {
    for (const [id, n] of Object.entries(state.nodes)) {
      nodes[`${k}-${id}`] = { ...n, parents: n.parents.map((p) => (p === 'root' ? 'root' : `${k}-${p}`)) }
    }
    for (const [turn, ids] of Object.entries(state.membership)) {
      membership[turn] = [...(membership[turn] ?? []), ...ids.map((x) => `${k}-${x}`)]
    }
  })
  return { nodes, membership }
}

const CASES = [
  {
    id: 'fairytale-flat', build: fairytaleFlat, corpus: 'synthetic-fairytale',
    note: '童话真实平铺',
    truthGroups: [['角色设定', '结局改编', '插画风格', '第一页内容', '朗读配音', '未定事项梳理'], ['幼儿园手工作业']],
  },
  {
    id: 'travel-flat', build: travelFlat, corpus: 'synthetic-travel',
    note: '旅游人为压平',
    truthGroups: [['京都五天行程框架', '出行时间与预算', '机票与进出港', '住宿区域选择', '每日行程安排', '餐饮注意事项']],
  },
  {
    id: 'two-domains', build: twoDomains, corpus: 'synthetic-fairytale',
    note: '童话 + 旅游（人为拼图）',
    truthGroups: [['改编小红帽图文'], ['京都五天行程框架']],
  },
  {
    id: 'abcd1237-flat', build: () => mostSpecific(loadState('session-abcd1237.json')), corpus: 'session-abcd1237',
    note: '车次查询会话（29 回合，裁定给出 5 条独立线）',
    truthGroups: null, expectGroups: 1, // 真值未知：这里只想看"有没有哪种问法会把它并成一条"
  },
  {
    id: 'real-session', build: realSession, corpus: 'session-abcd1234',
    note: '个人资料会话真实平铺（使用者裁定：约 3 条线）',
    truthGroups: null, expectGroups: 3,
  },
]

// ── 提示词 ─────────────────────────────────────────────────────────────
const rootsOf = (state) => Object.keys(state.nodes)
  .filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
const renderRoots = (state, turns) => {
  const ids = Object.keys(state.nodes)
  return rootsOf(state).map((id, k) => {
    const subtree = new Set([id, ...ids.filter((x) => ancestorsOf(state.nodes, x).has(id))])
    const mine = turns.filter((t) => (state.membership[String(t.turn)] ?? []).some((x) => subtree.has(x)))
    const samples = mine.slice(0, 3).map((t) => `#${t.turn} ${String(t.prompt).slice(0, 46)}`).join('　')
    // **带序号**：让模型回序号，别抄标题——抄标题会把注记一起抄回来（我踩过，9 次全判错）
    return `${k + 1}) ${state.nodes[id].title}（${mine.length} 个回合）${samples === '' ? '' : `\n    ${samples}`}`
  }).join('\n')
}
const HEAD = ['这是一场会话被划分出的几个**顶层**节点（每个后面是它覆盖的回合数与代表回合）：', '$ROOTS', '']
const FORM = {
  A: [
    '问：这些顶层节点是**几件独立的大事**，还是**同一件事的不同栏目**？',
    '- 同一件事的不同栏目 → {"oneThing":true,"name":"这件事的名字（12 字内）","reason":"为什么"}',
    '- 几件独立的大事 → {"oneThing":false,"name":"","reason":"为什么"}',
  ],
  B: [
    '问：这些顶层节点覆盖的内容，**能不能用一句话概括**？',
    '- 能 → {"oneThing":true,"name":"那句话（12 字内，作为项目名）","reason":"为什么"}',
    '- 不能（它们是几件彼此不同的事）→ {"oneThing":false,"name":"","reason":"为什么"}',
  ],
  C: [
    '问：请把它们**分组**，使得**每一组都能用一句话概括**（那句话就是这一组的项目名）。',
    '- 全都属于同一件事 → 只给一组；',
    '- 只有一部分属于同一件事 → 该组一组，其余各自成组；',
    '- 彼此都不同 → 每个各成一组。',
    '',
    '只回 JSON：{"groups":[{"name":"这一组的一句话名字（12 字内）","roots":[1,3,5]}]}',
    '（roots 写上面的**序号**，不要抄标题；每个序号只能出现在一组里）',
  ],
}

// ── 判定与评分 ─────────────────────────────────────────────────────────
function parseVerdict(form, raw, titles) {
  try {
    const reply = JSON.parse(raw)
    if (form === 'C' || form === 'F') {
      const groups = (reply.groups ?? []).map((g) => ({
        name: String(g.name ?? ''),
        roots: (g.roots ?? []).map((x) => (typeof x === 'number' ? titles[x - 1] : titles.find((t) => t === String(x)) ?? String(x))).filter((x) => x !== undefined),
      }))
      return {
        ok: groups.length > 0, groups, oneThing: groups.length === 1,
        name: groups.map((g) => g.name).join(' / '),
        metaNames: groups.filter((g) => isMetaName(g.name)).map((g) => g.name),
      }
    }
    return { ok: true, oneThing: reply.oneThing === true, name: String(reply.name ?? ''), groups: undefined }
  } catch {
    return { ok: false, oneThing: null, name: '', groups: undefined, error: raw.slice(0, 60) }
  }
}
const partitionOf = (groups) => groups.map((g) => [...g.roots].sort().join('|')).filter((k) => k !== '').sort().join(' && ')
const truthPartition = (c) => c.truthGroups.map((g) => [...g].sort().join('|')).sort().join(' && ')
function score(c, verdict) {
  if (!verdict.ok) return false
  const want = c.truthGroups === null ? null : truthPartition(c)
  if (verdict.groups !== undefined) {
    if (want === null) return verdict.groups.length === c.expectGroups
    return partitionOf(verdict.groups) === want
  }
  if (want === null) return false
  return c.truthGroups.length === 1 ? verdict.oneThing === true : verdict.oneThing === false
}
const isUmbrella = (verdict) => verdict.ok && (verdict.oneThing === true || (verdict.groups ?? []).length === 1)

// ── 主流程 ─────────────────────────────────────────────────────────────
const RAW = []
const rawPath = path.resolve(HERE, '.out', `root-adjudication-${ARMS.join('')}.json`)
const saveRaw = () => writeFileSync(rawPath, JSON.stringify(RAW, null, 1))

function report(c, list) {
  console.log(`\n=== ${c.id}：${list[0].roots.length} 个根 · ${c.note} ===`)
  for (const form of ARMS) {
    const mine = list.filter((r) => r.form === form)
    if (mine.length === 0) continue
    const verdicts = mine.map((r) => parseVerdict(form, r.raw, r.roots))
    console.log(`  问法${form}：判对 ${verdicts.filter((v) => score(c, v)).length}/${mine.length} · 错合并 ${verdicts.filter(isUmbrella).length}`)
    for (const v of verdicts) {
      if (!v.ok) { console.log('    解析失败：' + String(v.error ?? '').slice(0, 60)); continue }
      if (v.groups !== undefined) console.log('    ' + v.groups.map((g) => `「${g.name}」(${g.roots.length})${isMetaName(g.name) ? '⚠动作名' : ''}`).join(' ｜ '))
      else console.log(`    ${v.oneThing ? '同一件事' : '几件事'}${v.name === '' ? '' : `「${v.name}」`}`)
    }
  }
}

if (RESCORE) {
  if (!existsSync(rawPath)) throw new Error(`没有可复评的文件：${rawPath}`)
  const saved = JSON.parse(readFileSync(rawPath, 'utf8'))
  console.log(`离线复评 ${saved.length} 条原始回复（${path.relative(process.cwd(), rawPath)}）`)
  for (const c of CASES) {
    const list = saved.filter((r) => r.case === c.id)
    if (list.length > 0) report(c, list)
  }
} else {
  for (const c of CASES) {
    if (ONLY.length > 0 && !ONLY.includes(c.id)) continue
    const state = c.build()
    const titles = rootsOf(state).map((id) => state.nodes[id].title)
    const rootsText = renderRoots(state, CORPUS[c.corpus] ?? [])
    console.log(`\n=== ${c.id}：${titles.length} 个根 · ${c.note} ===`)
    console.log('  ' + titles.join(' / '))
    for (const form of ARMS) {
      const collected = []
      for (let i = 0; i < RUNS; i += 1) {
        // F 臂 = **冻结的那段提示词**（含"名字要说明这件事是什么"），与 C 只差措辞
        const prompt = form === 'F'
          ? fillPrompt(ADJUDICATE_PROMPT, { roots: rootsText })
          : [...HEAD, ...FORM[form], '', '只回 JSON。'].join('\n').replace('$ROOTS', rootsText)
        const raw = await complete(SYS, prompt, { json: true, maxTokens: form === 'C' ? 700 : 400 })
        const record = { case: c.id, form, corpus: c.corpus, roots: titles, prompt, raw }
        RAW.push(record)
        saveRaw() // 每问一次就落盘：之前放在末尾，汇总一崩就白跑一整批
        collected.push(record)
      }
      report(c, collected)
    }
  }
  saveRaw()
  console.log('\n=== 合计 ===')
  const ranCases = CASES.filter((c) => ONLY.length === 0 || ONLY.includes(c.id))
  for (const form of ARMS) {
    let right = 0
    let total = 0
    let umbrella = 0
    for (const c of ranCases) {
      const mine = RAW.filter((r) => r.case === c.id && r.form === form)
      total += mine.length
      right += mine.map((r) => parseVerdict(form, r.raw, r.roots)).filter((v) => score(c, v)).length
      if (c.id === 'two-domains') umbrella = mine.map((r) => parseVerdict(form, r.raw, r.roots)).filter(isUmbrella).length
    }
    console.log(`问法${form}：判对 ${right}/${total} · "把两件事硬说成一件事" ${umbrella}/${RUNS} 次`)
  }
  console.log(`原始回复已存到 ${path.relative(process.cwd(), rawPath)}（可用 --rescore 离线复评）`)
  console.log(`\n用量：${usage.calls} 次调用 · 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`)
}
