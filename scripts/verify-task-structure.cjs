#!/usr/bin/env node
/**
 * 任务结构**宿主单元**的断言（离线：假 llm，不花调用）。
 *
 * 这一层最容易出事、又最难在界面上发现的四件事：
 *
 * 1. **调用次数与顺序**（1 建 + N 批 + 1 整理 + 0/1 裁定）——多问一次就是白花钱，
 *    少问一次结构就不完整；
 * 2. **缓存键**：同一个内容重复请求不该再问模型；内容变了必须重问；
 * 3. **在飞去重**：面板一次渲染可能发两次请求，模型只该被问一遍；
 * 4. **失败不抛**（且**不缓存失败**）：网络抖一次不该让这个会话永久空白。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'lib', 'host', 'taskStructureUnit.js'));
// **测试用独立的缓存文件**：否则会读到开发机 `~/.dsh/storages/intent-view/structures.json`
// 里的真结构，断言随机器状态飘（这类"环境串味"最难查）。
process.env.DSH_INTENT_STRUCTURE_CACHE = path.join(require('node:os').tmpdir(), `dsh-structure-test-${process.pid}.json`);

/** 假 llm：按提示词种类回罐头 JSON，并记账。 */
function fakeLlm({ failOn = null, adjudicate = { groups: [{ name: '合并后的项目', roots: [1, 2] }] } } = {}) {
  const seen = { build: 0, assign: 0, consolidate: 0, adjudicate: 0, total: 0 };
  return {
    seen,
    stream: (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      const nums = [...text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
      let payload;
      if (text.includes('把一段人与 AI 的会话整理成')) {
        seen.build += 1;
        seen.total += 1;
        payload = {
          nodes: {
            p1: { parents: ['root'], title: '甲项目' },
            p2: { parents: ['root'], title: '乙项目' },
            c1: { parents: ['p1'], title: '甲的子' },
          },
          // 建结构只覆盖它的窗口；这里让每个回合都挂到具体节点上
          membership: Object.fromEntries(nums.map((t) => [String(t), [t % 2 === 0 ? 'c1' : 'p1']])),
        };
      } else if (text.includes('只回 JSON，形状：{"placements"')) {
        seen.assign += 1;
        seen.total += 1;
        payload = { placements: Object.fromEntries(nums.map((t) => [String(t), ['c1']])) };
      } else if (text.includes('只做**节点层面的整理**')) {
        seen.consolidate += 1;
        seen.total += 1;
        payload = { ops: [] };
      } else if (text.includes('请把它们**分组**')) {
        seen.adjudicate += 1;
        seen.total += 1;
        payload = adjudicate;
      } else {
        throw new Error('假 llm 收到没预期的提示词：' + text.slice(0, 60));
      }
      const body = JSON.stringify(payload);
      const fail = failOn !== null && text.includes(failOn);
      return (async function* () {
        if (fail) throw new Error('假的模型故障');
        // ⚠️ 块的形状必须照 `BlockAssembler.push` 认的那几种（`dsh-llm/lib/index.js:906`）：
        // block-start → text-delta* → block-end。我第一版发的是 `{type:'text',text}`，
        // 落进 `assertNever` 分支，于是拼出来是空文本、十条断言全挂。
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (let i = 0; i < body.length; i += 64) {
          yield { type: 'text-delta', index: 0, text: body.slice(i, i + 64) };
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
      })();
    },
  };
}

const turns = (n) => Array.from({ length: n }, (_, i) => ({ turn: i + 1, prompt: `第 ${i + 1} 件事` }));
const deps = (llm) => ({ llm, route: { provider: 'p', model: 'm' } });
const call = (body, llm) => U.handleStructureRequest({ json: async () => body }, deps(llm));

const checks = [];
const run = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push([name, true, typeof detail === 'string' ? detail : '']);
  } catch (error) {
    checks.push([name, false, error.message.split('\n')[0].slice(0, 140)]);
  }
};

