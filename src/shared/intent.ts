/**
 * 意图语义：**纯函数，无 React、无 DOM、无宿主依赖**。
 *
 * ## 为什么单独一层
 *
 * DSH 的官方架构是 **capability-seam three-way split**：领域宿主插件贡献**纯折叠**，
 * 框架拥有订阅与缓存，载体（浏览器）消费快照。
 *
 * 所以语义有且只该有一处实现，而**两侧都要用它**：
 *
 * ```
 * src/host/intentProjection.ts   ← 宿主用它算（authoritative）
 * src/client/**                  ← 浏览器内联它算（因为没有通道回退时仍需可用）
 * ```
 *
 * 放在 `shared/` 而不是任一侧，是因为**放哪一侧都会让另一侧 import 一个"不该存在"的路径**：
 * 宿主 import `client/` 是把 UI 目录当库用；浏览器 import `host/` 更糟。
 *
 * ## 这里还剩什么
 *
 * 只剩三样，都还有活的消费者：
 *
 * - `bigrams` —— 宿主 fold 用它判"这个回合是不是承接/指令"（决定要不要抽 `statement`）；
 * - `goalStatement` —— 从思考里抽出「agent 把任务理解成了什么」；
 * - `snippet` —— 界面上的单行摘要。
 *
 * **话题分组与话题转向曾经也住在这里，已整块删除**（使用者裁定「话题组可以抛弃掉，
 * 只保留 DAG 路线」）：划分表达不了重叠归属，判据的容器与展示的容器都换成了
 * DAG 节点。那套纯函数的**冻结副本**在 `tools/probes/grouping.mjs`，
 * 只为让过去的对照实验可重跑；产品侧不再有第二份语义。
 */

/** 每段文本参与比较的最大字数。 */
export const SAMPLE = 400

