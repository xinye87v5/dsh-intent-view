"""一问否决：同一批理解，配给**自己那一组** vs 配给**随机另一组**，偏离率差多少。

若两者差不多 → 这条判定根本没在看内容 → 整个撤掉，而不是继续调措辞。
"""
import sys, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
MATERIAL = os.path.join(HERE, '.out', 'material.json')
MATERIAL_SHUFFLED = os.path.join(HERE, '.out', 'material-shuffled.json')
MATERIAL_SESSION = os.path.join(HERE, '.out', 'material-session.json')
MATERIAL_SESSION_OTHER = os.path.join(HERE, '.out', 'material-session-other.json')
MATERIAL_RECENT = os.path.join(HERE, '.out', 'material-recent.json')
MATERIAL_RECENT_SHIFT = os.path.join(HERE, '.out', 'material-recent-shift.json')
from playwright.sync_api import sync_playwright

ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
with sync_playwright() as p:
    b = p.chromium.launch(headless=True,
        executable_path=os.environ.get("DSH_CHROMIUM", "chromium"),
        args=["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--window-size=1600,1000"],
        env={"LD_LIBRARY_PATH":"/tmp/chlibs"})
    pg = b.new_page(viewport={"width":1600,"height":1000})
    pg.goto(sys.argv[1], wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(22000)

    def run(material):
        rates = []
        for i in range(ROUNDS):
            payload = pg.evaluate("""async (m) => {
              const res = await fetch('/api/intent.semantic', {
                method: 'POST', headers: {'content-type':'application/json'},
                body: JSON.stringify({ sessionId: m.sessionId, hash: m.hash, groups: m.groups, turns: m.turns }),
              });
              return await res.json();
            }""", material)
            if payload.get('status') != 'computed':
                print('   ', json.dumps(payload, ensure_ascii=False)[:120]); continue
            vs = payload['verdicts']
            no = sum(1 for v in vs if v['match'] is False)
            # **只看全票（3/3）**：多票的分级信号可能就藏在这里
            unan = [v for v in vs if v.get('votes') is not None and v.get('votes') == v.get('total')]
            unan_no = sum(1 for v in unan if v['match'] is False)
            rates.append((no, len(vs), unan_no, len(unan)))
        return rates

    for label, path in (('组级：自己那一组', MATERIAL),
                        ('组级：随机另一组', MATERIAL_SHUFFLED),
                        ('会话级：本会话的任务', MATERIAL_SESSION),
                        ('会话级：别的会话的任务', MATERIAL_SESSION_OTHER),
                        ('实质指令：它之前最近那条', MATERIAL_RECENT),
                        ('实质指令：错位七格（对照）', MATERIAL_RECENT_SHIFT)):
        m = json.load(open(path))
        rates = run(m)
        if not rates:
            print(f'{label}：没拿到结果'); continue
        total_no = sum(r[0] for r in rates); total = sum(r[1] for r in rates)
        u_no = sum(r[2] for r in rates); u_total = sum(r[3] for r in rates)
        detail = ' / '.join(f'{a}/{b}' for a, b, _, _ in rates)
        u_detail = ' / '.join(f'{c}/{d}' for _, _, c, d in rates)
        print(f'{label}')
        print(f'   全部条目   判"可能偏离" {total_no}/{total} = {total_no/total*100:.0f}%   （各轮 {detail}）')
        print(f'   仅全票条目 判"可能偏离" {u_no}/{u_total} = {u_no/u_total*100:.0f}%   （各轮 {u_detail}）')
    b.close()
