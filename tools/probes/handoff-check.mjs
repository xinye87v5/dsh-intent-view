#!/usr/bin/env node
/**
 * **交接摘要整条链**的真机检查：进编辑态 → 选中整枝 → 开预览 → 读正文。
 *
 * 为什么单独一支探针：这条链是"点出来"的（编辑态 → 选择器 → 预览），
 * 静态渲染断言进不去这几个状态（`initialEditing`/`initialHandoff` 只能渲染，
 * 点不动按钮），所以只有真浏览器能验"点了之后长什么样"。
 *
 * 用法：`node tools/probes/handoff-check.mjs <url>`
 */
import { spawn } from 'node:child_process'
import { Cdp, SETTLE_MS, findChromium, libDir, waitForEndpoint } from '../../scripts/e2e-panel.mjs'

const url = process.argv[2]
if (!url) {
  console.error('用法: node tools/probes/handoff-check.mjs <url>')
  process.exit(2)
}
const port = 14700 + Math.floor(Math.random() * 300)
const browser = spawn(
  findChromium(),
  ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
   '--window-size=1600,1000', `--remote-debugging-port=${port}`,
   `--user-data-dir=/tmp/dsh-ho-${process.pid}`, 'about:blank'],
  { env: { ...process.env, LD_LIBRARY_PATH: libDir() }, stdio: 'ignore' },
)

const HELPERS = `
  const deep = (selector) => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  };
  const text = (el) => (el.innerText || el.textContent || '').trim();
`

let code = 1
try {
  const ws = new WebSocket(await waitForEndpoint(port, 25_000))
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  const click = (selector) => cdp.evaluate(`(() => {
    ${HELPERS}
    const hit = deep(${JSON.stringify(selector)})[0];
    if (!hit) return { ok: false, selector: ${JSON.stringify(selector)} };
    hit.click();
    return { ok: true, text: text(hit).slice(0, 28) };
  })()`)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // ① 选会话 + 打开主区「意图」
  await cdp.evaluate(`(() => { ${HELPERS} const rows = deep('[role=treeitem]'); (rows[2] ?? rows[1])?.click(); })()`)
  await wait(9000)
  await click('[role=tab]')
  await cdp.evaluate(`(() => {
    ${HELPERS}
    const hit = deep('[role=tab]').find((el) => text(el).includes('意图'));
    if (hit) hit.click();
  })()`)
  await wait(6000)

  /**
   * **等结构就绪**：首次打开一场会话要跑结构流水线（四段 + 增量），
   * 没结构就没有枝可选——第一版没等，换到一场没算完的会话上就"选择器里一个枝都没有"，
   * 看着像功能坏了（其实是测试太急）。
   */
  let ready = false
  for (let i = 0; i < 20; i += 1) {
    ready = await cdp.evaluate(`(() => { ${HELPERS} return deep('[data-intent-outline]').length > 0; })()`)
    if (ready) break
    await wait(3000)
  }
  console.log('① 结构就绪:', ready, ready ? '' : '（这场会话的结构还没算出来——换一场或稍后再跑）')
  if (!ready) {
    ws.close()
    process.exit(3)
  }

  // ② 进编辑态 → 选中整枝 → 开预览
  console.log('② 进编辑态:', JSON.stringify(await click('[data-intent-edit-toggle]')))
  await wait(1500)
  console.log('② 选中整枝…:', JSON.stringify(await click('[data-intent-editbar-branch]')))
  await wait(1200)
  console.log('③ 点第一个枝:', JSON.stringify(await click('[data-intent-branch-option]')))
  await wait(1000)
  console.log('④ 交接摘要:', JSON.stringify(await click('[data-intent-editbar-handoff]')))
  await wait(1800)

  const draft = await cdp.evaluate(`(() => {
    ${HELPERS}
    const box = deep('[data-intent-handoff-text]')[0];
    const panel = deep('[data-intent-handoff]')[0];
    const titles = deep('[data-intent-handoff-titles]')[0];
    return {
      panel: panel ? panel.getAttribute('data-intent-handoff') : null,
      titles: titles ? titles.getAttribute('data-intent-handoff-titles') : null,
      chars: box ? String(box.value ?? '').length : 0,
      text: box ? String(box.value ?? '') : '',
    };
  })()`)
  console.log('⑤ 预览:', JSON.stringify({ 选中回合: draft.panel, 带枝名: draft.titles, 字数: draft.chars }))
  console.log('⑥ 正文:')
  for (const line of String(draft.text).split('\n').slice(0, 14)) console.log('   | ' + line)

  // ⑦ **阶段 2：用模型精炼**（真机读数：耗时 + 精炼后的正文开头）
  console.log('⑦ 用模型精炼:', JSON.stringify(await click('[data-intent-handoff-refine]')))
  await wait(20000)
  const refined = await cdp.evaluate(`(() => {
    ${HELPERS}
    const box = deep('[data-intent-handoff-text]')[0];
    const note = deep('[data-intent-handoff]')[0];
    return {
      text: box ? String(box.value ?? '') : '',
      chars: box ? String(box.value ?? '').length : 0,
      note: (deep('[data-intent-handoff-note]')[0]?.getAttribute('data-intent-handoff-note')) ?? '',
    };
  })()`)
  console.log('⑧ 精炼结果:', JSON.stringify({ 字数: refined.chars, 账: refined.note.slice(0, 70) }))
  for (const line of String(refined.text).split('\n').slice(0, 10)) console.log('   | ' + line)

  if (draft.panel !== null && draft.chars > 100) {
    console.log('\n✓ 交接摘要从选择到预览整条链走通')
    code = 0
  } else {
    console.log('\n✗ 没拿到预览文本——看上面哪一步 ok:false')
  }
  ws.close()
} catch (error) {
  console.error('✗ ' + error.message)
  code = 2
} finally {
  browser.kill('SIGKILL')
}
process.exit(code)
