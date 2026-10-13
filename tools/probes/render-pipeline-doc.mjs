#!/usr/bin/env node
/**
 * 生成 `research/task-dag-pipeline.md`：**散文在模板文件里，提示词从模块注入**。
 *
 * ## 为什么改成这样（这是被自己坑出来的）
 *
 * 前一版把散文写在 JS 模板串里，于是每处反引号都要手工转义。我连续四次
 * 在同一个地方写错（`` `rootSummary()` `` 那种），每次都要等下一步才炸出来；
 * 还有一次把脚本塞进 `bash -c "node -e \"...\""`，反引号被 shell 当成命令替换、
 * 去执行了一个 markdown 文件。
 *
 * 现在散文放在 `pipeline-doc.template.md`（真 markdown，反引号随便写），
 * 这里只做占位符替换——**再没有需要转义的散文**。
 *
 * 用法：
 *   `node tools/probes/render-pipeline-doc.mjs`          写入文档
 *   `node tools/probes/render-pipeline-doc.mjs --check`   只比对（校验脚本用）
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { BUILD_PROMPT, ASSIGN_PROMPT, CONSOLIDATE_PROMPT, ADJUDICATE_PROMPT, SYS } from './pipeline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.resolve(HERE, 'pipeline-doc.template.md')
export const DOC = path.resolve(HERE, '..', '..', 'research', 'task-dag-pipeline.md')

const fence = (text) => ['```text', text, '```'].join('\n')

export function renderDoc() {
  let doc = readFileSync(TEMPLATE, 'utf8')
  const values = {
    BUILD: fence(BUILD_PROMPT),
    ASSIGN: fence(ASSIGN_PROMPT),
    CONSOLIDATE: fence(CONSOLIDATE_PROMPT),
    ADJUDICATE: fence(ADJUDICATE_PROMPT),
    SYS,
  }
  for (const [key, value] of Object.entries(values)) {
    const token = `{{${key}}}`
    if (!doc.includes(token)) throw new Error(`模板里缺占位符 ${token}`)
    doc = doc.split(token).join(value)
  }
  const left = doc.match(/\{\{[A-Z]+\}\}/g)
  if (left !== null) throw new Error(`模板里还有没替换的占位符：${left.join('、')}`)
  return doc
}

/**
 * 只有**直接执行**时才写文件。被 import 时不能有副作用——
 * 否则校验脚本一 import 就把文档重写了，"文档一致"那项检查会永远为真。
 */
const executedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (executedDirectly) {
  const next = renderDoc()
  if (process.argv.includes('--check')) {
    const current = readFileSync(DOC, 'utf8')
    if (current !== next) {
      console.error('research/task-dag-pipeline.md 与模板/模块不一致——重跑 node tools/probes/render-pipeline-doc.mjs')
      process.exit(1)
    }
    console.log('文档与模板一致')
  } else {
    writeFileSync(DOC, next)
    console.log(`已写入 ${path.relative(process.cwd(), DOC)}（${next.length} 字符）`)
  }
}
