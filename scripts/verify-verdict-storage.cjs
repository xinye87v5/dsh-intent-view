#!/usr/bin/env node
/**
 * 人工修正判定标记的存储与叠加（离线断言）。
 *
 * 这一层决定"人给的结论盖不盖得住模型的"，错法都很安静：
 * 盖反了、串到别的会话、坏数据把整场判定清空——所以四条都要盯。
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const V = await import(path.join(ROOT, 'lib', 'shared', 'verdictStorage.js'));
  const checks = []
  const ok = (name, fn) => {
    try { const d = fn(); checks.push([name, true, typeof d === 'string' ? d : '']); }
    catch (error) { checks.push([name, false, error.message.split('\n')[0].slice(0, 120)]); }
  };
  const mem = () => {
    const map = new Map();
    return {
      map,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
  };

  ok('往返：写进去读出来一样', () => {
    const s = mem();
    const r = V.saveVerdictOverrides(s, 'session-abc', [{ turn: 3, match: false, note: '模型理解错了' }]);
    if (!r.ok) throw new Error(r.reason);
    const got = V.loadVerdictOverrides(s, 'session-abc');
    if (got.length !== 1 || got[0].turn !== 3 || got[0].match !== false || got[0].note !== '模型理解错了') {
      throw new Error(JSON.stringify(got));
    }
    return 'turn=3 match=false';
  });

  ok('同一回合只留最后一条（改两次不堆两条）', () => {
    const s = mem();
    V.saveVerdictOverrides(s, 'session-abc', [{ turn: 3, match: true }, { turn: 3, match: false }]);
    const got = V.loadVerdictOverrides(s, 'session-abc');
    if (got.length !== 1 || got[0].match !== false) throw new Error(JSON.stringify(got));
    return '1 条';
  });

  ok('坏 JSON 当空，不抛', () => {
    const s = mem();
    s.setItem(V.verdictsStorageKey('session-abc'), '{ 不是 JSON');
    if (V.loadVerdictOverrides(s, 'session-abc').length !== 0) throw new Error('没当空');
    return '空';
  });

  ok('非法形状的行被丢掉（turn<1 / match 非布尔）', () => {
    const s = mem();
    s.setItem(V.verdictsStorageKey('session-abc'), JSON.stringify([
      { turn: 0, match: true }, { turn: 2, match: 'false' }, { turn: 4, match: true },
    ]));
    const got = V.loadVerdictOverrides(s, 'session-abc');
    if (got.length !== 1 || got[0].turn !== 4) throw new Error(JSON.stringify(got));
    return '只留 turn=4';
  });

  ok('跨会话不串味', () => {
    const s = mem();
    V.saveVerdictOverrides(s, 'session-a', [{ turn: 1, match: false }]);
    if (V.loadVerdictOverrides(s, 'session-b').length !== 0) throw new Error('串了');
    return '不串';
  });

  ok('会话 id 不合法时拒绝写入（路径穿越也要挡）', () => {
    const s = mem();
    const r = V.saveVerdictOverrides(s, '../etc/passwd', [{ turn: 1, match: false }]);
    if (r.ok !== false || s.map.size !== 0) throw new Error('写进去了');
    return '拒';
  });

  ok('叠加：人给的赢，且标记为人工', () => {
    const model = [
      { turn: 1, match: true, understanding: true, inScope: true, reason: '' },
      { turn: 2, match: false, understanding: false, inScope: true, reason: '用户要X' },
    ];
    const out = V.applyVerdictOverrides(model, [{ turn: 2, match: true, note: '这条我看过，没问题' }]);
    const two = out.find((v) => v.turn === 2);
    if (two.match !== true || two.human !== true || two.note !== '这条我看过，没问题') throw new Error(JSON.stringify(two));
    // 没被人工碰过的那条不能被改动
    const one = out.find((v) => v.turn === 1);
    if (one.match !== true || one.human !== undefined) throw new Error('动了别人');
    return '人赢';
  });

  ok('叠加：人标了但模型没判过的回合也要露出来', () => {
    const out = V.applyVerdictOverrides([{ turn: 1, match: true }], [{ turn: 9, match: false }]);
    if (out.length !== 2 || out.find((v) => v.turn === 9).human !== true) throw new Error(JSON.stringify(out));
    return '露出 turn=9';
  });

  ok('叠加：没有人工覆盖时原样返回（零开销）', () => {
    const model = [{ turn: 1, match: true, reason: '' }];
    const out = V.applyVerdictOverrides(model, []);
    if (out.length !== 1 || out[0].human !== undefined) throw new Error('被动了');
    return '原样';
  });

  let bad = 0;
  ok('人工修正第三问：存得下、取得回', () => {
    const st = mem()
    V.saveVerdictOverrides(st, 'session-a', [{ turn: 3, match: true, parent: 'far' }])
    const back = V.loadVerdictOverrides(st, 'session-a')
    return back.length === 1 && back[0].parent === 'far' && back[0].match === true
  })
  ok('人工修正第三问：脏值丢掉（不吞掉整条）', () => {
    const st = mem()
    st.setItem(V.verdictsStorageKey('session-a'), JSON.stringify([{ turn: 3, match: true, parent: 'maybe' }]))
    const back = V.loadVerdictOverrides(st, 'session-a')
    return back.length === 1 && back[0].parent === undefined
  })
  ok('人工修正第三问：生效时**不动** match（两问口径不受影响）', () => {
    const got = V.applyVerdictOverrides([{ turn: 3, match: false }], [{ turn: 3, match: false, parent: 'near' }])
    return got[0].match === false && got[0].parent === 'near'
  })

  ok('只改父枝：两问结论原样不动（人没有替模型认账）', () => {
    const got = V.applyVerdictOverrides(
      [{ turn: 3, match: false, understanding: false, inScope: true }],
      [{ turn: 3, parent: 'far' }],
    )
    return got[0].match === false && got[0].human === undefined && got[0].humanParent === true && got[0].parent === 'far'
  })
  ok('只改父枝：模型没判过的回合**不会**因此冒出 match', () => {
    const got = V.applyVerdictOverrides([], [{ turn: 3, parent: 'far' }])
    return got.length === 0
  })
  ok('父枝单独可还原（两问的结论留着）', () => {
    const got = V.applyVerdictOverrides(
      [{ turn: 3, match: true }],
      [{ turn: 3, match: false, understanding: false, inScope: true }],
    )
    return got[0].match === false && got[0].parent === undefined && got[0].human === true
  })
  let printed = 0
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) bad += 1;
    printed += 1;
  }
  // **有断言没跑到就必须红**：总数原来按 `checks.length` 报，于是"在打印循环之后才 push"
  // 的断言会静默消失（这一轮就发生了：报 12 条，实际只打 9 条）。没跑 = 没有断言。
  if (printed !== checks.length) {
    console.log(`✗ 有 ${checks.length - printed} 条断言没跑到（push 在打印循环之后？）`);
    bad += 1;
  }
  // **只改第三问不许动两问**（使用者 2026-10-10："人工判定和父枝的调整，好像会冲突
  // 造成选项默认化"）：第一版为了满足 match 必填编了个 `?? true`，
  // 于是没判过的回合被调父枝后从"未判"变成"✓·人"——人替模型认了它没做过的判断。
  // **第三问的人工修正**（与 match 分开存也分开用）
  console.log(`\n${checks.length - bad}/${checks.length} 项通过`);
  process.exit(bad === 0 ? 0 : 1);
})();
