import zstandard, json, pathlib, collections
root = pathlib.Path.home()/'.dsh/sessions'
rows=[]
for proj in root.iterdir():
    if not proj.is_dir(): continue
    for d in proj.iterdir():
        f = d/'session.v3.jsonl.zstd'
        if not f.exists(): continue
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(open(f,'rb')).read()
        except Exception: continue
        goal=0; title=0; turns=0
        for line in raw.decode('utf-8','replace').split('\n')[1:]:
            if not line.strip(): continue
            try: o=json.loads(line)
            except Exception: continue
            t=o.get('type')
            if t=='goal/change':
                if str((o.get('data') or {}).get('operation','')) in ('create','clear'): goal+=1
            elif t=='session/title': title+=1
            elif t=='turn/start': turns+=1
        if turns>=40: rows.append((goal,title,turns,d.name[:14]))
rows.sort(reverse=True)
print('会话（≥40 回合）   goal锚  title事件  回合')
for g,t,tu,n in rows[:16]:
    print(f'  {n}   {g:>4}   {t:>6}   {tu:>5}')
