#!/usr/bin/env node
/**
 * 生成 **`research/closure-demo.html`**：用 `graph-view` 的渲染器出图，
 * 把"原样"和"闭包后"两张图并排放进一个自包含页面。
 *
 * 为什么走那条路：`~/graph-view/graphview.py render` 是这个工作区里现成的
 * 出图工具（layered 布局、自包含 HTML、能出 SVG），比我自己手写画布靠谱。
 * 它的渲染器还自带一套现成的视觉约定：
 *
 *   > An inferred edge is drawn dashed and muted.
 *
 * 所以本页把 **模型给的落点记为 `derived`（实线）**、
 * **闭包补出来的祖先边记为 `inferred`（虚线）**——差别一眼可见。
 *
 * 用法：`node tools/probes/build-closure-page.mjs [--run travel-run3]`
 * 先生成 graph JSON（`to-graph-v1.mjs`），再调渲染器，最后内联成一个页面。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const RUN = arg('--run', 'travel-run3')
const TURNS = arg('--turns', `research/${RUN.startsWith('travel') ? 'synthetic-travel' : 'synthetic-fairytale'}.txt`)
const GRAPHVIEW = arg('--graphview', process.env.GRAPHVIEW ?? path.resolve(ROOT, '..', 'graph-view', 'graphview.py'))
const OUTDIR = path.resolve(HERE, '.out', 'graph')
const OUT = path.resolve(ROOT, 'research', `closure-demo-${RUN}.html`)

if (!existsSync(GRAPHVIEW)) throw new Error(`找不到渲染器：${GRAPHVIEW}（用 --graphview 指定）`)
mkdirSync(OUTDIR, { recursive: true })

const variants = [
  { key: 'raw', label: '原样（模型给的落点）', note: '回合只连到它自己给的那些节点。' },
  { key: 'closure', label: '闭包后（每个落点补上全部祖先）', note: '同一条树，回合多出到各级祖先的边（虚线）。' },
]

const built = []
for (const v of variants) {
  const json = path.join(OUTDIR, `${RUN}-${v.key}.json`)
  const svg = path.join(OUTDIR, `${RUN}-${v.key}.svg`)
  const args = ['tools/probes/to-graph-v1.mjs', '--run', RUN, '--turns', path.resolve(ROOT, TURNS)]
  if (v.key === 'closure') args.push('--closure')
  writeFileSync(json, execFileSync(process.execPath, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }))
  const check = execFileSync('python3', [GRAPHVIEW, 'check', json], { encoding: 'utf8' })
  execFileSync('python3', [GRAPHVIEW, 'render', json, '--out', svg], { encoding: 'utf8' })
  const svgText = readFileSync(svg, 'utf8')
  const dims = /width="(\d+)" height="(\d+)"/.exec(svgText)
  const stats = /(\d+) nodes?/.exec(check)
  built.push({ ...v, svg: svgText, json: path.relative(ROOT, json), w: Number(dims[1]), h: Number(dims[2]), check: check.trim().split('\n')[0] })
  console.log(`${v.key}: ${stats ? stats[1] : '?'} 节点 · ${built.at(-1).w}×${built.at(-1).h} · ${path.relative(ROOT, json)}`)
}

const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>闭包演示（graph-view 渲染）</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box }
  body { margin:0; font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
         background:#f6f7f9; color:#15181d }
  header { padding:18px 22px 14px; background:#fff; border-bottom:1px solid #e4e7ec }
  h1 { margin:0 0 6px; font-size:17px }
  p.lead { margin:0 0 10px; color:#4b5563; max-width:76ch }
  .legend { display:flex; gap:18px; flex-wrap:wrap; font-size:12.5px; color:#4b5563 }
  .key { display:inline-flex; align-items:center; gap:7px }
  .solid { width:34px; height:0; border-top:2.2px solid #111827 }
  .dashed { width:34px; height:0; border-top:2.2px dashed #9aa3af }
  .wrap { padding:16px 22px 40px; display:grid; gap:22px }
  section { background:#fff; border:1px solid #e4e7ec; border-radius:12px; overflow:hidden }
  section > h2 { margin:0; padding:12px 16px; font-size:14.5px; border-bottom:1px solid #eef0f4; display:flex;
                 justify-content:space-between; align-items:baseline; gap:12px }
  section > h2 .meta { font-size:12px; color:#6b7280; font-weight:400 }
  section > p { margin:0; padding:10px 16px 0; color:#4b5563; font-size:13px }
  .canvas { overflow:auto; max-height:78vh; padding:12px 16px 18px; background:#fff }
  .canvas svg { display:block }
  footer { padding:0 22px 34px; color:#6b7280; font-size:12.5px }
  code { background:#f0f1f4; padding:0 4px; border-radius:4px }
</style>
<header>
  <h1>“闭包”演示：挂具体节点时，把祖先也一起挂上</h1>
  <p class="lead">图由 <code>graph-view</code> 的渲染器生成（<code>graphview.py render</code>，layered 布局）。
    左边一列是**回合**（按时间顺序），右边各列按**层级深度**排任务节点。
    两张图的任务树完全一样，差别只在**回合连出去的边**。</p>
  <div class="legend">
    <span class="key"><span class="solid"></span>实线 = <code>derived</code>：模型自己给的落点</span>
    <span class="key"><span class="dashed"></span>虚线 = <code>inferred</code>：闭包补出来的祖先边</span>
    <span class="key">彩色边框（warn）= 该节点没收到任何回合</span>
  </div>
</header>
<div class="wrap">
${built.map((b) => `  <section>
    <h2>${b.label}<span class="meta">${b.json} · ${b.w}×${b.h}</span></h2>
    <p>${b.note}</p>
    <div class="canvas">
${b.svg.split('\n').map((l) => '      ' + l).join('\n')}
    </div>
  </section>`).join('\n')}
</div>
<footer>
  重新生成：<code>node tools/probes/build-closure-page.mjs --run ${RUN}</code>　·　
  图 JSON：<code>${built.map((b) => b.json).join('</code>、<code>')}</code><br>
  校验输出：<code>${built[0].check}</code>
</footer>
</html>
`

writeFileSync(OUT, html)
console.log(`已写入 ${path.relative(process.cwd(), OUT)}（${(html.length / 1024).toFixed(1)} KB）`)
