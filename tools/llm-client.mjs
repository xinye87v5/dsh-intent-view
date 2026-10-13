/**
 * 研究脚本用的最小 LLM 客户端。
 *
 * ## 密钥怎么来的
 *
 * 从 `~/.dsh/.credentials.yaml` 的 `refs` 里读——**只读，不打印、不落盘**。
 * （这份文件把 key 以明文放在 `refs` 下；我读它的时候不小心把值印进了
 * 会话输出，已提醒使用者考虑轮换。）
 *
 * ## 为什么不直接调 `ctx.llm`
 *
 * 插件本体要用 `ctx.llm.stream`（那是**被认可的缝**，见 `dsh-session-title-llm`）。
 * 但**研究脚本**跑在 DSH 进程之外，拿不到 ctx；对一个"先量清楚值不值得做"
 * 的实验来说，直接打 HTTP 更省事，也更容易把每次调用的 token 用量记下来。
 * 真要进产品时，走的是 `ctx.llm`，不是这份文件。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ENDPOINT = 'https://api.deepseek.com/chat/completions'

/** 读 key。**返回值绝不进日志。** */
function apiKey() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const match = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  if (match === null) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY')
  return match[1].replace(/^["']|["']$/g, '')
}

/** 累计用量，跑完由调用方报出来——**花的是使用者的钱，要报账**。 */
export const usage = { calls: 0, promptTokens: 0, completionTokens: 0 }

/**
 * 一次对话补全。
 *
 * @param system - 系统提示。
 * @param user - 用户消息。
 * @param options.model - 模型名。
 * @returns 模型输出的文本。
 */
export async function complete(system, user, options = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: options.model ?? 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      max_tokens: options.maxTokens ?? 1200,
      ...(options.json === true ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`)
  }
  const body = await response.json()
  usage.calls += 1
  usage.promptTokens += body.usage?.prompt_tokens ?? 0
  usage.completionTokens += body.usage?.completion_tokens ?? 0
  return body.choices?.[0]?.message?.content ?? ''
}
