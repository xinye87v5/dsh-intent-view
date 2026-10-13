#!/usr/bin/env node
/**
 * 逐回合判定缓存**落盘**的断言（离线，用临时文件，不碰真实缓存）。
 *
 * 这一层是"新增回合只判变的那几条"的地基，它坏了不会报错、只会让成本悄悄回到
 * "每次重启重判整场"。四条契约各有断言：版本不符当空、坏文件当空、写入尽力而为、
 * 上限按插入顺序丢最旧的。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const store = await import(path.join(ROOT, 'lib', 'host', 'semanticTurnStore.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-store-'));
  const file = path.join(dir, 'nested', 'semantic-turns.json');
  const V = 42;
  const checks = [];
  const ok = (name, cond, detail) => checks.push([name, cond, detail]);

  // ① 往返
  const cache = new Map([['k1', { turn: 1, match: true, reason: '', inScope: true, touched: ['A'] }]]);
  ok('写入成功（目录不存在也能建）', store.saveTurnCache(cache, V, 100, file) === true);
  const loaded = store.loadTurnCache(V, file);
  ok('读回来一模一样（含两问字段）', loaded.size === 1 &&
    loaded.get('k1').inScope === true && loaded.get('k1').touched[0] === 'A');

  // ② 版本不符 ⇒ 整份当空（旧判据的结论不能被当成新判据的）
  ok('判据版本不符时当空', store.loadTurnCache(V + 1, file).size === 0);

  // ③ 坏文件 ⇒ 当空，不抛
  fs.writeFileSync(file, '{ 这不是 JSON');
  ok('坏文件当空且不抛', store.loadTurnCache(V, file).size === 0);

  // ④ 上限：按插入顺序丢最旧的
  const big = new Map();
  for (let i = 1; i <= 20; i += 1) big.set(`k${i}`, { turn: i, match: true, reason: '' });
  store.saveTurnCache(big, V, 5, file);
  const trimmed = store.loadTurnCache(V, file);
  ok('超过上限时只留最近的 N 条', trimmed.size === 5 && trimmed.has('k20') && !trimmed.has('k1'),
    [...trimmed.keys()].join(','));

  // ⑤ 写不进去（路径是文件、不是目录）⇒ 返回 false 而不是抛
  const blocked = path.join(dir, 'semantic-turns.json');
  fs.writeFileSync(blocked, 'x');
  ok('写失败只返回 false，不抛', store.saveTurnCache(cache, V, 5, path.join(blocked, 'sub', 'x.json')) === false);

  // ⑥ 结构缓存落盘（structureStore）：与语义那份同一套契约
  const st = await import(path.join(ROOT, 'lib', 'host', 'structureStore.js'));
  const sfile = path.join(dir, 'structures.json');
  const scache = new Map([['k1', { state: { nodes: {}, membership: {} }, meta: { calls: 1 } }]]);
  ok('结构缓存：写得下、读得回',
    (await st.saveStructureCache(scache, st.STRUCTURE_CACHE_VERSION, 10, sfile)) === true &&
      (await st.loadStructureCache(st.STRUCTURE_CACHE_VERSION, sfile)).get('k1')?.meta?.calls === 1);
  ok('结构缓存：版本不同当空（旧形状不许当新形状用）',
    (await st.loadStructureCache(st.STRUCTURE_CACHE_VERSION + 1, sfile)).size === 0);
  fs.writeFileSync(sfile, '{坏了');
  ok('结构缓存：坏文件当空（不抛）', (await st.loadStructureCache(st.STRUCTURE_CACHE_VERSION, sfile)).size === 0);
  // 上限：写 3 条但只留 2 条（丢最旧的 a）
  const scache3 = new Map([['a', 1], ['b', 2], ['c', 3]]);
  await st.saveStructureCache(scache3, st.STRUCTURE_CACHE_VERSION, 2, sfile);
  const trimmedS = await st.loadStructureCache(st.STRUCTURE_CACHE_VERSION, sfile);
  ok('结构缓存：超过上限丢最旧的', trimmedS.size === 2 && !trimmedS.has('a') && trimmedS.has('c'),
    [...trimmedS.keys()].join(','));
  // B7：淘汰策略（按会话去重 + 最近使用优先），纯函数
  const mkcache = (keys) => new Map(keys.map((k) => [k, { k }]))
  const A = 's1::h1::20::12', A2 = 's1::h2::20::12', B = 's2::h1::20::12', C = 's3::h1::20::12'
  ok('淘汰：每个会话只留最新一条（旧的 contentHash 没有价值）',
    [...st.pruneStructureCache(mkcache([A, B, A2]), { maxTotal: 10 }).keys()].sort().join(',') === [B, A2].sort().join(','),
    [...st.pruneStructureCache(mkcache([A, B, A2]), { maxTotal: 10 }).keys()].join(','));
  ok('淘汰：总量上限按**最近使用**保留（顺序 = Map 插入序）',
    [...st.pruneStructureCache(mkcache([A, B, C]), { maxTotal: 2 }).keys()].join(',') === `${B},${C}`,
    [...st.pruneStructureCache(mkcache([A, B, C]), { maxTotal: 2 }).keys()].join(','));
  ok('淘汰：热点键被重新 set 之后不会被先丢（Map 当 LRU 的用法）',
    (() => {
      const cache = mkcache([A, B, C])
      // 模拟"命中 A"：删了再 set ⇒ 插入序里 A 排到最后
      const hit = cache.get(A)
      cache.delete(A)
      cache.set(A, hit)
      return [...st.pruneStructureCache(cache, { maxTotal: 2 }).keys()].join(',') === `${C},${A}`
    })());
  ok('淘汰：空输入不抛', st.pruneStructureCache(new Map()).size === 0);
  ok('淘汰：同一会话留 2 条时按最近使用取（keepPerSession）',
    [...st.pruneStructureCache(mkcache([A, A2, C]), { keepPerSession: 2, maxTotal: 9 }).keys()].join(',') === `${A},${A2},${C}`,
    [...st.pruneStructureCache(mkcache([A, A2, C]), { keepPerSession: 2, maxTotal: 9 }).keys()].join(','));

  ok('结构缓存：路径不可写只返回 false，不抛',
    (await st.saveStructureCache(scache3, st.STRUCTURE_CACHE_VERSION, 2, path.join(sfile, 'sub', 'x.json'))) === false);

  // ── 并发改造：**结论不变、调用数不变、在飞数受控** ──────────────────────────
  //
  // 语义判定是"12 条一批 × 3 票 × N 批"的独立调用，串行时一场 83 条要两分钟
  // （实测每批 15–22 秒）。并发跑不改材料、不改票数，所以下面这三条是**必须**守住的：
  // 调用数不变（成本不变）、结论不变（识别效果不变）、在飞数不超上限（上游不被打爆）。

  const conc = await import(path.join(ROOT, 'lib', 'shared', 'concurrency.js'));
  const { createLimiter } = conc;

  {
    const limited = createLimiter(3);
    let inFlight = 0; let peak = 0;
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => limited(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 10;
    })));
    ok('闸门：在飞数不超过上限、且真的并发了（peak=1 就等于没并发）', peak <= 3 && peak >= 2, `peak=${peak}`);
    ok('闸门：返回值照常回给各自调用方（顺序由调用方自己保证）',
      JSON.stringify(results) === JSON.stringify([10, 20, 30, 40, 50, 60, 70]), JSON.stringify(results));
    ok('闸门：名额会归还（跑完 7 个之后还能再进 3 个）',
      await (async () => {
        let again = 0;
        await Promise.all([1, 2, 3].map(() => limited(async () => { again += 1; })));
        return again === 3;
      })());
  }
  {
    const limited = createLimiter(2);
    let threw = false;
    try {
      await Promise.all([1, 2, 3].map((n) => limited(async () => { if (n === 2) throw new Error('炸'); return n; })));
    } catch { threw = true; }
    ok('闸门：出错照抛（与串行行为一致）', threw);
  }

  const semantic = await import(path.join(ROOT, 'lib', 'host', 'semanticUnit.js'));
  /** 假 llm：按提示词里列出的回合号回罐头判定，并记在飞峰值与调用数。 */
  function fakeJudgeLlm() {
    const state = { calls: 0, inFlight: 0, peak: 0, batchSizes: [] };
    const stream = (options) => {
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      const turns = [...new Set([...text.matchAll(/^\s+(\d+) \| 节点/gm)].map((m) => Number(m[1])))];
      state.calls += 1;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      state.batchSizes.push(turns.length);
      // **每票给一样的结论**（温度 0 的现实写照）：多数票必须还原出它
      const body = JSON.stringify({
        verdicts: turns.map((t) => ({ turn: t, want: 'w', got: 'g', match: t % 2 === 0, reason: '假', parent: 'near' })),
      });
      return (async function* () {
        try {
          await new Promise((r) => setTimeout(r, 4));
          yield { type: 'block-start', index: 0, blockType: 'text' };
          for (let i = 0; i < body.length; i += 64) yield { type: 'text-delta', index: 0, text: body.slice(i, i + 64) };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        } finally { state.inFlight -= 1; }
      })();
    };
    return { state, stream };
  }
  const targets = (n) => ({
    hash: `h${n}`,
    tasks: ['整理示例资料', '核对示例来源'],
    turns: Array.from({ length: n }, (_, i) => ({
      turn: i + 1, task: (i % 2) + 1, ask: `第 ${i + 1} 件事`, did: '回复', objective: '理解',
    })),
  });
  const runJudge = async (n, concurrency) => {
    process.env.DSH_INTENT_SEMANTIC_CONCURRENCY = String(concurrency);
    process.env.DSH_INTENT_SEMANTIC_CACHE = path.join(dir, `judge-${n}-${concurrency}.json`);
    const llm = fakeJudgeLlm();
    const result = await semantic.judge({ get: (name) => (name === 'llm' ? llm : undefined) }, `s-${n}-${concurrency}`, targets(n));
    return { llm, result };
  };

  {
    ok('并发数：默认 3、可用环境变量调、非法值回落',
      (() => {
        delete process.env.DSH_INTENT_SEMANTIC_CONCURRENCY;
        const d = semantic.semanticConcurrency();
        process.env.DSH_INTENT_SEMANTIC_CONCURRENCY = '5';
        const five = semantic.semanticConcurrency();
        process.env.DSH_INTENT_SEMANTIC_CONCURRENCY = '0';
        const zero = semantic.semanticConcurrency();
        process.env.DSH_INTENT_SEMANTIC_CONCURRENCY = '99';
        const capped = semantic.semanticConcurrency();
        return d === 3 && five === 5 && zero === 3 && capped === 8;
      })());

    const seq = await runJudge(25, 1);
    const par = await runJudge(25, 3);
    const batches = Math.ceil(25 / 12);
    ok('并发：调用数不变（票数 × 批数，成本一分没多）',
      seq.llm.state.calls === batches * 3 && par.llm.state.calls === batches * 3,
      `串行 ${seq.llm.state.calls} · 并发 ${par.llm.state.calls} · 期望 ${batches * 3}`);
    ok('并发：结论与串行**逐条一致**',
      JSON.stringify(seq.result.verdicts) === JSON.stringify(par.result.verdicts),
      `${seq.result.verdicts.length} 条`);
    ok('并发：在飞数不超过上限（并发 3 时 ≤3，且确实并发过）',
      par.llm.state.peak <= 3 && par.llm.state.peak >= 2,
      `peak=${par.llm.state.peak} · 串行 peak=${seq.llm.state.peak}`);
    // 9 次调用 = 3 批 × 3 票；批大小仍是 12/12/1（各出现三票）
    ok('并发：每批的材料条数没变（12 条一批 × 3 票）',
      JSON.stringify(par.llm.state.batchSizes.slice().sort((a, b) => b - a)) ===
        JSON.stringify([12, 12, 12, 12, 12, 12, 1, 1, 1]),
      JSON.stringify(par.llm.state.batchSizes));
  }

  let bad = 0;
  for (const [name, cond, detail] of checks) {
    console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!cond) bad += 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  process.exit(bad === 0 ? 0 : 1);
})();
