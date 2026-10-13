#!/usr/bin/env node
/**
 * 把 tsc 的 ESM 输出内联并包装成 DSH 浏览器侧能加载的模块格式。
 *
 * ## 为什么是内联
 *
 * DSH 的浏览器侧只认 `window.__ModuleLoader__.load({ id, factory })`，而且
 * **一个包只注册一次**。tsc 输出的是多个 `.js` 文件、每个都有自己的
 * `import` / `export`——所以要把它们内联进**同一个** factory 作用域，
 * 否则会有多次 `load({ id: 同一个 })`，后者覆盖前者。
 *
 * ## 两个集合，两个用途（这是踩出来的）
 *
 * 判环用**祖先链**（`stack`），去重用**已内联集合**（`done`）。
 * 第一版只有一个 `seen` 同时干两件事，于是**菱形依赖被误判成环**：
 *
 *     IntentTab → text
 *     IntentTab → intent → text      ← text 被内联两次，报"循环 import"
 *
 * 菱形不是环。但也不能内联两次——重复的 `const` 声明会抛
 * `SyntaxError: Identifier has already been declared`。两个条件不同，混用必错。
 *
 * ## 只认能安全包装的形状
 *
 * 认不出的 `export` 形状**直接失败**，不猜。理由：漏掉一个 export 的后果是
 * `apply` 不存在，而那时插件静默不加载——比构建期报错难查得多。
 *
 * 用法：
 *     node scripts/wrap-client.mjs [root]
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 入口文件（相对项目根）。 */
const ENTRY = 'lib/client.js'

/**
 * 浏览器侧允许 require 的裸模块。
 *
 * `react` 与 `react/jsx-runtime` 由 DSH 的加载器提供。
 * 这个白名单是**有意的**：每加一个都是一次显式的依赖声明，
 * 而不是"什么都能 require"。
 */
const ALLOWED_REQUIRES = new Set(['react', 'react/jsx-runtime'])

const IMPORT_RE =
  /^import\s+(?:\{\s*(?<named>[^}]*)\s*\}|(?<default>[A-Za-z_$][\w$]*))\s+from\s+'(?<source>[^']+)';$/

/** 函数导出。**必须覆盖 `async function`**——只匹配 `export function` 会把
 *  `export async function` 当成"无法识别的形状"拒绝。它拒绝得对，
 *  但这个列表要覆盖实际用到的全部形状。 */
const EXPORT_PATTERNS = [
  /^export (?:async )?function (\w+)/,
  /^export const (\w+)/,
  /^export let (\w+)/,
]

/** 包装产物开头的标记。用来识别"这份文件已经被包装过了"。 */
const WRAPPED_MARK = 'window.__ModuleLoader__.load'

class WrapperError extends Error {}

/**
 * 按**行**切分，语义与 Python 的 `str.splitlines()` 一致。
 *
 * **这个函数是为了忠实移植而存在的，不是洁癖。**
 * `'a\n'.split('\n')` 在 JS 里给出 `['a', '']`，而 Python 的 `splitlines()`
 * 给出 `['a']`——末尾那个空串是差异的来源。实测后果：内联每个文件的边界处
 * 多出一个空行，1767 行 vs Python 的 1759 行，产物不再逐字一致。
 *
 * 逐字一致是有价值的：它让"移植没改变行为"成为**可验证的断言**，
 * 而不是"我看着差不多"。
 */