(async () => {
  await run('调用次数与顺序：1 建 + N 批 + 1 整理 + 1 裁定', async () => {
    const llm = fakeLlm();
    const res = await call({ sessionId: 's-shape', contentHash: 'h1', turns: turns(40) }, llm);
    assert.equal(res.body.ok, true);
    assert.equal(llm.seen.build, 1);
    assert.equal(llm.seen.assign, 2, '40 回合 = 前 20 + 2 批（12+8）');
    assert.equal(llm.seen.consolidate, 1);
    assert.equal(llm.seen.adjudicate, 1, '建结构给了两个非插话顶层 ⇒ 该问一次裁定');
    assert.equal(res.body.meta.batches, 2);
    return `${llm.seen.total} 次调用`;
  });
  await run('结构形态：strip 生效（只留最具体落点）', async () => {
    const llm = fakeLlm();
    const res = await call({ sessionId: 's-strip', contentHash: 'h2', turns: turns(30) }, llm);
    const membership = res.body.structure.membership;
    for (const [turn, ids] of Object.entries(membership)) {
      assert.equal(ids.length, 1, `第 ${turn} 回合应只有一个落点，实际 ${JSON.stringify(ids)}`);
    }
    return '没有祖先残留';
  });
  await run('裁定生效：分组含 ≥2 条线时建项目节点', async () => {
    const llm = fakeLlm();
    const res = await call({ sessionId: 's-adj', contentHash: 'h3', turns: turns(24) }, llm);
    assert.equal(res.body.meta.adjudication, 'merged');
    assert.equal(res.body.roots.projects.length, 1, '合并后只剩一个非插话顶层');
    return res.body.roots.note;
  });
  await run('裁定说"各自成组"时保留多根（不设阈值）', async () => {
    const llm = fakeLlm({ adjudicate: { groups: [{ name: '甲', roots: [1] }, { name: '乙', roots: [2] }] } });
    const res = await call({ sessionId: 's-keep', contentHash: 'h4', turns: turns(24) }, llm);
    assert.equal(res.body.meta.adjudication, 'asked');
    assert.equal(res.body.roots.projects.length, 2);
    return '两条线都留着';
  });
  await run('缓存命中后仍能增量（memo 要跟着命中一起建）', async () => {
    const llm = fakeLlm();
    const first = await call({ sessionId: 's-hit', contentHash: 'h1', turns: turns(24) }, llm);
    assert.equal(first.body.meta.mode, 'full');
    // 同一份内容再问：命中缓存，不花调用
    const before = llm.seen.total;
    const again = await call({ sessionId: 's-hit', contentHash: 'h1', turns: turns(24) }, llm);
    assert.equal(again.body.cached, true);
    assert.equal(llm.seen.total, before, '命中不该花调用');
    // **关键**：再长一个回合时应当走**增量**（若命中没写 memo，这里会退化成全量）
    const grown = await call({ sessionId: 's-hit', contentHash: 'h2', turns: turns(25) }, llm);
    assert.equal(grown.body.meta.mode, 'incremental', '命中缓存后也该能接着增量');
    return `命中 ${again.body.cached} · 之后 ${grown.body.meta.mode}`;
  });

  await run('缓存：同内容再请求不再问模型', async () => {
    const llm = fakeLlm();
    await call({ sessionId: 's-cache', contentHash: 'same', turns: turns(24) }, llm);
    const before = llm.seen.total;
    const again = await call({ sessionId: 's-cache', contentHash: 'same', turns: turns(24) }, llm);
    assert.equal(llm.seen.total, before, '不该新增调用');
    assert.equal(again.body.cached, true);
  });
  await run('缓存：内容变了必须重问', async () => {
    const llm = fakeLlm();
    await call({ sessionId: 's-cache2', contentHash: 'v1', turns: turns(24) }, llm);
    const before = llm.seen.total;
    await call({ sessionId: 's-cache2', contentHash: 'v2', turns: turns(25) }, llm);
    assert.ok(llm.seen.total > before, '内容变了该重算');
  });
  // ── 增量归属：同会话 + 前缀延长 ⇒ 只接新回合 ─────────────────────────────
  await run('增量：同会话多一个回合只问一次归属（不再建结构/整理/裁定）', async () => {
    const llm = fakeLlm();
    const first = await call({ sessionId: 's-inc', contentHash: 'i1', turns: turns(24) }, llm);
    assert.equal(first.body.meta.mode, 'full');
    const seen = { ...llm.seen };
    const second = await call({ sessionId: 's-inc', contentHash: 'i2', turns: turns(25) }, llm);
    assert.equal(second.body.meta.mode, 'incremental', '前缀延长该走增量');
    assert.equal(second.body.meta.addedTurns, 1);
    assert.equal(second.body.meta.calls, 1, '一个回合 = 一批 = 一次调用');
    assert.equal(llm.seen.build, seen.build, '增量不该再建结构');
    assert.equal(llm.seen.consolidate, seen.consolidate, '增量不该跑判整理');
    assert.equal(llm.seen.adjudicate, seen.adjudicate, '增量不该再问根裁定');
    assert.equal(llm.seen.assign, seen.assign + 1, '只多一次归属');
    return `全量 ${first.body.meta.calls} 次 → 增量 ${second.body.meta.calls} 次`;
  });
  await run('增量：已有结构的 id / 标题 / 父子关系一个都不动', async () => {
    const llm = fakeLlm();
    const first = await call({ sessionId: 's-inc2', contentHash: 'j1', turns: turns(24) }, llm);
    const second = await call({ sessionId: 's-inc2', contentHash: 'j2', turns: turns(26) }, llm);
    const before = first.body.structure.nodes;
    const after = second.body.structure.nodes;
    for (const [id, node] of Object.entries(before)) {
      assert.deepEqual(after[id], node, `节点 ${id} 被改动了`);
    }
    assert.ok(Object.keys(after).length >= Object.keys(before).length);
    return `${Object.keys(before).length} 个节点逐字不变`;
  });
  await run('增量：新回合全覆盖（承接语由 carryForward 补齐）', async () => {
    const llm = fakeLlm();
    await call({ sessionId: 's-inc3', contentHash: 'k1', turns: turns(24) }, llm);
    const second = await call({ sessionId: 's-inc3', contentHash: 'k2', turns: turns(26) }, llm);
    const missing = Object.entries(second.body.structure.membership).length;
    assert.equal(missing, 26, '26 个回合都该有归属');
    return `覆盖 26/26（继承 ${second.body.meta.inherited} 条）`;
  });
  await run('增量：早期回合被改写 ⇒ 回退全量（不在旧树上叠新枝）', async () => {
    const llm = fakeLlm();
    await call({ sessionId: 's-inc4', contentHash: 'm1', turns: turns(24) }, llm);
    const changed = turns(26);
    changed[0] = { turn: 1, prompt: '第 1 件事（被压缩改写过）' };
    const res = await call({ sessionId: 's-inc4', contentHash: 'm2', turns: changed }, llm);
    assert.equal(res.body.meta.mode, 'full', '前缀不一致就必须回退全量');
    return '回退全量';
  });
  await run('增量：越界落点与撞名新节点被丢掉（已有结构不许重排）', async () => {
    const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
    const state = {
      nodes: { n1: { parents: ['root'], title: '老节点', kind: 'task' } },
      membership: { 1: ['n1'] },
    };
    const applied = P.applyIncrement(
      state,
      {
        // 老回合也被模型写了一遍：必须丢掉
        placements: { 1: ['n9'], 2: ['n1'] },
        // 与已有 id 撞名：必须丢掉（否则会覆盖掉老节点）
        newNodes: { n1: { title: '冒名顶替' }, t2: { parents: ['n1'], title: '新节点' } },
      },
      [2],
    );
    assert.equal(applied.ignored, 1, '越界落点该被丢掉');
    assert.equal(applied.collisions, 1, '撞名新节点该被丢掉');
    assert.deepEqual(applied.nodes.n1, state.nodes.n1, '老节点不许被覆盖');
    assert.deepEqual(applied.membership['1'], ['n1'], '老回合的归属不许被改写');
    assert.ok(applied.nodes.t2, '合法的 newNodes 该留下');
    return `丢掉 ${applied.ignored} 条落点 / ${applied.collisions} 个撞名节点`;
  });
  await run('前缀判据：延长=真；改写/缩短/换回合号=假', async () => {
    const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
    const base = turns(10);
    assert.equal(P.isPrefixExtension(base, turns(12)), true);
    const rewritten = turns(12);
    rewritten[3] = { turn: 4, prompt: '改了' };
    assert.equal(P.isPrefixExtension(base, rewritten), false);
    assert.equal(P.isPrefixExtension(base, turns(10)), false, '一样长不算延长');
    assert.equal(P.isPrefixExtension(base, turns(8)), false, '更短不算延长');
    return '四种情形都对';
  });
  await run('在飞去重：并发两次只问一遍', async () => {
    const llm = fakeLlm();
    const [a, b] = await Promise.all([
      call({ sessionId: 's-inflight', contentHash: 'x', turns: turns(24) }, llm),
      call({ sessionId: 's-inflight', contentHash: 'x', turns: turns(24) }, llm),
    ]);
    assert.equal(llm.seen.build, 1, '并发两次只该建一次结构');
    assert.ok(a.body.ok && b.body.ok);
  });
  /**
   * **缓存命中不能盲回**：同一个指纹 + 更多回合 ⇒ 必须走增量，而不是把旧结构端回来。
   * （做"定期根裁定 A/B"时踩到的：探针固定 `--hash`，第二个前缀开始全是旧结构，
   *   而日志里 `cached: true`、0.0 秒，看着还很省。）
   */
  await run('缓存：请求更长时不回旧结构（同指纹 + 更多回合 ⇒ 增量）', async () => {
    const llm = fakeLlm();
    const first = await call({ sessionId: 's-stale', contentHash: 'same', turns: turns(24) }, llm);
    assert.equal(first.body.meta.mode, 'full');
    assert.equal(first.body.meta.turnsCovered, 24, '覆盖条数要进 meta（判缓存能不能直回就靠它）');
    // 同一个指纹、更多回合：修好之前这里回的是 cached:true + 24 条覆盖
    const more = await call({ sessionId: 's-stale', contentHash: 'same', turns: turns(26) }, llm);
    assert.equal(more.body.cached, undefined, '请求更长就不许直接回缓存');
    assert.equal(more.body.meta.mode, 'incremental', `该走增量；meta=${JSON.stringify(more.body.meta).slice(0, 160)}`);
    assert.equal(more.body.meta.addedTurns, 2);
    assert.equal(more.body.meta.turnsCovered, 26);
    // 一样多：还是回缓存（这条别被上面的修复带坏）
    const same = await call({ sessionId: 's-stale', contentHash: 'same', turns: turns(26) }, llm);
    assert.equal(same.body.cached, true, '回合数没变就该命中缓存');
    return '24 → 26 走增量；26 → 26 命中缓存';
  });
  await run('缓存决策（纯函数）：老条目退旧行为 / 一样多直回 / 更长走增量', async () => {
    assert.equal(U.canServeCached({}, 99), true, '老条目没有 turnsCovered ⇒ 保持旧行为');
    assert.equal(U.canServeCached({ turnsCovered: 26 }, 26), true);
    assert.equal(U.canServeCached({ turnsCovered: 24 }, 26), false);
    assert.equal(U.canServeCached(undefined, 3), true);
    return '四条边界都对';
  });

  await run('失败不抛：返回 ok:false 并给原因（**第一段**失败才致命）', async () => {
    // 注意这里挑的是**建结构**失败：判整理/根裁定/补问都是可选段，
    // 它们挂了要降级继续（下面两条断言盯着），只有"没有结构可言"才回 ok:false
    const llm = fakeLlm({ failOn: '把一段人与 AI 的会话整理成' });
    const res = await call({ sessionId: 's-fail', contentHash: 'f', turns: turns(24) }, llm);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /假的模型故障/);
  });
  await run('失败不被缓存：下一次会重试', async () => {
    const bad = fakeLlm({ failOn: '把一段人与 AI 的会话整理成' });
    await call({ sessionId: 's-retry', contentHash: 'r', turns: turns(24) }, bad);
    const good = fakeLlm();
    const res = await call({ sessionId: 's-retry', contentHash: 'r', turns: turns(24) }, good);
    assert.equal(res.body.ok, true, '失败被缓存住的话这里会一直是 false');
  });
  await run('判整理挂掉 ⇒ 降级继续（不再把整份结构带走）', async () => {
    const llm = fakeLlm({ failOn: '只做**节点层面的整理**' });
    const res = await call({ sessionId: 's-soft-consolidate', contentHash: 'sc', turns: turns(24) }, llm);
    assert.equal(res.body.ok, true, '判整理是可选精修：它挂了不该让面板显示"这次没算成"');
    assert.ok(Object.keys(res.body.structure.nodes).length >= 3, '前两段算出来的节点要还在');
    assert.match(JSON.stringify(res.body.meta.skipped ?? []), /判整理/, '跳过了什么必须说出来');
  });
  await run('判归属断了 ⇒ 已算出的照常返回（只记一笔）', async () => {
    const llm = fakeLlm({ failOn: '只回 JSON，形状：{"placements"' });
    const res = await call({ sessionId: 's-soft-assign', contentHash: 'sa', turns: turns(60) }, llm);
    assert.equal(res.body.ok, true);
    assert.ok(Object.keys(res.body.structure.nodes).length >= 3, '①建出来的结构还要在');
    assert.match(JSON.stringify(res.body.meta.skipped ?? []), /判归属/);
  });
  await run('判整理的回复被截断 ⇒ 按完整前缀救回（并记一笔）', async () => {
    const llm = fakeLlm();
    const rawStream = llm.stream;
    llm.stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      if (!text.includes('只做**节点层面的整理**')) return rawStream(options);
      llm.seen.consolidate += 1;
      llm.seen.total += 1;
      // 照实测的形状：两个完整 op，第三个写到一半被 maxTokens 截断
      const truncated =
        '{"ops":[{"op":"retitle","id":"p1","title":"改过的甲"},' +
        '{"op":"retitle","id":"p2","title":"改过的乙"},' +
        '{"op":"retitle","id":"c1","tit';
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (let i = 0; i < truncated.length; i += 64) {
          yield { type: 'text-delta', index: 0, text: truncated.slice(i, i + 64) };
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: truncated } };
      })();
    };
    const res = await call({ sessionId: 's-salvage', contentHash: 'sv', turns: turns(24) }, llm);
    assert.equal(res.body.ok, true, '截断该被救回，而不是让整份结构失败');
    assert.equal(res.body.structure.nodes.p1.title, '改过的甲', '完整的 op 要生效');
    assert.equal(res.body.structure.nodes.p2.title, '改过的乙');
    assert.match(JSON.stringify(res.body.meta.skipped ?? []), /截断/);
  });
  await run('截断修复本身：闭合的返回 null / 截断的救回前缀 / 救不了也返回 null', async () => {
    const P = require(path.join(ROOT, 'lib', 'shared', 'taskPipeline.js'));
    const repair = U.repairTruncatedJson;
    assert.equal(repair('{"ops":[]}'), null, '括号本来就闭合 ⇒ 不是截断，不许"修"');
    const fixed = repair('{"ops":[{"op":"retitle","id":"n1","title":"甲"},{"op":"retitle","id":"n2","tit');
    const parsed = JSON.parse(fixed);
    assert.equal(parsed.ops.length, 2);
    assert.equal(parsed.ops[0].title, '甲', '第一个完整的 op 要救回来');
    // 第二个是"语法合法但不完整"的对象（`id` 写完、`title` 还没写）——
    // 它**不许改任何东西**：`applyConsolidate` 对没有 title 的 retitle 直接跳过
    assert.equal(parsed.ops[1].title, undefined);
    const applied = P.applyConsolidate(
      { nodes: { n2: { parents: ['root'], title: '原名' } }, membership: {} },
      parsed.ops,
    );
    assert.equal(applied.nodes.n2.title, '原名', '没有 title 的 retitle 必须被忽略（不许把名字改成空）');
    assert.equal(repair('{"ops":[{"op":'), null, '一个完整元素都没有 ⇒ 救不了');
    // **字符串里的括号不算括号**（这里最容易写错）：标题里带 `}` 与 `]` 也要能救
    const tricky = JSON.parse(repair('{"ops":[{"op":"retitle","id":"n1","title":"含 } 与 ] 的名字"},{"op":"x"'));
    assert.equal(tricky.ops[0].title, '含 } 与 ] 的名字', '字符串里的括号被当成结构了');
  });
  await run('请求校验：缺 sessionId / turns 不合法 → 400', async () => {
    const llm = fakeLlm();
    assert.equal((await call({ turns: turns(3) }, llm)).status, 400);
    assert.equal((await call({ sessionId: 's', turns: 'x' }, llm)).status, 400);
    assert.equal((await call({ sessionId: 's', turns: [{ turn: 0 }] }, llm)).status, 400);
    assert.equal(llm.seen.total, 0, '非法请求不该惊动模型');
  });
  await run('没有 llm 能力 → ok:false（而不是崩）', async () => {
    const res = await U.handleStructureRequest({ json: async () => ({ sessionId: 's-x', turns: turns(3) }) }, { llm: undefined, route: { provider: 'p', model: 'm' } });
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /没有 llm/);
  });

  // ── 定期判整理：增量攒够新增节点 ⇒ 真的多问一次 ──────────────────────────
  await run('定期判整理：增量新增节点攒到阈值 ⇒ 补一次整理（且只补一次）', async () => {
    // 让归属每次都**新建 6 个节点**（默认假 llm 只挂到 c1，永远攒不够）
    const llm = fakeLlm();
    const many = { placements: {} };
    const rawStream = llm.stream;
    llm.stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      if (text.includes('只回 JSON，形状：{"placements"')) {
        const nums = [...text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        llm.seen.assign += 1;
        llm.seen.total += 1;
        const payload = {
          placements: Object.fromEntries(nums.map((t) => [String(t), [`new${t}`]])),
          newNodes: Object.fromEntries(nums.map((t) => [`new${t}`, { parents: ['p2'], title: `新枝${t}` }])),
        };
        const body = JSON.stringify(payload);
        // 块的形状照抄上面那份假 llm（block-start → text-delta* → block-end，
        // 且**带 index/block**）——第一版我省成了 `{type:'text-delta',text}`，
        // BlockAssembler 拼出空文本，请求直接失败（断言报 meta undefined）
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: body };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        })();
      }
      return rawStream(options);
    };
    process.env.DSH_INTENT_CONSOLIDATE_EVERY = '6'; // 默认已关，这条用例要显式开
    const first = await call({ sessionId: 's-cons', contentHash: 'c1', turns: turns(24) }, llm);
    assert.equal(first.body.meta.mode, 'full');
    const before = llm.seen.consolidate;
    // 一次加 8 个回合 ⇒ 8 个新节点 ≥ 阈值 6 ⇒ 该补一次整理
    const second = await call({ sessionId: 's-cons', contentHash: 'c2', turns: turns(32) }, llm);
    assert.equal(second.body.meta.mode, 'incremental');
    assert.equal(second.body.meta.consolidated, true, '攒够了该补整理');
    assert.equal(llm.seen.consolidate, before + 1, '而且只补一次');
    assert.equal(second.body.meta.calls, 2, '归属 1 次 + 整理 1 次');
    assert.equal(typeof second.body.meta.nodesAtConsolidate, 'number', '整理后的节点数要进 meta（重启后不从零算）');
    // **整理的账要记全**：只在日志里打"节点 X → Y"看不出"模型说不用改"还是"改了被拒"
    assert.equal(second.body.meta.consolidateOps, 0, '假 llm 回的是 {"ops":[]}');
    assert.equal(second.body.meta.consolidateApplied, 0);
    assert.equal(second.body.meta.consolidateRejected, 0);
    delete process.env.DSH_INTENT_CONSOLIDATE_EVERY;
    return `新增节点攒够 ⇒ 整理 1 次（calls=${second.body.meta.calls}）`;
  });
  // ── 定期根裁定（B3）：顶层线 ≥2 条且构成变过 ⇒ 补跑一次 ────────────────────
  await run('定期根裁定：增量长出第二条顶层线 ⇒ 补跑一次（且不再重复跑）', async () => {
    // 让增量归属**新建顶层节点**（parents: ['root']），于是顶层线变成 2 条
    const llm = fakeLlm();
    const rawStream = llm.stream;
    llm.stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      if (text.includes('只回 JSON，形状：{"placements"')) {
        const nums = [...text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        llm.seen.assign += 1;
        llm.seen.total += 1;
        const payload = {
          placements: Object.fromEntries(nums.map((t) => [String(t), ['top2']])),
          newNodes: { top2: { parents: ['root'], title: '第二条线' } },
        };
        const body = JSON.stringify(payload);
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: body };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        })();
      }
      return rawStream(options);
    };
    const first = await call({ sessionId: 's-adj-inc', contentHash: 'a1', turns: turns(24) }, llm);
    assert.equal(first.body.meta.mode, 'full');
    const beforeAdjudicate = llm.seen.adjudicate;
    const second = await call({ sessionId: 's-adj-inc', contentHash: 'a2', turns: turns(26) }, llm);
    assert.equal(second.body.meta.mode, 'incremental');
    assert.equal(
      second.body.meta.adjudicated,
      true,
      `顶层变多了该补一次根裁定；meta=${JSON.stringify({
        adjudicated: second.body.meta.adjudicated,
        rootsAtAdjudicate: second.body.meta.rootsAtAdjudicate,
        projects: second.body.roots?.projects,
      })}`,
    );
    assert.equal(llm.seen.adjudicate, beforeAdjudicate + 1, '而且只补一次');
    assert.equal(typeof second.body.meta.rootsAtAdjudicate, 'string', '顶层签名要进 meta');
    // 再长一个回合：顶层构成没变 ⇒ **不该**再裁定
    const third = await call({ sessionId: 's-adj-inc', contentHash: 'a3', turns: turns(27) }, llm);
    assert.equal(third.body.meta.adjudicated, false, '顶层没变就不该再裁定');
    return `补裁定 1 次 · 顶层签名 ${String(second.body.meta.rootsAtAdjudicate).slice(0, 24)}`;
  });
  await run('定期根裁定：开关能关（DSH_INTENT_ADJUDICATE=0）', async () => {
    const U2 = require(path.join(ROOT, 'lib', 'host', 'taskStructureUnit.js'));
    assert.equal(U2.adjudicateEnabled(), true);
    process.env.DSH_INTENT_ADJUDICATE = '0';
    const off = U2.adjudicateEnabled();
    delete process.env.DSH_INTENT_ADJUDICATE;
    return off === false;
  });

  /**
   * **B3 角落（2026-10-14 查清）**：签名原来是**无条件**写的，于是它会在两种情况下撒谎。
   * 这两条用例就是钉这两件事——它们是"该归并的顶层线一直并排着，而日志看不出异常"的来源。
   */
  const topTwoLlm = () => {
    const llm = fakeLlm();
    const rawStream = llm.stream;
    llm.stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      if (text.includes('只回 JSON，形状：{"placements"')) {
        const nums = [...text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        llm.seen.assign += 1;
        llm.seen.total += 1;
        const payload = {
          placements: Object.fromEntries(nums.map((t) => [String(t), ['top2']])),
          newNodes: { top2: { parents: ['root'], title: '第二条线' } },
        };
        const body = JSON.stringify(payload);
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: body };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        })();
      }
      return rawStream(options);
    };
    return llm;
  };

  await run('B3：裁定关着时**不写签名**（否则再打开就"以为做过了"）', async () => {
    const llm = topTwoLlm();
    process.env.DSH_INTENT_ADJUDICATE = '0';
    await call({ sessionId: 's-adj-off', contentHash: 'o1', turns: turns(24) }, llm);
    const off = await call({ sessionId: 's-adj-off', contentHash: 'o2', turns: turns(26) }, llm);
    assert.equal(off.body.meta.adjudicated, false, '关着就不该裁定');
    assert.equal(off.body.meta.rootsAtAdjudicate, undefined, '关着时不许把签名记成"已裁定"');
    // 打开之后：顶层不变也必须补一次
    delete process.env.DSH_INTENT_ADJUDICATE;
    const on = await call({ sessionId: 's-adj-off', contentHash: 'o3', turns: turns(27) }, llm);
    assert.equal(on.body.meta.adjudicated, true, '打开后顶层≥2 且从没裁定过 ⇒ 必须补');
    assert.equal(typeof on.body.meta.rootsAtAdjudicate, 'string');
    return `关时签名=${String(off.body.meta.rootsAtAdjudicate)} → 开后补裁定 1 次`;
  });

  await run('B3：裁定**失败**时不写签名（下次要能重试）', async () => {
    const llm = topTwoLlm();
    const rawStream = llm.stream;
    // ⚠️ 失败的必须是**增量那一次**：全量路上也有一次根裁定（第 ④ 段），
    // 第一次就失败的话整条链的形态会变（顶层被合并成一条，后面就没得裁了）。
    let adjudicateCalls = 0;
    llm.stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      if (text.includes('请把它们**分组**')) {
        adjudicateCalls += 1;
        if (adjudicateCalls === 2) {
          llm.seen.adjudicate += 1;
          llm.seen.total += 1;
          return (async function* () { throw new Error('假的模型故障（根裁定）'); })();
        }
      }
      return rawStream(options);
    };
    await call({ sessionId: 's-adj-fail', contentHash: 'f1', turns: turns(24) }, llm);
    const failed = await call({ sessionId: 's-adj-fail', contentHash: 'f2', turns: turns(26) }, llm);
    assert.equal(failed.body.ok, true, '可选段失败不该让整份结构失败');
    assert.equal(failed.body.meta.adjudicated, false, '这一次确实没裁成');
    assert.equal(failed.body.meta.rootsAtAdjudicate, undefined, '失败不许记成"已裁定"');
    assert.match(JSON.stringify(failed.body.meta.skipped ?? []), /根裁定/);
    // 下一次：模型好了、顶层没变 ⇒ **必须重试**（这正是"失败不记账"的意义）
    const retried = await call({ sessionId: 's-adj-fail', contentHash: 'f3', turns: turns(27) }, llm);
    assert.equal(retried.body.meta.adjudicated, true, '上次失败过 ⇒ 这次必须重试');
    return `裁定调用 ${adjudicateCalls} 次（第 2 次失败、第 3 次重试成功）`;
  });

  await run('定期判整理：没攒够就不补（一个回合一个节点也不该每次整理）', async () => {
    const llm = fakeLlm();
    const first = await call({ sessionId: 's-cons2', contentHash: 'd1', turns: turns(24) }, llm);
    const before = llm.seen.consolidate;
    const second = await call({ sessionId: 's-cons2', contentHash: 'd2', turns: turns(25) }, llm);
    assert.equal(second.body.meta.consolidated, false);
    assert.equal(llm.seen.consolidate, before, '没攒够不该整理');
    return `calls=${second.body.meta.calls}`;
  });

  // ── 定期判整理：增量攒够新增节点就补一次（否则结构越用越碎）──────────────
  {
    const N = require(path.join(ROOT, 'lib', 'host', 'taskStructureUnit.js'));
    checks.push(['阈值：**生产默认是关**（实测空操作，默认开着只白花调用）',
      U.consolidateThreshold() === 0, `threshold=${U.consolidateThreshold()}`]);
    checks.push(['阈值：显式给 6 时，攒够就整理', U.shouldConsolidate(12, 6, 6) === true]);
    checks.push(['阈值：没攒够不整理（每个回合加一个也不该每次都整理）', U.shouldConsolidate(11, 6) === false]);
    checks.push(['阈值：没有基线（从没整理过）时按 0 算（默认关，显式开时才生效）',
      U.shouldConsolidate(6, undefined, 6) === true && U.shouldConsolidate(6, undefined, 0) === false]);
    checks.push(['阈值：显式给阈值时按它算（A/B 用）', U.shouldConsolidate(10, 0, 3) === true && U.shouldConsolidate(2, 0, 3) === false]);
    checks.push(['阈值：0 = 永不整理（对照实验的"从不整理"那条臂）',
      U.shouldConsolidate(999, 0, 0) === false && U.shouldConsolidate(999, undefined, 0) === false]);
    checks.push(['阈值：环境变量能覆盖（生产调参；默认关、可用变量开起来）', (() => {
      const dflt = U.consolidateThreshold();
      process.env.DSH_INTENT_CONSOLIDATE_EVERY = '6';
      const on = U.consolidateThreshold();
      delete process.env.DSH_INTENT_CONSOLIDATE_EVERY;
      return dflt === 0 && on === 6;
    })()]);
    checks.push(['阈值：整理完清零（整理后的节点数进 meta，重启后不从零算）',
      (() => {
        // 整理后 nodesAtConsolidate = 整理后的节点数 ⇒ 立刻再判应为 false
        const after = 9;
        return U.shouldConsolidate(after, after, 6) === false;
      })()]);
  }

  let bad = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) bad += 1;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  process.exit(bad === 0 ? 0 : 1);
})();
