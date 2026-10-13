#!/usr/bin/env node
/**
 * 演示"祖先闭包"做了什么（**离线**，读 `tools/probes/.out/` 里存下的状态）。
 *
 * `node tools/probes/closure-demo.mjs --run travel-run3`
 * `node tools/probes/closure-demo.mjs --prefix travel-run`   对每个运行都比一遍
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { renderTree, closeUnderAncestors, isAncestorClosed, attachmentShape, ancestorsOf } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d }
const TURNS_FILE = arg('--turns', path.resolve(HERE, '..', '..', 'research', 'synthetic-travel.txt'))
const OUTDIR = path.resolve(HERE, '.out')
const all = readFileSync(TURNS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
  .map((l, i) => ({ turn: i + 1, prompt: l.replace(/^\s*#?\d+\s*/, '') }))

const files = (() => {
  const one = arg('--run', '')
  if (one !== '') return [`${one}.json`]
  return readdirSync(OUTDIR).filter((f) => f.startsWith(arg('--prefix', 'travel-run')) && f.endsWith('.json')).sort()
})()

const specific = (state) => Object.fromEntries(Object.entries(state.membership).map(([turn, ids]) => [
  turn,
  ids.filter((id) => !ids.some((o) => o !== id && ancestorsOf(state.nodes, o).has(id))),
]))

for (const file of files) {
  const state = JSON.parse(readFileSync(path.join(OUTDIR, file), 'utf8'))
  const closed = closeUnderAncestors(state)
  const before = attachmentShape(state, all.length)
  const after = attachmentShape(closed, all.length)
  const specSame = JSON.stringify(specific(state)) === JSON.stringify(specific(closed))
  console.log(`\n${'='.repeat(72)}\n${file}：闭包前未闭合=${!isAncestorClosed(state)} → 闭包后未闭合=${!isAncestorClosed(closed)}`)
  console.log(`形状：单链多落点 ${before.chain} → ${after.chain} · 单落点 ${before.single} → ${after.single} · **最具体落点是否变了：${specSame ? '没变' : '变了'}**`)
  console.log(`\n--- 闭包前（只挂具体节点的那些回合，落点里没有祖先）---`)
  console.log(renderTree(state, all).text)
  console.log(`\n--- 闭包后（同样的结构，落点补上了祖先）---`)
  console.log(renderTree(closed, all).text)
  const sample = all.find((t) => {
    const a = state.membership[String(t.turn)] ?? []
    const b = closed.membership[String(t.turn)] ?? []
    return b.length > a.length
  })
  if (sample !== undefined) {
    console.log(`\n举例 #${sample.turn}「${sample.prompt}」`)
    console.log(`  闭包前落点：${(state.membership[String(sample.turn)] ?? []).map((id) => state.nodes[id].title).join(' + ')}`)
    console.log(`  闭包后落点：${(closed.membership[String(sample.turn)] ?? []).map((id) => state.nodes[id].title).join(' + ')}`)
  }
}