function lines(text) {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** 把 `./client/viewer` 解析到磁盘上的 `.js` 文件。 */
function resolveRelative(importer, source) {
  const base = path.join(path.dirname(importer), source)
  // ⚠️ 先试"原样"：共享模块被**两侧**消费——宿主用 Node ESM 直接跑（必须带 `.js`），
  // 客户端走这个包装器。第一版无条件补 `.js`，于是 `./taskGraph.js` 被找成
  // `taskGraph.js.js`、直接判"找不到对应文件"（实测踩到）。
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  throw new WrapperError(
    `${path.basename(importer)}: 相对 import ${JSON.stringify(source)} 找不到对应文件`,
  )
}

/** 裸模块的本地绑定名。`react/jsx-runtime` 不能用带斜杠的名字。 */
function binding(source, names) {
  const local = source.replace(/\W/g, '_')
  if (names.length === 0) return local
  return `{ ${names.join(', ')} }`
}

/**
 * 内联一个文件，返回它的源码行（已去掉 import/export 包装）。
 *
 * @param {string} file 要内联的文件。
 * @param {string[]} stack **当前祖先链**。判环只看它。
 * @param {Set<string>} done 已完整内联过的文件。用于跳过，**不用于判环**。
 * @param {Map<string, string[]>} requires 累积的裸模块 require。
 * @param {string[]} exported 累积的导出名。
 * @returns {string[]} 该文件（及其依赖）的源码行；已内联过则返回空数组。
 * @throws {WrapperError} 循环 import、禁止的裸模块、或无法识别的 export 形状。
 */
function inline(file, stack, done, requires, exported) {
  const resolved = path.resolve(file)
  if (stack.includes(resolved)) {
    const chain = [...stack, resolved].map((p) => path.basename(p, '.js')).join(' → ')
    throw new WrapperError(`循环 import: ${chain}`)
  }
  if (done.has(resolved)) {
    // 已经在别处内联过了：它的函数已在同一作用域里，直接用即可。
    return []
  }
  done.add(resolved)

  const source = readFileSync(file, 'utf8')
  const childStack = [...stack, resolved]
  const deps = []

  for (const line of lines(source)) {
    const match = IMPORT_RE.exec(line)
    if (match === null) continue
    const origin = match.groups.source
    if (origin.startsWith('.')) {
      // **相对模块不允许起别名**：这类 import 行会被整行丢掉，内联进来的函数仍叫原名，
      // 于是别名在浏览器里成了未定义标识符。实测症状：面板整块挂掉、报
      // `taskRenderTree is not defined`，而离线检查（含 check-client）全绿——
      // 因为它只在**真正执行**时才炸。宁可在这里失败，也别放一个运行时炸弹出门。
      if (/\sas\s/.test(match.groups.named ?? '')) {
        throw new WrapperError(
          `${path.basename(file)}: 相对模块不许起别名 —— ${JSON.stringify(origin)} 里的 ` +
            `${JSON.stringify(String(match.groups.named).trim())}。内联后只有原名生效。`,
        )
      }
      // 相对 import：递归内联。它的函数属于**同一个**模块 id，不能各自包一层。
      deps.push(...inline(resolveRelative(file, origin), childStack, done, requires, exported))
      continue
    }
    if (!ALLOWED_REQUIRES.has(origin)) {
      throw new WrapperError(
        `${path.basename(file)}: import ${JSON.stringify(origin)} 不在浏览器侧允许的 require 列表里` +
          `（${[...ALLOWED_REQUIRES].sort().join(', ')}）——DSH 的加载器不提供它`,
      )
    }
    // 记下**要绑定哪些具名导出**，而不是只记模块名。
    // 踩过的坑：`import { useRef } from 'react'` 被转成命名空间绑定之后，
    // 函数体里的 `useRef(...)` 成了未定义标识符——而这只在**真正执行**时才暴露。
    for (const piece of (match.groups.named ?? '').split(',')) {
      const name = piece.trim().split(' as ').pop().trim()
      if (!name) continue
      const names = requires.get(origin) ?? []
      if (!names.includes(name)) names.push(name)
      requires.set(origin, names)
    }
  }

  const body = []
  for (let line of lines(source)) {
    if (IMPORT_RE.test(line)) continue
    for (const pattern of EXPORT_PATTERNS) {
      const found = pattern.exec(line)
      if (found !== null) {
        exported.push(found[1])
        line = line.replace(/^export /, '')
        break
      }
    }
    body.push(line)
  }

  // 检查**已剥离的** body：早先版本检查原始源码，于是每个刚处理过的
  // `export const` 都被报成未处理。
  const leftover = body.join('\n').match(/^export\b.*$/m)
  if (leftover !== null) {
    throw new WrapperError(
      `${path.basename(file)}: 无法识别的 export 形状 ${JSON.stringify(leftover[0].slice(0, 60))}` +
        '——宁可直接失败，也不要漏掉一个 export 让 apply 不存在',
    )
  }
  return [...deps, ...body]
}

/** 内联入口文件并包成 `__ModuleLoader__.load` 调用。 */
function wrap(root, moduleId) {
  const entry = path.join(root, ENTRY)
  if (!existsSync(entry)) throw new WrapperError(`${ENTRY} 不存在——先跑 tsc`)

  // **守卫：拒绝二次包装。**
  //
  // `tsc` 是增量的——**内容未变时它不重写输出文件**。所以连续两次构建时，
  // 第二次的输入是上次**已经包装过**的 `client.js`，于是再包一层。
  //
  // 后果不是报错，而是**两份完整的模块体**塞在一个文件里，导出被后面的块覆盖、
  // 前面那份成为死代码。实测症状是验证脚本报"缺少导出 X"，而那个导出确实在文件里
  // ——只是不在生效的那一份里。**静默通过是这里最坏的结果**，所以直接拒绝。
  const head = readFileSync(entry, 'utf8').slice(0, 400)
  if (head.includes(WRAPPED_MARK)) {
    throw new WrapperError(
      `${ENTRY} 已经被包装过了（tsc 未重写它）。先清掉再构建：` +
        'rm -rf lib && npx tsc -p tsconfig.json && node scripts/wrap-client.mjs',
    )
  }

  const requires = new Map()
  const exported = []
  const body = inline(entry, [], new Set(), requires, exported)

  const leftoverExport = body.join('\n').match(/^export\b.*$/m)
  if (leftoverExport !== null) {
    // 报错要能定位：只说"仍含 export"等于让人去二分查找（这一轮就找了三次）
    throw new WrapperError(`内联后仍含 export 关键字：${JSON.stringify(leftoverExport[0].slice(0, 80))}`)
  }

  const out = [
    '// 由 scripts/wrap-client.mjs 从 tsc 输出内联包装而来。',
    '// 请勿手改；改 src/ 后重新构建（npm run build）。',
    `// 模块 id = package.json 的 name：${moduleId}`,
    'window.__ModuleLoader__.load({',
    `\tid: "${moduleId}",`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '',
  ]
  for (const [origin, names] of requires) {
    // 用 `let` 而非 `const`：与参考实现一致，且解构名可能与内联代码里的
    // 顶层名冲突，`let` 至少会在解析期立刻报错而不是静默遮蔽。
    out.push(`\t\tlet ${binding(origin, names)} = require('${origin}');`)
  }
  out.push('')
  out.push(...body.map((line) => (line.trim() ? `\t\t${line}` : '')))
  out.push('')
  for (const name of exported) out.push(`\t\texports.${name} = ${name};`)
  out.push('\t\treturn module.exports;', '\t}', '});', '')
  return out.join('\n')
}

function main(argv) {
  const root = argv[0] ? path.resolve(argv[0]) : path.resolve(HERE, '..')
  const moduleId = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name

  let wrapped
  try {
    wrapped = wrap(root, moduleId)
  } catch (error) {
    if (error instanceof WrapperError) {
      console.error(`✗ ${error.message}`)
      return 1
    }
    throw error
  }

  const target = path.join(root, ENTRY)
  writeFileSync(target, wrapped, 'utf8')
  console.log(
    `已包装 ${ENTRY}（${wrapped.length} 字符，内联 ${wrapped.split('\n').length} 行）`,
  )

  // viewer.js 已内联，不再是独立模块；留着它会让人以为它是模块入口。
  const viewer = path.join(root, 'lib', 'client', 'viewer.js')
  if (existsSync(viewer)) {
    const head = readFileSync(viewer, 'utf8').split('factory')[0]
    if (head.includes('require(')) {
      console.error('✗ viewer.js 已被包装过，拒绝删除')
      return 1
    }
    unlinkSync(viewer)
    console.log('已移除已内联的 lib/client/viewer.js')
  }
  return 0
}

process.exit(main(process.argv.slice(2)))
