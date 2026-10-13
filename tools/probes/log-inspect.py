"""从真实会话日志看：思考与工具调用在不在事件流里。

**多帧 zstd**：会话日志每 append 一次就是一帧，所以要流式解压
（`zstdDecompressSync` 只解第一帧 → 193 字节，看起来像"日志是空的"）。
"""
import sys, json, collections, pathlib
import zstandard

d = pathlib.Path(sys.argv[1])
names = [f.name for f in d.glob('*.jsonl.zstd')]
file = next((n for n in names if '.v3.' in n), names[0])
print(f'读 {file}（同目录还有 {[n for n in names if n != file]}）')

raw = zstandard.ZstdDecompressor().stream_reader(open(d / file, 'rb')).read()
lines = [l for l in raw.decode('utf-8', 'replace').split('\n') if l.strip()]
events = []
for line in lines[1:]:
    try:
        events.append(json.loads(line))
    except Exception:
        pass
print(f'事件数 {len(events)}')

by = collections.Counter(e.get('type') for e in events)
print('\n事件类型:')
for t, n in by.most_common():
    print(f'  {n:>5}  {t}')

def pick(t):
    return [e for e in events if e.get('type') == t]

am = pick('assistant/message')
print(f'\nassistant/message {len(am)} 条:')
if am:
    blocks = am[0].get('data', {}).get('message', {}).get('content', [])
    print('  第一条块类型:', ','.join(b.get('type', '?') for b in blocks) or '(空)')
    for b in blocks:
        if b.get('type') == 'reasoning':
            print('  reasoning:', json.dumps(str(b.get('text'))[:200], ensure_ascii=False))
    stream = am[0].get('data', {}).get('stream', [])
    print('  stream 记录:', ','.join(r.get('type', '?') for r in stream) or '(无)')
    rc = next((r for r in stream if r.get('type') == 'reasoning-chunks'), None)
    if rc:
        print('  reasoning-chunks 前 2 段:', json.dumps(rc.get('texts', [])[:2], ensure_ascii=False)[:220])

def reasoning_text(e):
    return ''.join(str(b.get('text') or '') for b in e.get('data', {}).get('message', {}).get('content', [])
                   if b.get('type') == 'reasoning')

withr = [e for e in am if reasoning_text(e)]
print(f'  → 带思考的 {len(withr)}/{len(am)} 条，思考共 {sum(len(reasoning_text(e)) for e in withr)} 字符')

tc, tr = pick('tool/call'), pick('tool/result')
print(f'\ntool/call {len(tc)} 条，前 3:')
for e in tc[:3]:
    dd = e.get('data', {})
    print(f"  {dd.get('name')}  args={json.dumps(str(dd.get('arguments'))[:110], ensure_ascii=False)}")
print(f'\ntool/result {len(tr)} 条，前 2:')
for e in tr[:2]:
    dd = e.get('data', {})
    blocks = dd.get('message', {}).get('content', [])
    text = ''.join(str(b.get('text') or b.get('content') or '') for b in blocks)
    print(f"  blocks=[{','.join(b.get('type','?') for b in blocks)}] meta={'有' if dd.get('meta') is not None else '无'} err={(dd.get('error') or {}).get('name','-')}")
    print(f"    结果前 130 字: {json.dumps(text[:130], ensure_ascii=False)}")
names_c = collections.Counter(e.get('data', {}).get('name') for e in tc)
print('\n工具分布:', ', '.join(f'{n}×{c}' for n, c in names_c.most_common(12)))
