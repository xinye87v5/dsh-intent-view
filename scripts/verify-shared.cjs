#!/usr/bin/env node
/**
 * 共享语义（`src/shared/intent.ts` + `src/shared/semantic.ts`）的确定性断言。
 *
 * ## 为什么单独一个文件，而不是并进 `verify-intent-tab.cjs`
 *
 * `verify-intent-tab.cjs` 通过读**包装后的 bundle** 来测客户端半边，
 * 而包装脚本要解析每个 export 的形状——它**拒绝别名 re-export**（正确行为：
 * 认不出来就宁可失败，也不漏掉一个 export 让 `apply` 不存在）。
 *
 * 而这两个模块是**纯函数模块**，能被 Node 直接 import。
 * 所以它们不需要经过 bundle，也就不该为了测试去改包装脚本的规则。
 *
 * ## 这份断言现在盯什么
 *
 * 三块：`goalStatement` 的抽取行为、`shared/semantic.ts` 的指纹与模型输出校验、
 * 以及宿主 fold 对压缩回合的收集（`applyIntent`）。
 *
 * **话题分组与转向的断言已撤**（提交 ④）：那两个函数已从产品侧删除，判据的容器
 * 换成了 DAG 节点。作为这一次的守卫，下面反过来断言**产品侧不再导出**它们——
 * 删掉的东西悄悄回来（哪怕是"顺手再加一个"）同样是语义变成两处的开始。
 * 冻结副本与其交叉校验在 `tools/probes/grouping.mjs` +
 * `tools/probes/grouping-crosscheck.mjs`（不在 build 里，测的是研究侧）。
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const mod = await import(path.join(ROOT, 'lib', 'shared', 'intent.js'));
  // 语义层的纯函数住在另一个共享模块里（宿主与浏览器共用同一份）。
  // 断言把两个模块**合成一个 `mod`**，免得下面的检查写两套前缀。
  // ESM 命名空间对象不可扩展，所以**另起一个名字**取需要的函数，
  // 而不是 `Object.assign` 进 `mod`（那会抛 "object is not extensible"）。
  const semantic = await import(path.join(ROOT, 'lib', 'shared', 'semantic.js'));
  const {
    semanticFingerprint, parseVerdicts, semanticPrompt, majorityVerdicts, VOTES,
    semanticMaterial, semanticKey, semanticTurnKey, planMaterialRequests, shardHash, SEMANTIC_SYSTEM,
  } = semantic;
  const checks = [
    // ── 守卫：产品侧**不再有**分组/转向的语义 ──────────────────────────────
    //
    // 这不是"删除的纪念"，而是防回归：那些函数一旦回来（无论是复制粘贴还是
    // 顺手重写），判据的容器就又有两种可能，而这条会立刻变红。
    [
      '产品侧不再导出分组/转向的语义',
      ['groupTurns', 'groupObjective', 'groupObjectiveIndex', 'findTopicShifts',
       'describeShift', 'overlap', 'localFit', 'reach',
       'SPLIT_AT', 'MAX_GROUP', 'MIN_GROUP', 'LOCAL_FLOOR', 'REACH_FLOOR',
       'SHIFT_WINDOW', 'SHIFT_DROP', 'SHIFT_MIN_TURNS',
      ].every((name) => mod[name] === undefined),
      Object.keys(mod).filter((k) => /group|shift|overlap|localFit|reach/i.test(k)).join(',') || '(只有活的那几个)',
    ],
    [
      '留下的三个还在（bigrams / snippet / goalStatement / BRIEF_PROMPT）',
      typeof mod.bigrams === 'function' &&
        typeof mod.snippet === 'function' &&
        typeof mod.goalStatement === 'function' &&
        mod.BRIEF_PROMPT === 12,
      `BRIEF_PROMPT=${mod.BRIEF_PROMPT}`,
    ],
    // ── `goalStatement`：从思考里抽「agent 把任务理解成了什么」 ─────────────
    //
    // 它只用于**简报回合的显示**（拿它当切分判据已被否掉，见
    // `tools/test-early-reasoning-signal.mjs`）。所以这里测的是**抽取行为**本身：
    // 抽得出、抽不到就别编。抽错的句子会让下游每个数字失去意义。
    [
      '抽得出英文目标句',
      mod.goalStatement(
        'Let me look at the repository. The user asks two things: fix the parser. Then I run it.',
      ) === 'The user asks two things: fix the parser.',
      mod.goalStatement('Let me look at the repository. The user asks two things: fix the parser. Then I run it.'),
    ],
    [
      '抽得出中文目标句',
      mod.goalStatement('先看一下日志。用户要求把压缩点标出来。然后我就动手。') === '用户要求把压缩点标出来。',
      mod.goalStatement('先看一下日志。用户要求把压缩点标出来。然后我就动手。'),
    ],
    // **中文线索第一版漏了 85%**：实测中文思考命中率只有 15%，而英文 60%
    // （`tools/test-language-mixing.mjs`）。漏掉的句式是"用户同意…"、"我需要…"。
    // 这两条断言就是那两个真实样本。
    [
      '抽得出"用户同意…"式的目标句',
      mod.goalStatement(
        '用户同意在画上不加任何文字，并且保留那个犹豫的瞬间。现在我需要把这段内容落实到第09章。',
      ) === '用户同意在画上不加任何文字，并且保留那个犹豫的瞬间。',
      mod.goalStatement('用户同意在画上不加任何文字，并且保留那个犹豫的瞬间。现在我需要把这段内容落实到第09章。'),
    ],
    [
      '抽得出"我需要…"式的目标句',
      mod.goalStatement('先看日志。我需要检查第11章，找出不一致的地方。') === '我需要检查第11章，找出不一致的地方。',
      mod.goalStatement('先看日志。我需要检查第11章，找出不一致的地方。'),
    ],
    [
      '没有线索就不编',
      mod.goalStatement('I will read the file and then run the tests to see what happens next.') === '',
      mod.goalStatement('I will read the file and then run the tests to see what happens next.'),
    ],
    ['空输入不抛', mod.goalStatement('') === '' && mod.goalStatement(undefined) === ''],
    [
      '超长目标句被截断到 STATEMENT_LIMIT',
      mod.goalStatement(`The user wants ${'x'.repeat(500)}`).length === mod.STATEMENT_LIMIT,
      String(mod.goalStatement(`The user wants ${'x'.repeat(500)}`).length),
    ],
    [
      '只取第一句命中线索的话',
      mod.goalStatement('We need to check the build. The user wants a summary.') === 'We need to check the build.',
      mod.goalStatement('We need to check the build. The user wants a summary.'),
    ],
    // ── 语义层（`shared/semantic.ts`）：指纹 + 模型输出校验 ────────────────
    //
    // 这一层**真机上失败过两次**，而两次的症状都是界面上一句"这次没判成"：
    // 一次是模型回了 ```json 围栏（解析直接炸），一次是我把超时当成了挂起。
    // 所以断言要盯的不是"happy path"，而是**坏输入**。
    [
      '指纹：同样输入 → 同样值',
      semanticFingerprint(['甲', '乙'], ['一句', '两句']) ===
        semanticFingerprint(['甲', '乙'], ['一句', '两句']),
    ],
    [
      '指纹：组目标变了 → 值变',
      semanticFingerprint(['甲', '乙'], ['x']) !== semanticFingerprint(['甲', '丙'], ['x']),
    ],
    [
      '指纹：待判文本变了 → 值变',
      semanticFingerprint(['甲'], ['x']) !== semanticFingerprint(['甲'], ['y']),
    ],
    [
      // **顺序必须影响指纹**：组的先后、回合的先后都带信息，换了顺序就是另一段内容。
      // （若指纹对顺序不敏感，内容重排会命中缓存、给出**错位**的判定。）
      '指纹：顺序敏感',
      semanticFingerprint(['甲', '乙'], ['x']) !== semanticFingerprint(['乙', '甲'], ['x']) &&
        semanticFingerprint(['甲'], ['x', 'y']) !== semanticFingerprint(['甲'], ['y', 'x']),
    ],
    [
      '指纹：边界不糊（拼接歧义）',
      // `['ab'] + ['c']` 与 `['a'] + ['bc']` 必须是两个不同的指纹
      semanticFingerprint(['ab'], ['c']) !== semanticFingerprint(['a'], ['bc']),
    ],
    [
      '解析：干净的 JSON',
      (() => {
        const got = parseVerdicts('{"verdicts":[{"turn":3,"match":false,"reason":"换了事"}]}', [3])
        return got.length === 1 && got[0].turn === 3 && got[0].match === false && got[0].reason === '换了事'
      })(),
    ],
    [
      // **真机上就是这么失败的**：模型回 ```json … ```，直接 JSON.parse 炸掉，
      // 而症状只是"没判成"——看起来像模型不行，其实是解析没做干净。
      '解析：剥掉 markdown 围栏',
      (() => {
        const raw = '```json\n{"verdicts":[{"turn":1,"match":true,"reason":""}]}\n```'
        return parseVerdicts(raw, [1]).length === 1
      })(),
    ],
    [
      '解析：前后夹话也能取出来',
      (() => {
        const raw = '好的，结果如下：{"verdicts":[{"turn":2,"match":false,"reason":"r"}]} 以上。'
        const got = parseVerdicts(raw, [2])
        return got.length === 1 && got[0].turn === 2
      })(),
    ],
    [
      // **模型编的回合号会让界面凭空空出一个标记**——这正是要挡的。
      '解析：丢掉不在待判集合里的回合号',
      parseVerdicts('{"verdicts":[{"turn":99,"match":false,"reason":"x"}]}', [1, 2]).length === 0,
    ],
    [
      '解析：match 不是布尔就丢掉',
      parseVerdicts('{"verdicts":[{"turn":1,"match":"false","reason":"x"}]}', [1]).length === 0 &&
        parseVerdicts('{"verdicts":[{"turn":1,"reason":"x"}]}', [1]).length === 0,
    ],
    [
      '解析：理由过长被截断',
      (() => {
        const long = 'x'.repeat(500)
        const got = parseVerdicts(`{"verdicts":[{"turn":1,"match":true,"reason":"${long}"}]}`, [1])
        return got.length === 1 && got[0].reason.length === 120
      })(),
    ],
    [
      // **两问合成一个结论**：理解对但越界 ⇒ 对外那个 `match` 必须是 false。
      // 这条是 C9（使用者标"偏，多余任务"）在代码里的落点。
      '解析：越界（inScope=false）也算偏离，且两问的原始答案都留着',
      (() => {
        const got = parseVerdicts(
          '{"verdicts":[{"turn":3,"want":"拟画","got":"拟画","touched":["画的内容","12章标点"],"match":true,"inScope":false,"reason":"用户只要求拟画，另外动了12章标点"}]}',
          [3],
        )
        return got.length === 1 && got[0].match === false && got[0].understanding === true &&
          got[0].inScope === false && (got[0].touched ?? []).length === 2
      })(),
    ],
    [
      '解析：模型没写 inScope 时视为界内（宁可漏报）',
      (() => {
        const got = parseVerdicts('{"verdicts":[{"turn":1,"match":true,"reason":""}]}', [1])
        return got.length === 1 && got[0].match === true && got[0].inScope === true
      })(),
    ],
    [
      '解析：坏输入不抛，返回空',
      parseVerdicts('完全不是 JSON', [1]).length === 0 &&
        parseVerdicts('', [1]).length === 0 &&
        parseVerdicts('{"verdicts":"不是数组"}', [1]).length === 0 &&
        parseVerdicts(undefined, [1]).length === 0,
    ],
    [
      // 容器已从"话题组"换成**任务节点**；而且（使用者 2026-10-10 裁定之后）
      // 待判行多了**用户这一回合发布的指令**——它是"有没有偏离"的参照物。
      '提示词：节点、用户指令、agent 理解（判它）、回复摘要（佐证）都在',
      (() => {
        const text = semanticPrompt(['个人资料制作：「改一下格式」', '岗位调研：「看看广州的岗位」'], [
          {
            turn: 7, task: 2, ask: '再看看广州的岗位',
            did: '我查了广州的岗位列表，共 12 条。',
            objective: 'The user wants job listings in Guangzhou.',
          },
        ])
        return (
          text.includes('个人资料制作') &&
          text.includes('岗位调研') &&
          // 列序：指令 | **理解（判它）** | 回复摘要（佐证）；
          // 节点后面多了个 `◆第三问` 标记（A5：只有标了的回合才要判第三问）——
          // 这条 fixture 是**小会话**（1 条 ≤ 阈值），所以它该带标记
          text.includes('7 | 节点 2 ◆第三问 | 再看看广州的岗位 | The user wants job listings in Guangzhou. | 我查了广州的岗位列表，共 12 条。')
        )
      })(),
    ],
    [
      // **判据的宗旨不许漂回组口径**：这段话里出现"这一组"就说明材料或措辞又回到了
      // 弃掉的那套（①换容器时 system prompt 就漏改过一次，两处词汇打架）。
      '系统提示词是三问：理解 + 越界 + 归属贴近度（且不许被"回复做了很多事"带跑）',
      /要回答三个问题/.test(SEMANTIC_SYSTEM) &&
        /问题一（理解）/.test(SEMANTIC_SYSTEM) &&
        /问题二（越界）/.test(SEMANTIC_SYSTEM) &&
        // 第三问在，且**明确要求不并进 match**（使用者裁定："结论分开"）
        /问题三（归属贴近度）/.test(SEMANTIC_SYSTEM) &&
        /不要合并进 match/.test(SEMANTIC_SYSTEM) &&
        // 顶层枝的口径：只用大目标判领域，不拿它卡具体操作
        /只判领域/.test(SEMANTIC_SYSTEM) &&
        // **"先写再判"的抓手**：第三问必须先写出父枝目标与本回合在做什么（实测：不加这两样
        // 时 far 召回率在 40%~80% 之间摆动；加了之后连跑三次都是 12/12）
        /parentGoal/.test(SEMANTIC_SYSTEM) && /parentWhat/.test(SEMANTIC_SYSTEM) &&
        !/这一组/.test(SEMANTIC_SYSTEM),
      SEMANTIC_SYSTEM.slice(0, 24),
    ],
    [
      // **材料层不再截断**（截断曾是"后面的回合永不判"的根源）；上限由**分片**保证。
      '材料带全（250 个节点不截断），由分片保证每片在宿主上限内',
      (() => {
        const nodes = {}
        const membership = {}
        const statements = new Map()
        const turnText = new Map()
        for (let i = 1; i <= 250; i += 1) {
          nodes[`n${i}`] = { title: `任务${i}` }
          membership[String(i)] = [`n${i}`]
          statements.set(i, `understanding ${i}`)
          turnText.set(i, `instruction ${i}`)
        }
        const material = semanticMaterial({ nodes, membership }, turnText, statements)
        const shards = planMaterialRequests(material)
        return material.turns.length === 250 && shards.length === 2 &&
          shards.every((shard) => shard.turns.length <= 200 && shard.tasks.length <= 200)
      })(),
    ],
    [
      // 长会话的候选可能远超宿主单次上限 ⇒ 按时间切片，**不重不漏**。
      '分片：1200 条切成 6 片，不重不漏，每片在自己的上限内',
      (() => {
        const nodes = {}
        const membership = {}
        const statements = new Map()
        for (let i = 1; i <= 1200; i += 1) {
          nodes[`n${i}`] = { title: `任务${i}` }
          membership[String(i)] = [`n${i}`]
          statements.set(i, `u${i}`)
        }
        const material = semanticMaterial({ nodes, membership }, new Map(), statements)
        const shards = planMaterialRequests(material)
        const seen = shards.flatMap((shard) => shard.turns.map((t) => t.turn))
        return shards.length === 6 && seen.length === 1200 && new Set(seen).size === 1200 &&
          shards.every((shard) => shard.turns.length <= 200 && shard.tasks.length <= 200) &&
          shards.every((shard) => shard.turns.every((t) => t.task >= 1 && t.task <= shard.tasks.length))
      })(),
    ],
    [
      // **分片指纹必须与整份同构**：第一版拼成 `xxx-123#0`，宿主按形状拒掉每一片，
      // 界面上的表现只是"所有回合都显示未判"（看起来像判据没生效，实际是请求被判非法）。
      '分片指纹形状合法（8 位十六进制-序号）且逐片不同',
      (() => {
        const base = semanticKey({ tasks: ['A：'], turns: [{ turn: 1, task: 1, ask: 'x', did: 'y', objective: '' }] })
        const hashes = [0, 1, 2].map((n) => shardHash(base, n))
        return hashes.every((h) => /^[0-9a-f]{8}-[0-9]+$/.test(h)) &&
          new Set(hashes).size === 3 && hashes[0] === base
      })(),
    ],
    [
      // **只送被判定回合引用到的节点**：这条是 377 回合那场的病根——
      // 旧口径把所有有回合的节点都塞进材料（那场 225 个），宿主按上限 60 拒掉整份请求，
      // 于是面板上的语义核查整块不跑，**越长的会话越不检查**。
      '只送被判定回合引用到的节点（不送整张结构）',
      (() => {
        const nodes = { a: { title: 'A' }, b: { title: 'B' }, c: { title: 'C' } }
        const membership = { 1: ['a'], 2: ['b'], 3: ['c'] }
        // 只有回合 2 有 agent 理解 ⇒ 只该送 B 一个节点
        const material = semanticMaterial({ nodes, membership }, new Map([[2, '看图']]), new Map([[2, '看图']]))
        return material.tasks.length === 1 && material.tasks[0].startsWith('B') &&
          material.turns.length === 1 && material.turns[0].task === 1 && material.turns[0].ask === '看图'
      })(),
    ],
    [
      // 使用者 2026-10-10 裁定：判**简报 / 新增节点 / 压缩过**这三类，
      // 理由是"中间过程是比较难偏移的"。这条盯"新增节点起点"那一类：
      // n2 从回合 10 开始 ⇒ 10 必须进；11 是同一节点的中途实质回合 ⇒ 不进。
      '每个有文本的回合都进材料（含中途的实质回合）',
      (() => {
        const nodes = { n1: { title: 'A' }, n2: { title: 'B' } }
        const membership = { 1: ['n1'], 2: ['n1'], 3: ['n1'], 10: ['n2'], 11: ['n2'] }
        const statements = new Map([1, 2, 3, 10, 11].map((t) => [t, `understanding ${t}`]))
        const turnText = new Map([
          [1, '很长的实质指令：把接口改成批量的，并补测试，别动别的文件'],
          // ⚠️ 这三条必须**够长**：判"简报"看的是 prompt 的二元组数（< 12 即简报）。
          // 我第一版把它们写短了（"继续改测试" = 11 个二元组），于是它们以"简报回合"
          // 的身份合法入选，断言却按"中途实质回合不该入选"去判——**测试搭错了，不是代码错了**。
          [2, '很长的实质指令：继续把测试补完，然后跑一遍全量回归'],
          [3, '很长的实质指令：把回归里的失败用例逐个修掉'],
          [10, '很长的实质指令：现在开始做发布流程的自动化，先写清步骤'],
          [11, '很长的实质指令：继续把发布流程的自动化做完'],
        ])
        const material = semanticMaterial({ nodes, membership }, turnText, statements, [])
        // 使用者要求"每个回合都简单标记" ⇒ 中途的实质回合也要判（以前按成本只判三类）
        const judgedTurns = material.turns.map((t) => t.turn)
        return judgedTurns.includes(10) && judgedTurns.includes(11) && judgedTurns.includes(2) &&
          judgedTurns.length === 5
      })(),
    ],
    [
      '压缩过的回合一定在材料里（不再被 200 条上限挤掉）',
      (() => {
        const nodes = { n1: { title: 'A' } }
        const membership = {}
        const statements = new Map()
        const turnText = new Map()
        // 250 个简报回合 + 1 个压缩过的实质回合：上限 200，压缩那条必须在里面
        for (let i = 1; i <= 250; i += 1) {
          membership[String(i)] = ['n1']
          statements.set(i, `understanding ${i}`)
          turnText.set(i, '继续')
        }
        membership['251'] = ['n1']
        statements.set(251, 'understanding 251')
        turnText.set(251, '很长的实质指令：把发布流程自动化，别动别的文件')
        const material = semanticMaterial({ nodes, membership }, turnText, statements, [251])
        const judged = material.turns.map((t) => t.turn)
        /**
         * 压缩过的回合**一定在材料里**（不再被 200 条上限挤掉——这是截断时代的 bug）。
         * 分片是**按时间**切的，所以它不一定落在第一片：材料的顺序要照顾模型的阅读
         * （时间流），分片失败时由客户端报"第 i/n 片失败"。
         */
        return judged.includes(251) && planMaterialRequests(material).some((shard) => shard.turns.some((t) => t.turn === 251))
      })(),
    ],
    [
      // 使用者："我要的是识别效果，成本为次要" ⇒ 材料必须带上 **agent 实际做了什么**，
      // 否则"理解对了、做错了"这一类看不见。
      '材料带上"agent 实际做了什么"（不只是 agent 的自述）',
      (() => {
        const nodes = { n1: { title: 'A' } }
        const membership = { 1: ['n1'] }
        const material = semanticMaterial(
          { nodes, membership },
          new Map([[1, '继续']]),
          new Map(),                                   // 没有抽到理解
          [],
          new Map([[1, '我把接口改成了批量，并补了两个测试。']]),  // 但有回复
        )
        return material.turns.length === 1 &&
          material.turns[0].did === '我把接口改成了批量，并补了两个测试。' &&
          material.turns[0].objective === ''
      })(),
    ],
    [
      '两个都没有（既没回复也没理解）才判不了',
      (() => {
        const nodes = { n1: { title: 'A' } }
        const membership = { 1: ['n1'] }
        const material = semanticMaterial({ nodes, membership }, new Map([[1, '继续']]), new Map(), [], new Map())
        return material.turns.length === 0
      })(),
    ],
    [
      '上限放宽到 200（识别效果优先）：120 条候选全都进材料',
      (() => {
        const nodes = { n1: { title: 'A' } }
        const membership = {}
        const statements = new Map()
        const turnText = new Map()
        const did = new Map()
        for (let i = 1; i <= 120; i += 1) {
          membership[String(i)] = ['n1']
          statements.set(i, `understanding ${i}`)
          turnText.set(i, '继续')
          did.set(i, `did ${i}`)
        }
        const material = semanticMaterial({ nodes, membership }, turnText, statements, [], did)
        return material.turns.length === 120
      })(),
    ],
    [
      '材料带上"agent 实际做了什么"（不只是 agent 的自述）',
  '两个都没有（既没回复也没理解）才判不了',
  '上限放宽到 200（识别效果优先）：120 条候选全都进材料',
  '问题二要求先列出"动过的对象"（touched）再判界内界外',
  '解析：越界（inScope=false）也算偏离，且两问的原始答案都留着',
  '解析：模型没写 inScope 时视为界内（宁可漏报）',
  '回复摘要被压到 120 字（只作佐证，不许盖过理解）',
  '没有结构 / 没有 agent 理解时不造材料（调用方据此不发请求）',
      semanticMaterial(undefined, new Map(), new Map()).tasks.length === 0 &&
        semanticMaterial({ nodes: { a: { title: 'A' } }, membership: { 1: ['a'] } },
          new Map([[1, '指令']]), new Map()).turns.length === 0,
    ],
    [
      // ── 逐回合缓存键：增量判定的地基 ─────────────────────────────────────
      //
      // 键**只由这一条（指令 + 理解）与它自己那个节点的材料行**决定。
      // 别的回合增删、别的节点改名都不该让它失效——否则"增量"就是空话。
      '逐回合键：同一条 → 同键；自己的指令/理解/节点行变了 → 变',
      (() => {
        const turn = { turn: 5, ask: '继续', did: '我改了接口', objective: 'The user agrees to continue.' }
        const key = semanticTurnKey(turn, '节点A：「x」')
        return (
          semanticTurnKey({ ...turn }, '节点A：「x」') === key &&
          semanticTurnKey({ ...turn, ask: '换个说法' }, '节点A：「x」') !== key &&
          semanticTurnKey({ ...turn, objective: 'another' }, '节点A：「x」') !== key &&
          semanticTurnKey({ ...turn, did: '我去刷了文档' }, '节点A：「x」') !== key &&
          semanticTurnKey(turn, '节点A：「改了样本」') !== key &&
          semanticTurnKey(turn, '节点A：「x」 节点B：「y」') !== key
        )
      })(),
    ],
    [
      // 指令进指纹：把同一句理解配上另一条指令，是**另一个判定**，不该吃缓存。
      '指纹：用户指令变了 → 键变',
      semanticKey({ tasks: ['A：'], turns: [{ turn: 1, task: 1, ask: '甲', objective: 'x' }] }) !==
        semanticKey({ tasks: ['A：'], turns: [{ turn: 1, task: 1, ask: '乙', objective: 'x' }] }),
    ],
    // ── A5：第三问自适应（大会话只对重点回合问）─────────────────────────
    [
      '小会话：每个回合都标"要判第三问"',
      (() => {
        const structure = {
          nodes: { p: { title: '甲', parents: ['root'] }, c: { title: '乙', parents: ['p'] } },
          membership: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(i + 1), ['c']])),
        }
        const text = new Map(Array.from({ length: 5 }, (_, i) => [i + 1, `第${i + 1}件`]))
        const said = new Map(Array.from({ length: 5 }, (_, i) => [i + 1, `理解${i + 1}`]))
        const m = semanticMaterial(structure, text, said)
        return m.turns.length === 5 && m.turns.every((t) => t.askParent === true)
      })(),
    ],
    [
      '大会话：只对重点回合（压缩点 / 新节点起点）标"要判第三问"',
      (() => {
        const n = 80
        const structure = {
          nodes: { p: { title: '甲', parents: ['root'] }, c: { title: '乙', parents: ['p'] } },
          membership: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), ['c']])),
        }
        const text = new Map(Array.from({ length: n }, (_, i) => [i + 1, `第${i + 1}件`]))
        const said = new Map(Array.from({ length: n }, (_, i) => [i + 1, `理解${i + 1}`]))
        // 第 3 回合是压缩点；第 1 回合是节点起点（c 的第一个回合）
        const m = semanticMaterial(structure, text, said, [3])
        const asked = m.turns.filter((t) => t.askParent === true).map((t) => t.turn)
        return m.turns.length === n && asked.includes(1) && asked.includes(3) && asked.length < n
      })(),
    ],
    [
      // ⚠️ 这条**曾经是正向**（"问没问第三问要进键，否则没问的结论会被当成问过的复用"）。
      // 实测证明那个理由不值这个价：键里带 askParent 之后，判定回合数跨过 A5 阈值时
      // 所有非重点回合的键一起翻面 ⇒ **整场重判**，使用者的"之前核查过的成果"没了。
      // 现在改成反向断言，并把取舍写在这里：宁可让第三问略微过时，也不整场重判。
      '第三问的过时是**可接受**的代价（换掉"跨阈值整场重判"）',
      (() => {
        const base = { turn: 1, ask: 'a', objective: 'b', node: 'n1', nodeTitle: 'T' }
        return semanticTurnKey({ ...base, askParent: true }) === semanticTurnKey({ ...base, askParent: false })
      })(),
    ],
    [
      '材料里要标出"要判第三问"（提示词据此省略其它回合的 parent）',
      (() => {
        const structure = {
          nodes: { p: { title: '甲', parents: ['root'] }, c: { title: '乙', parents: ['p'] } },
          membership: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [String(i + 1), ['c']])),
        }
        const text = new Map(Array.from({ length: 80 }, (_, i) => [i + 1, `第${i + 1}件`]))
        const said = new Map(Array.from({ length: 80 }, (_, i) => [i + 1, `理解${i + 1}`]))
        const m = semanticMaterial(structure, text, said, [3])
        const rendered = semanticPrompt(m.tasks, m.turns)
        return rendered.includes('◆第三问') && SEMANTIC_SYSTEM.includes('◆第三问')
      })(),
    ],
    // ── 第三问的参照物：材料里每个节点要带父枝 ──────────────────────────
    [
      '材料：节点行带父枝（第三问的参照物，按节点加一次）',
      (() => {
        const structure = {
          nodes: {
            root: { title: 'root' },
            p: { title: '示例站车次查询', parents: ['root'] },
            c: { title: '核对12306数据', parents: ['p'] },
          },
          membership: { 1: ['c'] },
        }
        const m = semanticMaterial(structure, new Map([[1, '核对一下']]), new Map([[1, '去核对数据']]))
        const line = m.tasks[0]
        return line.includes('（父枝：示例站车次查询）') && line.includes('核对12306数据')
      })(),
    ],
    [
      // 使用者裁定："用大目标检查小操作不妥当，可以只判断领域是否偏移"
      '材料：顶层枝写明"只判领域"（不拿会话大目标卡具体操作）',
      (() => {
        const structure = {
          nodes: { root: { title: 'root' }, p: { title: '示例站车次查询', parents: ['root'] } },
          membership: { 1: ['p'] },
        }
        const m = semanticMaterial(structure, new Map([[1, '查一下']]), new Map([[1, '去查']]))
        return m.tasks[0].includes('（顶层枝：只判领域）')
      })(),
    ],
    [
      // **反向断言**（曾经写反过）：键里**不许**带"会话一动就变"的东西。
      // 带上 parentTitle / askParent 的后果实测到了：定期根裁定改挂顶层、
      // 自适应第三问跨阈值 ⇒ 每动一次整场重判，使用者的"之前核查过的成果"没了。
      '逐回合缓存键：父枝标题 / 是否问第三问**都不进键**（否则整场重判）',
      (() => {
        const base = { turn: 1, ask: 'a', objective: 'b', node: 'n1', nodeTitle: 'T' }
        return (
          semanticTurnKey({ ...base, parentTitle: '甲' }) === semanticTurnKey({ ...base, parentTitle: '乙' }) &&
          semanticTurnKey({ ...base, parentTop: true }) === semanticTurnKey({ ...base, parentTop: false }) &&
          semanticTurnKey({ ...base, askParent: true }) === semanticTurnKey({ ...base, askParent: false })
        )
      })(),
    ],
    [
      '逐回合缓存键：**判据的输入**变了才重算（指令/做了什么/理解/节点身份）',
      (() => {
        const base = { turn: 1, ask: 'a', objective: 'b', node: 'n1', nodeTitle: 'T' }
        const k = (patch) => semanticTurnKey({ ...base, ...patch })
        return (
          k({}) !== k({ ask: '换了指令' }) &&
          k({}) !== k({ did: '换了回复' }) &&
          k({}) !== k({ objective: '换了理解' }) &&
          k({}) !== k({ node: 'n2' }) &&
          k({}) !== k({ nodeTitle: '改了名' }) &&
          k({}) === k({})
        )
      })(),
    ],
    // ── 多数票：单票 18% 会翻面，所以每批 3 票 ──────────────────────────
    ['票数是 3（二值判定下没有平票）', VOTES === 3, String(VOTES)],
    [
      '3 票全说偏离 → 偏离，且票数=3',
      (() => {
        // **三票、每票里都有这三个回合。** 第一版写成"三票各含一个回合"，
        // 于是每个回合只拿到 1 票——**测试搭错了，不是代码错了**。
        const votes = [0, 1, 2].map(() =>
          [1, 2, 3].map((turn) => ({ turn, match: false, reason: `r${turn}` })),
        )
        const got = majorityVerdicts(votes)
        return got.length === 3 && got.every((v) => v.match === false && v.votes === 3 && v.total === 3)
      })(),
    ],
    [
      '2 票偏离 1 票一致 → 仍判偏离，票数=2',
      (() => {
        const got = majorityVerdicts([
          [{ turn: 5, match: false, reason: '偏离' }],
          [{ turn: 5, match: true, reason: '' }],
          [{ turn: 5, match: false, reason: '又偏离' }],
        ])
        return got.length === 1 && got[0].match === false && got[0].votes === 2 && got[0].total === 3
      })(),
    ],
    [
      '1 票偏离 2 票一致 → 判一致，理由清空',
      (() => {
        const got = majorityVerdicts([
          [{ turn: 5, match: false, reason: '偏离' }],
          [{ turn: 5, match: true, reason: '' }],
          [{ turn: 5, match: true, reason: '' }],
        ])
        return got.length === 1 && got[0].match === true && got[0].votes === 2 && got[0].reason === ''
      })(),
    ],
    [
      // **证据不足时不标**：平票（只在丢票时可能出现）判为"一致"。
      // 界面上标"可能偏离"是有代价的（用户会去查），所以拿不准就不标。
      '平票判为一致（拿不准就不标）',
      (() => {
        const got = majorityVerdicts([
          [{ turn: 5, match: false, reason: '偏离' }],
          [{ turn: 5, match: true, reason: '' }],
        ])
        return got.length === 1 && got[0].match === true && got[0].total === 2
      })(),
    ],
    [
      '某票漏掉的回合不进结果（不编）',
      (() => {
        const got = majorityVerdicts([
          [{ turn: 5, match: false, reason: 'x' }],
          [{ turn: 9, match: false, reason: 'y' }],
        ])
        return got.length === 2 && got.every((v) => v.total === 1)
      })(),
    ],
    [
      '结果按回合号升序（界面按序渲染）',
      (() => {
        const got = majorityVerdicts([
          [
            { turn: 9, match: false, reason: 'b' },
            { turn: 2, match: false, reason: 'a' },
          ],
        ])
        return got[0].turn === 2 && got[1].turn === 9
      })(),
    ],
    ['空输入不抛', majorityVerdicts([]).length === 0 && majorityVerdicts([[]]).length === 0],
    // ── 第三问（归属贴近度）：**独立取多数**，且不进 match ────────────────
    [
      '第三问独立取多数（与 match 的多数各算各的）',
      (() => {
        // 两票判"理解偏"（match=false）但都说枝是对的；一票判没跑偏但说挂远了
        const got = majorityVerdicts([
          [
            { turn: 7, match: false, reason: 'x', parent: 'near' },
            { turn: 7, match: false, reason: 'x', parent: 'near' },
            { turn: 7, match: true, reason: '', parent: 'far', parentWhy: '跑到别的项目了' },
          ],
        ])
        // match 走多数（偏），parent 走它自己的多数（near）——两者互不牵制
        return got[0].match === false && got[0].parent === 'near'
      })(),
    ],
    [
      '第三问少数派也能留下（2 票 far / 1 票 near ⇒ far + 依据）',
      (() => {
        const got = majorityVerdicts([
          [
            { turn: 7, match: true, reason: '', parent: 'far', parentWhy: '在改旅游方案' },
            { turn: 7, match: true, reason: '', parent: 'far', parentWhy: '在改旅游方案' },
            { turn: 7, match: true, reason: '', parent: 'near' },
          ],
        ])
        return got[0].parent === 'far' && got[0].parentWhy === '在改旅游方案' && got[0].match === true
      })(),
    ],
    [
      '第三问平票时保守（判 near，不举旗）',
      (() => {
        const got = majorityVerdicts([
          [{ turn: 7, match: true, reason: '', parent: 'far' }],
          [{ turn: 7, match: true, reason: '', parent: 'near' }],
        ])
        return got[0].parent === 'near'
      })(),
    ],
    [
      '模型没写第三问 ⇒ 结论里就没有这一项（不编一个 near 出来）',
      (() => {
        const got = majorityVerdicts([[{ turn: 7, match: true, reason: '' }]])
        return got[0].parent === undefined
      })(),
    ],
    [
      // **判据的抓手**：要求模型先写出"用户要什么 / agent 理解成什么"再判。
      // 实测（f1cd07a6 200 条）：不写对照、且把 agent 回复平权放进去时，
      // 连"指令对调"这种最明显的偏离都只抓到 6%。
      '问题二要求先列出"动过的对象"（touched）再判界内界外',
      /touched/.test(SEMANTIC_SYSTEM) && /必须先列出/.test(SEMANTIC_SYSTEM) &&
        /动过的对象/.test(SEMANTIC_SYSTEM),
    ],
    [
      '回复摘要被压到 120 字（只作佐证，不许盖过理解）',
      (() => {
        const text = semanticPrompt(['甲'], [
          { turn: 1, task: 1, ask: '继续', did: 'd'.repeat(1000), objective: 'u' },
        ])
        const row = text.split('\n').find((line) => line.startsWith('  1 |')) ?? ''
        return row.includes('d'.repeat(120)) && !row.includes('d'.repeat(121))
      })(),
    ],
    [
      '提示词：超长文本被截断（别把调用撑大）',
      (() => {
        const text = semanticPrompt(['甲'], [
          { turn: 1, task: 1, ask: 'a'.repeat(2000), did: 'd'.repeat(2000), objective: 'x'.repeat(2000) },
        ])
        return text.length < 1200
      })(),
    ],
  ];

  // ── 压缩回合：fold 的收集与 wire 的距离计算 ────────────────────────────
  //
  // 压缩回合**从事件流收集**（`compaction/start` 自带 `turn`），不靠外部文件——
  // 因为压缩回合是按会话的，而投影定义是全局注册的。
  const host = await import(path.join(ROOT, 'lib', 'host', 'intentProjection.js'));
  // ── 材料口径（`preview`）────────────────────────────────────────────────
  //
  // 它是 wire 上 `prompt` / `response` 的截断规则，也是**研究探针复刻材料时
  // 唯一该用的那一份**（`tools/probes/structure-via-host.mjs`）。规则本身很短，
  // 但"短"正是它容易被各抄一份的原因——所以这里把它钉住。
  checks.push(
    ['preview：空白折叠成一行', host.preview('a\n\nb\t c', 100) === 'a b c', host.preview('a\n\nb\t c', 100)],
    ['preview：不超限时原样（不补省略号）', host.preview('短', 400) === '短'],
    [
      'preview：超限时截到 limit-1 再补省略号',
      (() => {
        const out = host.preview('x'.repeat(900), 400)
        return out.length === 400 && out.endsWith('…') && !out.slice(0, -1).includes('…')
      })(),
      String(host.preview('x'.repeat(900), 400).length),
    ],
    ['preview：默认上限 = PROMPT_LIMIT 400（wire 的 prompt 口径）', host.preview('y'.repeat(500)).length === 400],
  );
  let state = { turns: [], compactionTurns: [] };
  state = host.applyIntent(state, {
    type: 'compaction/start', seq: 1, data: { compactionId: 'x', turn: 25 },
  });
  state = host.applyIntent(state, {
    type: 'compaction/start', seq: 2, data: { compactionId: 'y', turn: 58 },
  });
  const dup = host.applyIntent(state, {
    type: 'compaction/start', seq: 3, data: { compactionId: 'y', turn: 58 },
  });
  // 名字不能叫 `bad`——下面那个失败计数器用了它。
  const invalidTurn = host.applyIntent(state, {
    type: 'compaction/start', seq: 4, data: { turn: 'x' },
  });
  const later = host.applyIntent(state, { type: 'turn/start', seq: 5, data: {} });

  checks.push(
    ['fold 从事件流收集压缩回合', JSON.stringify(state.compactionTurns) === '[25,58]',
      JSON.stringify(state.compactionTurns)],
    ['重复的压缩回合返回同一引用（零下游工作）', dup === state],
    ['非法 turn 返回同一引用', invalidTurn === state],
    ['turn/start 不丢压缩回合', JSON.stringify(later.compactionTurns) === '[25,58]'],
  );

  // ── 逐回合缓存：把材料切成"复用"与"新判" ──────────────────────────────
  {
    const unit = await import(path.join(ROOT, 'lib', 'host', 'semanticUnit.js'));
    const tasks = ['节点A：「甲」', '节点B：「乙」']
    const turns = [
      { turn: 1, task: 1, ask: '继续', objective: 'u1' },
      { turn: 2, task: 2, ask: '换对象', objective: 'u2' },
      { turn: 3, task: 1, ask: '继续', objective: 'u3' },
    ]
    // 先只把第 2 条放进缓存（键按共享实现算，与宿主同一份）
    const key2 = semanticTurnKey(turns[1], tasks[turns[1].task - 1])
    const cache = new Map([[key2, { turn: 2, match: false, reason: 'r' }]])
    const split = unit.splitByTurnCache(tasks, turns, cache)
    checks.push(
      ['逐回合切分：命中的复用、其余才新判', split.reused.length === 1 && split.missing.length === 2,
        `复用 ${split.reused.length} / 新判 ${split.missing.length}`],
      ['逐回合切分：三条都有键', split.keys.size === 3],
      ['逐回合切分：新判的里不含已缓存那条', !split.missing.some((t) => t.turn === 2)],
      ['结论按回合号升序', JSON.stringify(unit.sortByTurn([{ turn: 9 }, { turn: 2 }]).map((v) => v.turn)) === '[2,9]'],
      [
        '逐回合缓存有上限，满了丢最旧的',
        (() => {
          const small = new Map()
          for (let i = 1; i <= 5001; i += 1) unit.rememberTurn(small, `k${i}`, { turn: i, match: true, reason: '' })
          return small.size === 5000 && !small.has('k1') && small.has('k5001')
        })(),
      ],
    );
  }

  // ── 人工改了落点之后，**只有涉及的回合会被重判** ─────────────────────────
  //
  // 使用者问："可以只判定涉及到修改部分吗？" —— 可以，而且已经是现在的机制：
  // 逐回合键 = 该回合的（指令/理解）+ **它自己那个节点的材料行**。
  // 把一个回合从节点 A 挪到 B ⇒ 只有它的键变；同节点其他回合与别的节点全不变。
  // 这条断言守的就是"改一处不会引发整场重判"。
  {
    const P = await import(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
    const G = await import(path.join(ROOT, 'lib', 'shared', 'taskGraph.js'));
    const nodes = { a: { parents: ['root'], title: '甲任务', kind: 'task' }, b: { parents: ['root'], title: '乙任务', kind: 'task' } };
    const membership = { 1: ['a'], 2: ['a'], 3: ['b'] };
    const turnText = new Map([[1, '把接口改成批量'], [2, '继续'], [3, '看另一个']]);
    const statements = new Map([[1, 'u1'], [2, 'u2'], [3, 'u3']]);
    const before = semanticMaterial({ nodes, membership }, turnText, statements)
    const keysBefore = before.turns.map((t) => semanticTurnKey(t, before.tasks[t.task - 1] ?? ''))
    // 人工把回合 1 从「甲任务」挪到「乙任务」
    const patched = G.applyOverrides({ nodes, membership }, [{ op: 'setPlacement', turn: 1, nodes: ['b'] }]).graph
    const after = semanticMaterial({ nodes: patched.nodes, membership: patched.membership }, turnText, statements)
    const keysAfter = after.turns.map((t) => semanticTurnKey(t, after.tasks[t.task - 1] ?? ''))
    const byTurn = (turns, keys, turn) => keys[turns.findIndex((t) => t.turn === turn)]
    checks.push(
      ['改一处落点：只有那一条的键变了', byTurn(before.turns, keysBefore, 1) !== byTurn(after.turns, keysAfter, 1)],
      ['改一处落点：其余回合的键一个都没变',
        byTurn(before.turns, keysBefore, 2) === byTurn(after.turns, keysAfter, 2) &&
        byTurn(before.turns, keysBefore, 3) === byTurn(after.turns, keysAfter, 3)],
      // ⚠️ 比的是**稳定身份 `node`**，不是位置编号 `task`：挪走一条会让后面的编号整体位移，
      // 于是"编号变了"根本不能说明"这一条换了节点"（我第一版就是这么写错的，断言红了）
      // **移走之后，源节点（母枝）怎么处理**（使用者问："移走的节点，其母枝有没有清理？"）：
      // ① 源节点本身**不自动删**（它是模型建的，也可能是别的回合的落点；删它是显式操作，
      //    放在 B4-2 的"删除节点"里）——这条把行为钉住，免得以后悄悄改成自动删；
      ['移走一条后源节点仍在结构里（不自动删，删除是显式操作）',
        patched.nodes.a !== undefined && patched.membership['1'].join(',') === 'b'],
      // ② 源节点**变成空节点**（把它的回合全挪走）之后，它就不再出现在判定材料里
      //    （材料只带"被引用到的节点"）⇒ 不会有"挂在一个已经没有回合的节点上"的陈旧判定。
      //    ⚠️ 第一版这条断言写错了：我只挪了回合 1，而回合 2 还留在甲任务里，
      //    于是"甲任务"本来就该在材料里——**测试搭错了，不是代码错了**。
      ['源节点变空后不进判定材料（材料只带被引用到的节点）',
        (() => {
          const emptied = G.applyOverrides({ nodes, membership }, [
            { op: 'setPlacement', turn: 1, nodes: ['b'] },
            { op: 'setPlacement', turn: 2, nodes: ['b'] },
          ]).graph
          const m = semanticMaterial({ nodes: emptied.nodes, membership: emptied.membership }, turnText, statements)
          return emptied.nodes.a !== undefined &&
            !m.tasks.some((line) => String(line).startsWith('甲任务')) &&
            m.tasks.some((line) => String(line).startsWith('乙任务'))
        })()],
      ['改一处落点：被挪的回合确实换了节点',
        after.turns.find((t) => t.turn === 1)?.node === 'b' && before.turns.find((t) => t.turn === 1)?.node === 'a'],
    );
  }

  let bad = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) bad += 1;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  return bad === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
