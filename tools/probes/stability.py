"""在插件自己的路径上量多票之后的重测一致性。材料来自 `tools/probes/pick.mjs` 生成的 `.out/material.json`（离线构建，不花模型钱）。"""
import sys, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
MATERIAL = os.path.join(HERE, '.out', 'material.json')
MATERIAL_SHUFFLED = os.path.join(HERE, '.out', 'material-shuffled.json')
from playwright.sync_api import sync_playwright

ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 5
material = json.load(open(MATERIAL))
print(f"会话 {material['id'][8:16]} · 组 {len(material['groups'])} · 待判 {len(material['turns'])} 条 · 重复 {ROUNDS} 次")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True,
        executable_path=os.environ.get("DSH_CHROMIUM", "chromium"),
        args=["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--window-size=1600,1000"],
        env={"LD_LIBRARY_PATH":"/tmp/chlibs"})
    pg = b.new_page(viewport={"width":1600,"height":1000})
    pg.goto(sys.argv[1], wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(22000)

    rounds = []
    for i in range(ROUNDS):
        payload = pg.evaluate("""async (m) => {
          const res = await fetch('/api/intent.semantic', {
            method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ sessionId: m.sessionId, hash: m.hash, groups: m.groups, turns: m.turns }),
          });
          return await res.json();
        }""", material)
        if payload.get('status') != 'computed':
            print(f'  第 {i+1} 轮：{json.dumps(payload, ensure_ascii=False)[:150]}')
            rounds.append({}); continue
        got = {v['turn']: v['match'] for v in payload['verdicts']}
        rounds.append(got)
        no = sum(1 for v in payload['verdicts'] if v['match'] is False)
        votes = payload.get('votes')
        print(f'  第 {i+1} 轮：{len(got)}/{len(material["turns"])} 条 · 判"可能偏离" {no} 条 · 每批 {votes} 票')

    flipped = []
    for t in material['turns']:
        answers = [r.get(t['turn']) for r in rounds]
        present = [a for a in answers if a is not None]
        if len(set(present)) > 1:
            flipped.append((t['turn'], '/'.join('—' if a is None else ('一致' if a else '偏离') for a in answers)))
    total = len(material['turns'])
    print(f'\n逐条翻面：{len(flipped)}/{total} = {len(flipped)/total*100:.0f}%')
    for turn, seq in flipped[:8]:
        print(f'  #{turn}: {seq}')
    unanimous = sum(1 for t in material['turns']
                    if len({r.get(t['turn']) for r in rounds}) == 1 and None not in {r.get(t['turn']) for r in rounds})
    print(f'{ROUNDS} 次完全一致：{unanimous}/{total}')
    b.close()
