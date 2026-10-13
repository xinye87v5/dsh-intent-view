#!/usr/bin/env node
/**
 * 把"闭包"演示渲染成**自包含 HTML**（不联网、不依赖任何库）：
 *
 * `node tools/probes/closure-demo-html.mjs` → `research/closure-demo.html`
 *
 * 左"原样"、右"闭包后"，同一份树；差别只在**回合标签**上——
 * 闭包新增的那些标成橙色虚线。点任一回合标签，两边同时高亮，
 * 底部显示它两边各落在哪。
 *
 * 数据来自 `tools/probes/.out/*.json`（`pipeline-stability.mjs` 存下的真实运行），
 * 所以这个页面**不需要再调模型**就能重生成。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { treeRows, closeUnderAncestors, mostSpecific, attachmentShape, isAncestorClosed } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OUTDIR = path.resolve(HERE, '.out')
const OUT = path.resolve(ROOT, 'research', 'closure-demo-interactive.html')

const DATASETS = [
  { file: 'travel-run3.json', turns: 'synthetic-travel.txt', label: '旅游 run3' },
  { file: 'travel-run1.json', turns: 'synthetic-travel.txt', label: '旅游 run1' },
  { file: 'travel-run2.json', turns: 'synthetic-travel.txt', label: '旅游 run2' },
  { file: 'fairytale-run3.json', turns: 'synthetic-fairytale.txt', label: '童话 run3' },
  { file: 'fairytale-run1.json', turns: 'synthetic-fairytale.txt', label: '童话 run1' },
]

const readTurns = (name) => readFileSync(path.resolve(ROOT, 'research', name), 'utf8')
  .split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

/** 项目根 = 顶层里（除插话）收回合最多的那个。 */
const projectRoot = (state, turns) => {
  const countOf = (id) => turns.filter((t) => (state.membership[String(t.turn)] ?? []).includes(id)).length
  return Object.keys(state.nodes)
    .filter((id) => state.nodes[id].parents.includes('root') && state.nodes[id].kind !== 'aside')
    .sort((a, b) => countOf(b) - countOf(a))[0]
}

const payload = []
for (const ds of DATASETS) {
  if (!existsSync(path.join(OUTDIR, ds.file))) continue
  const raw = JSON.parse(readFileSync(path.join(OUTDIR, ds.file), 'utf8'))
  const closed = closeUnderAncestors(raw)
  const turns = readTurns(ds.turns)
  const root = projectRoot(raw, turns)
  const countRows = (state) => turns.filter((t) => (state.membership[String(t.turn)] ?? []).includes(root)).length
  const avg = (state) => turns.reduce((s, t) => s + (state.membership[String(t.turn)] ?? []).length, 0) / turns.length
  const full = (state) => turns.filter((t) => (state.membership[String(t.turn)] ?? []).length > 0 &&
    (state.membership[String(t.turn)] ?? []).every((id) => [...(state.nodes[id] ? [] : [])].length === 0 && true)).length
  const shape = attachmentShape(closed, turns.length)
  const spec = mostSpecific(raw)
  payload.push({
    label: ds.label,
    file: ds.file,
    projectTitle: raw.nodes[root]?.title ?? '(无项目根)',
    rawStats: { rootRows: countRows(raw), avg: Number(avg(raw).toFixed(2)), chainRows: attachmentShape(raw, turns.length).chain, closed: isAncestorClosed(raw) },
    closedStats: { rootRows: countRows(closed), avg: Number(avg(closed).toFixed(2)), chainRows: shape.chain, closed: true },
    specificCount: turns.filter((t) => (spec.membership[String(t.turn)] ?? []).length > 0).length,
    turns: turns.map((t) => ({
      turn: t.turn,
      text: t.prompt,
      raw: (raw.membership[String(t.turn)] ?? []).map((id) => raw.nodes[id]?.title ?? id),
      closed: (closed.membership[String(t.turn)] ?? []).map((id) => closed.nodes[id]?.title ?? id),
    })),
    rawRows: treeRows(raw, turns).rows,
    closedRows: treeRows(closed, turns).rows,
    unattached: treeRows(raw, turns).unattached,
  })
}

