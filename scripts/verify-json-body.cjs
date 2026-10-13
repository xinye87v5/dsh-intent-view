#!/usr/bin/env node
/**
 * **响应体读取的断言**（`readJsonBody`）：面板不该把浏览器引擎的报错端给使用者。
 *
 * 起因是使用者实测到的一条：
 * `任务结构：这次没算成（JSON.parse: unexpected keyword at line 1 column 1 of the JSON data）`
 * ——那是 Firefox 的 JSON.parse 文案，说明宿主回了一个**非 JSON 响应**（空/HTML），
 * 而面板直接 `response.json()` 把它原样显示了。
 *
 * 放在单独一个文件里是因为这里要 `await`（`readJsonBody` 是 async），
 * 而 `verify-intent-tab.cjs` 是同步 CJS（顶层 await 不合法）。
 */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')

;(async () => {
  // 客户端产物是**内联打包**（以 `window.__ModuleLoader__.load({factory})` 收尾）：
  // 载入方式与 `verify-intent-tab.cjs` 一致——先给一个假的 window，再取 factory 的返回值。
  const loaded = []
  global.window = { __ModuleLoader__: { load: (s) => loaded.push(s) } }
  const req = (id) => {
    if (id === 'react') return require('react')
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    throw new Error('unexpected require: ' + id)
  }
  new Function('require', fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8'))(req)
  const mod = loaded[0].factory(req)
  const read = mod.readJsonBody
  assert.equal(typeof read, 'function', 'readJsonBody 必须导出')

  const blank = await read({ text: async () => '' })
  const html = await read({ text: async () => '<!doctype html><h1>502 Bad Gateway</h1>' })
  const good = await read({ text: async () => '{"ok":true}' })
  const broken = await read({ text: async () => { throw new Error('连接中断') } })

  // 使用者实测的那种：宿主重启后旧页面的请求被认证层挡下，回纯文本 `unauthorized`
  const stale = await read({ status: 401, text: async () => 'unauthorized' })
  const forbidden = await read({ status: 403, text: async () => 'forbidden' })

  const checks = [
    ['401（宿主重启后旧页面的身份过期）⇒ 直接说"刷新页面"',
      typeof stale.error === 'string' && /刷新页面/.test(stale.error) && /401/.test(stale.error), stale.error],
    ['403 同样按身份处理', typeof forbidden.error === 'string' && /403/.test(forbidden.error), forbidden.error],
    ['响应不是 JSON 时给人话（不是 JSON.parse 引擎报错）',
      typeof html.error === 'string' && /不是 JSON/.test(html.error) && !/JSON\.parse/.test(html.error), html.error],
    ['空响应单独说清（宿主重启/被中断）', typeof blank.error === 'string' && /空响应/.test(blank.error), blank.error],
    ['正常 JSON 照样解出来', good.data?.ok === true && good.error === undefined, JSON.stringify(good.data)],
    ['读响应就抛（连接断）也有话说', typeof broken.error === 'string' && /读不出来/.test(broken.error), broken.error],
  ]
  let bad = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
    if (!ok) bad += 1
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`)
  process.exit(bad === 0 ? 0 : 1)
})()