const PUNCT = /[\s\u3000·，。、；：！？（）()[\]「」『』《》<>"'`~!@#$%^&*_+=|\\/,.-]+/g

/**
 * 字符二元组。
 *
 * 中文不空格分词，二元组是不引入分词器的最稳做法。标点先剔除，
 * 否则「。」会成为所有文本的公共子串，把重合度整体抬高。
 */
export function bigrams(text: string): Set<string> {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(PUNCT, '')
    .slice(0, SAMPLE)
  const out = new Set<string>()
  for (let i = 0; i < cleaned.length - 1; i += 1) out.add(cleaned.slice(i, i + 2))
  return out
}

/** 单行摘要。投影里的文本本来就带换行，界面里不能有换行。 */
export function snippet(text: string, limit = 80): string {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * prompt 短于这么多二元组，就认为它是**承接/指令**而非展开。
 *
 * 依据：语料里 1116 个回合有 288 个（26%）prompt 短于 12 个二元组，
 * 内容是 `同意`/`继续吧`/`帮我重启`——**承接与指令，不是低信息**。
 * 而且短 prompt 与目标的重合度中位数**反而更高**（0.071 vs 0.059），
 * 所以"短 → 偏离"不只是误判，**方向是反的**。
 *
 * **判定看 prompt 的规模**，不是 `prompt + response`——决定一个回合是
 * "承接/指令"还是"展开"的是**用户说了多少**，不是助手回了多少。
 * （第一版用合并规模，于是 316 个回合里只有 1 个被判"短"。）
 *
 * ⚠️ 弃组之后它只剩**一个**用途：宿主 fold 用它决定"要不要去抽
 * `statement`"（简报回合里用户没说目标，agent 的复述才有价值）。
 * 它**不再随投影发出去**（`brief` 字段已随组口径下线），也**不许**在浏览器里
 * 重算一份——阈值在这里，浏览器再定一个就是"同一语义两处实现"。
 */
export const BRIEF_PROMPT = 12

// ── 从思考里抽出「agent 把任务理解成了什么」 ──────────────────────────────────

/** 目标句的上限。它要能直接显示，不能是一段话。 */
export const STATEMENT_LIMIT = 200

/**
 * 目标线索。**只看明确把"用户要什么"说出来的句式**——宁缺勿滥：
 * 抽错的句子会让每个下游数字失去意义，而"没抽到"只是覆盖率问题，
 * 覆盖率是**如实报出来**的（实测 60%，逐会话 33%–73%）。
 */
const GOAL_CUES = [
  // 英文：把意图归给用户，或第一人称说出目标
  /\bthe user (?:asks|wants|needs|requests|says|is asking|would like|has asked)\b/i,
  /\bthe user (?:agrees|agreed|confirms|confirmed|points? out|noted|mentions?|mentioned|suggests?|suggested|decides?|decided)\b/i,
  /\buser'?s (?:request|goal|intent|ask|instruction|message)\b/i,
  /\bI (?:need|should|have|will need|'ll need) to\b/i,
  /\bwe (?:need|should|have) to\b/i,
  /\bthe (?:task|request|goal) is\b/i,
  /**
   * 中文线索。**第一版只有 `用户(要求|想要|希望|说|问)`，实测漏掉 85% 的中文思考**
   * （中文命中率 15%，英文 60%，见 `tools/test-language-mixing.mjs`）。
   * 漏掉的样本长这样：
   *
   *   「**用户同意**在画上不加任何文字……现在**我需要**把这段内容落实到第09章」
   *   「**用户指出**第11章中存在一个矛盾……**我需要**检查第11章」
   *
   * 句式在，只是词表没覆盖。补齐"把意图归给用户"与"第一人称说出要做的事"两类。
   */
  /用户(?:要求|想要|希望|说|问|同意|指出|强调|确认|决定|提到|建议|反馈|补充|认为|让|叫)/,
  /我(?:需要|要|应该|打算|准备|接下来|现在)/,
  /(?:任务|目标|要求|需求|重点是)/,
]

/**
 * 把一段思考切成句子。
 *
 * **中英的断句规则不一样，这里差点写错**：第一版是
 * `split(/(?<=[.!?。！？])\s+|\n+/)`——要求终止符**后面有空白**。
 * 英文成立，中文不成立（`。`后面通常没有空格），于是整段中文被当成一句话，
 * 目标句直接变成 200 字的整段。断言 `抽得出中文目标句` 抓到了这个。
 *
 * 所以分开处理：`.`/`!`/`?` 后面仍要求空白（否则 `docs/44`、`0.08` 会被劈开），
 * `。！？` 后面**不要求**。
 */
function sentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[。！？])\s*|(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * 抽出目标句：**第一句命中线索的话**。抽不到返回空串。
 *
 * ## 它是什么，不是什么
 *
 * 这是 **agent 对用户要求的复述**，**不是用户说的话**。界面上必须标出来
 * ——本项目对"派生的"与"作者写的"一向分开标注（根节点的 `derived`/`inferred`
 * 就是这个规矩）。
 *
 * 取**第一句**而不是"信息量最大的那句"：位置本身有信息
 * （`research/reasoning-phases.md`：只有靠前的思考在谈目标，前 0.0559
 * 对后 0.0180，错配对照 0.0142）。挑挑拣拣会把这个位置信息丢掉。
 *
 * ⚠️ 思考多数是英文，所以抽出来常常是英文句子（含中文专名）。**不翻译**：
 * 翻译是一层额外的失真，而这里要的是"agent 当时是这么想的"。
 *
 * ## 它测得出来的用处只有一处
 *
 * 用双向重合度（当时 `shared/intent.ts` 还有那个函数，已随分组语义删除）量过：
 * "句子 vs 本回合 prompt"是 `0.0857`，而"句子 vs 别的回合 prompt"是 `0.0202`
 * （4.2 倍）——抽取器有效。
 * （**这个比值可以读**：两边都是"英文/混合句子 vs 中文 prompt"，
 * 跨语言的损耗在分子分母上是一样的。绝对值不可读，见下。）
 *
 * 但**拿它当切分判据被否掉了**（边际 ≤0.012 且安慰剂一样好，见
 * `tools/test-early-reasoning-signal.mjs`）。它站得住的用处是**简报回合**：
 * 用户只说「同意」时，原话没有任何具体指称（产物记号一个都没有），
 * 而这句话是完整的一句。
 *
 * ## ⚠️ 语言：不要拿它和中文文本比字面重合
 *
 * 实测（`tools/test-language-mixing.mjs`，1031 个回合）：思考 **83% 英文、
 * 15% 中英混合、2% 中文**；"复述句 ↔ prompt"的配对里 **93% 是跨语言**的。
 * 字符二元组跨语言**结构性地对不上**，所以：
 *
 * - **同一个句式下的比值**（本段上面那个 4.2 倍、`research/reasoning-phases.md`
 *   里 H1 的前/中/后）可以读——损耗在两边一样；
 * - **两个不同句式的绝对值**不能直接比。我曾用"prompt 与当前组 0.0016 对
 *   复述 0.0186"来论证显示的必要性，**那个数字已撤回**：中文 prompt 与中文组
 *   比、英文复述与中文组比，是两个测量口径。
 * - 真正跨语言的共同通道是**具体产物**（路径 / `#N` / 标识符 / 数字）——
 *   `artifacts()` 那一套。
 *
 * @param reasoning - 一段思考原文（通常取靠前的思考）。
 * @returns 目标句；抽不到时为空串。
 */
export function goalStatement(reasoning: string): string {
  for (const sentence of sentences(reasoning)) {
    for (const cue of GOAL_CUES) {
      if (cue.test(sentence)) return sentence.slice(0, STATEMENT_LIMIT)
    }
  }
  return ''
}
