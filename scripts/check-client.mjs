#!/usr/bin/env node
/**
 * 构建期检查：客户端产物与宿主半边的可加载性。
 *
 * 三件事，都是**只有在启动时才会炸**、而报错又指向别处的那一类：
 *
 *   1. **客户端产物必须已包装。** 手动跑一次 `npx tsc` 会把 `lib/client.js`
 *      写回未包装的原始输出，覆盖掉包装产物。症状不是构建报错，而是
 *      **整个客户端 boot 失败**——bundle 里少一个注册，后续模块全部注册不上，
 *      而报的是**别的模块的名字**。
 *
 *   2. **宿主半边的相对导入必须带 `.js` 扩展名且目标存在。**
 *      宿主是纯 ESM 由 Node 直接 import，而 tsc 在 `moduleResolution: bundler`
 *      下不补扩展名。漏了它的后果是整个 `dsh` 启动失败（`ERR_MODULE_NOT_FOUND`）。
 *      客户端半边永远不会暴露这个问题——包装脚本把相对导入内联掉了。
 *
 *   3. **真实产物里的注册逻辑**（交给 `client-harness.cjs`，用真的 react）。
 *
 * 用法：`node scripts/check-client.mjs [root]`
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = path.join(HERE, 'client-harness.cjs')

const WRAP_MARK = 'window.__ModuleLoader__.load'

/** 递归列出目录下的文件（只下探目录，不跟随符号链接环）。 */
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * 宿主半边必须能被 Node **直接 import**。
 *
 * **宿主半边 = `lib/index.js` + `lib/host/**`。** `lib/client.js` 与
 * `lib/client/**` 是客户端产物，会被包装脚本内联成单个 bundle
 * （相对导入随之消失），所以那条路径不适用这条规则。
 *
 * @returns {string[]} 问题清单（空 = 通过）。
 */
function checkHostHalf(root) {
  const problems = []
  const entry = path.join(root, 'lib', 'index.js')
  if (!existsSync(entry)) return ['宿主入口 lib/index.js 不存在']

  const sources = [entry, ...walk(path.join(root, 'lib', 'host')).filter((f) => f.endsWith('.js'))]
  for (const source of sources) {
    const text = readFileSync(source, 'utf8')
    const relative = path.relative(root, source)
    for (const match of text.matchAll(/(?:from|import)\s*['"](\.[^'"]*)['"]/g)) {
      const specifier = match[1]
      if (!specifier.endsWith('.js')) {
        problems.push(`${relative}: 相对导入缺 .js 扩展名 → ${JSON.stringify(specifier)}`)
        continue
      }
      if (!existsSync(path.resolve(path.dirname(source), specifier))) {
        problems.push(`${relative}: 指向不存在的文件 → ${JSON.stringify(specifier)}`)
      }
    }
  }
  return problems
}

function main(argv) {
  const root = argv[0] ? path.resolve(argv[0]) : path.resolve(HERE, '..')

  // ① 客户端产物必须是已包装的。见文件头。
  const entry = path.join(root, 'lib', 'client.js')
  if (!existsSync(entry)) {
    console.error('✗ lib/client.js 不存在——先构建（npm run build）')
    return 2
  }
  if (!readFileSync(entry, 'utf8').slice(0, 400).includes(WRAP_MARK)) {
    console.error('✗ 客户端产物未包装——先跑 node scripts/wrap-client.mjs')
    return 2
  }

  // ② 宿主半边的可加载性。
  const hostProblems = checkHostHalf(root)
  for (const problem of hostProblems) console.log(`✗ 宿主半边: ${problem}`)
  if (hostProblems.length > 0) return 2
  console.log('✓ 宿主半边: 相对导入都带扩展名且目标存在')

  // ③ 真实产物里的注册逻辑。
  const done = spawnSync(process.execPath, [HARNESS, entry], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (done.error) {
    console.error(`✗ 无法运行 harness: ${done.error.message}`)
    return 2
  }
  if (done.status !== 0) {
    console.log(done.stdout?.slice(-2000) ?? '')
    console.error(done.stderr?.slice(-2000) ?? '')
    return 1
  }

  let payload
  try {
    const lines = done.stdout.trim().split('\n')
    payload = JSON.parse(lines[lines.length - 1])
  } catch {
    console.log(done.stdout?.slice(-2000) ?? '')
    console.error('✗ 无法解析测试输出')
    return 1
  }

  let failed = 0
  for (const item of payload.checks) {
    const detail = item.detail ? `  (${item.detail})` : ''
    console.log(`  ${item.ok ? '✓' : '✗'} ${item.name}${detail}`)
    if (!item.ok) failed += 1
  }
  if (payload.error) console.error(`\n执行期错误:\n${payload.error}`)

  console.log()
  console.log(`${payload.checks.length - failed}/${payload.checks.length} 项通过`)
  return failed === 0 ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