const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>闭包演示：原样 vs 闭包后</title>
<style>
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body { margin:0; font:14px/1.55 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
         background:#f6f6f8; color:#1c1c1e }
  header { position:sticky; top:0; z-index:20; background:#fff; border-bottom:1px solid #e3e3e8; padding:12px 16px }
  h1 { font-size:15.5px; margin:0 0 3px }
  .sub { color:#6b6b70; font-size:12.5px }
  .sub code { background:#f0f0f5; padding:0 4px; border-radius:4px }
  .controls { display:flex; gap:6px; flex-wrap:wrap; margin-top:9px }
  button { font:inherit; font-size:12.5px; padding:4px 10px; border:1px solid #d3d3da; background:#fff;
           border-radius:999px; cursor:pointer }
  button:hover { border-color:#a9a9b4 }
  button.on { background:#1c1c1e; color:#fff; border-color:#1c1c1e }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:#6b6b70 }
  .key { display:inline-flex; align-items:center; gap:5px }
  .swatch { width:11px; height:11px; border-radius:3px; display:inline-block }
  main { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:14px 16px 96px; align-items:start }
  @media (max-width:940px) { main { grid-template-columns:1fr } }
  .panel { background:#fff; border:1px solid #e3e3e8; border-radius:12px; padding:11px 12px }
  .panel h2 { font-size:13.5px; margin:0 0 4px }
  .stats { color:#6b6b70; font-size:12px; margin-bottom:9px }
  .stats b { color:#1c1c1e }
  .row { display:flex; align-items:flex-start; gap:7px; padding:2.5px 4px; border-radius:7px }
  .row:hover { background:#fafafc }
  .guide { color:#c7c7d1; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; white-space:pre; user-select:none }
  .node { background:#eeeef4; border-radius:7px; padding:1px 7px; white-space:nowrap; font-size:12.5px }
  .node.aside { background:#fff3e2 }
  .node .id { color:#8e8e93; font-size:11px; margin-right:4px }
  .node .badge { font-size:10.5px; color:#9a6b00; margin-left:5px }
  .chips { display:flex; flex-wrap:wrap; gap:3px; padding-top:1px }
  .chip { font-size:11px; padding:0.5px 6px; border-radius:999px; background:#e7efff; color:#1b4b91;
          cursor:pointer; border:1px solid transparent; transition:opacity .12s }
  .chip:hover { border-color:#1b4b91 }
  .chip.added { background:#fff2e2; color:#96500a; border:1px dashed #eab77f }
  .chip.hit { outline:2px solid #1c1c1e; outline-offset:1px }
  .dim { opacity:.3 }
  footer { position:fixed; left:0; right:0; bottom:0; z-index:20; background:#fff; border-top:1px solid #e3e3e8;
           padding:10px 16px; font-size:12.5px; box-shadow:0 -2px 10px rgba(0,0,0,.04) }
  .insp { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap }
  .insp .t { font-weight:600 }
  .insp .a { color:#1b4b91 } .insp .b { color:#96500a }
  .empty { color:#8e8e93; font-size:12.5px; padding:4px }
  @media (prefers-color-scheme: dark) {
    body { background:#17171a; color:#ececf1 }
    header, .panel, footer { background:#1f1f24; border-color:#33333b }
    .node { background:#2a2a31 } .node.aside { background:#3a2f1d }
    .chip { background:#22314d; color:#b8cdf3 } .chip.added { background:#3a2c17; color:#f0c188 }
    .row:hover { background:#232329 } .stats, .sub, .legend { color:#a1a1ab } .stats b { color:#ececf1 }
    button { background:#26262c; color:#ececf1; border-color:#3a3a44 } button.on { background:#ececf1; color:#17171a }
  }
</style>
<header>
  <h1>闭包演示：挂具体节点时，要不要把祖先也一起挂上</h1>
  <div class="sub">左边是模型**原样**给的落点，右边是**闭包后**（每个落点补上它的全部祖先）。
    节点树两边完全一样，差别只在回合标签上：<span class="key"><span class="swatch" style="background:#e7efff"></span>原有落点</span>
    <span class="key"><span class="swatch" style="background:#fff2e2;border:1px dashed #eab77f"></span>闭包新增</span>。
    点任一回合标签，两边同时高亮。</div>
  <div class="controls" id="datasets"></div>
  <div class="legend" id="legend"></div>
</header>
<main>
  <section class="panel">
    <h2>原样（模型给的）</h2>
    <div class="stats" id="statsRaw"></div>
    <div id="treeRaw"></div>
  </section>
  <section class="panel">
    <h2>闭包后（补上全部祖先）</h2>
    <div class="stats" id="statsClosed"></div>
    <div id="treeClosed"></div>
  </section>
</main>
<footer><div class="insp" id="insp">点上面任意一个回合标签 →</div></footer>
<script>
const DATA = ${JSON.stringify(payload)};
let current = 0;
let selected = null;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function chip(turn, added) {
  return '<span class="chip' + (added ? ' added' : '') + '" data-turn="' + turn + '">#' + turn + '</span>';
}

function renderTree(target, rows, d, closedSide) {
  const added = new Set();
  if (closedSide) {
    for (const t of d.turns) for (const title of t.closed) if (t.raw.indexOf(title) < 0) added.add(t.turn);
  }
  target.innerHTML = rows.map((r) => {
    const guide = r.depth === 0 ? '' : '│&nbsp;'.repeat(r.depth - 1) + '├─';
    const badge = r.kind === 'aside' ? '<span class="badge">插话</span>' : '';
    const notes = r.notes.filter((n) => n !== '插话');
    const noteText = notes.length > 0 ? '<span class="badge">' + esc(notes.join(' · ')) + '</span>' : '';
    const chips = r.turns.length === 0
      ? '<span class="empty">（没有回合）</span>'
      : r.turns.map((t) => chip(t, closedSide && added.has(t))).join('');
    return '<div class="row"><span class="guide">' + guide + '</span>' +
      '<span class="node' + (r.kind === 'aside' ? ' aside' : '') + '">' +
      '<span class="id">' + esc(r.id) + '</span>' + esc(r.title) + badge + noteText + '</span>' +
      '<span class="chips">' + chips + '</span></div>';
  }).join('');
}

function stats(d) {
  el('statsRaw').innerHTML = '项目根：<b>' + esc(d.projectTitle) + '</b> · 根收 <b>' + d.rawStats.rootRows +
    '</b> 行 · 平均每回合 <b>' + d.rawStats.avg + '</b> 个落点 · 整链完整的回合 <b>' + d.rawStats.chainRows +
    '</b> · 已全闭：<b>' + (d.rawStats.closed ? '是' : '否') + '</b>';
  el('statsClosed').innerHTML = '项目根：<b>' + esc(d.projectTitle) + '</b> · 根收 <b>' + d.closedStats.rootRows +
    '</b> 行 · 平均每回合 <b>' + d.closedStats.avg + '</b> 个落点 · 整链完整的回合 <b>' + d.closedStats.chainRows +
    '</b> · 已全闭：<b>是</b>';
  const un = d.unattached.length === 0 ? '每一行都有归属' : '没挂任何节点：' + d.unattached.map((t) => '#' + t).join('、');
  el('statsClosed').innerHTML += ' · ' + un;
}

function highlight(turn) {
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.remove('hit');
    c.classList.toggle('dim', turn !== null && Number(c.dataset.turn) !== turn);
  });
  const insp = el('insp');
  if (turn === null) { insp.textContent = '点上面任意一个回合标签 →'; return; }
  const d = DATA[current];
  const t = d.turns.find((x) => x.turn === turn);
  insp.innerHTML = '<span class="t">#' + turn + '</span><span>' + esc(t.text) + '</span>' +
    '<span class="a">原样：' + esc(t.raw.join(' + ') || '（无）') + '</span>' +
    '<span class="b">闭包后：' + esc(t.closed.join(' + ') || '（无）') + '</span>';
  document.querySelectorAll('.chip[data-turn="' + turn + '"]').forEach((c) => c.classList.add('hit'));
}

function show(i) {
  current = i;
  selected = null;
  const d = DATA[i];
  document.querySelectorAll('#datasets button').forEach((b, k) => b.classList.toggle('on', k === i));
  renderTree(el('treeRaw'), d.rawRows, d, false);
  renderTree(el('treeClosed'), d.closedRows, d, true);
  stats(d);
  highlight(null);
}

el('datasets').innerHTML = DATA.map((d, i) => '<button data-i="' + i + '">' + esc(d.label) + '</button>').join('');
el('datasets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
document.addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c === null) return;
  const turn = Number(c.dataset.turn);
  selected = selected === turn ? null : turn;
  highlight(selected);
});
show(0);
</script>
</html>
`

writeFileSync(OUT, html)
console.log(`已写入 ${path.relative(process.cwd(), OUT)}（${(html.length / 1024).toFixed(1)} KB，${payload.length} 个数据集）`)
for (const d of payload) {
  console.log(`  ${d.label}: 根收 ${d.rawStats.rootRows} → ${d.closedStats.rootRows} 行 · 平均落点 ${d.rawStats.avg} → ${d.closedStats.avg} · 整链 ${d.rawStats.chainRows} → ${d.closedStats.chainRows}`)
}
