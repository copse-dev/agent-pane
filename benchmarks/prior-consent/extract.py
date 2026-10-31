# Join each user-answered approval prompt to the conversation around it.
import json, os, sys, re, collections
ROOT = os.path.expanduser('~/.copse/workspace')
FIXTURE = re.compile(r'^(headless-project-|gate-replay-project-|proj-|project-|copse-apple-smoke$|tmp$|_global$)')
def base(n): return re.split(r'__|\.', n or '')[-1]
def norm(tdir, c):
    a = c.get('args')
    if isinstance(a, dict) and a.get('ref'):
        try: a = json.load(open(os.path.join(tdir, a['ref'])))
        except Exception: a = None
    if isinstance(a, dict) and isinstance(a.get('arguments'), dict): a = a['arguments']
    return {'name': base(c.get('name')), 'args': a}
since = float(sys.argv[1]) if len(sys.argv) > 1 else 0

def lines(p):
    for l in open(p, errors='replace'):
        try: yield json.loads(l)
        except Exception: pass

def text(tdir, m):
    c = m.get('content')
    if isinstance(c, str): return c
    if isinstance(c, dict) and c.get('ref'):
        try: return re.sub(r'\A---\n.*?\n---\n', '', open(os.path.join(tdir, c['ref']), errors='replace').read(), flags=re.S)
        except Exception: return ''
    return ''

out = []
for proj in os.listdir(ROOT):
    if FIXTURE.match(proj): continue
    pdir = os.path.join(ROOT, proj)
    if not os.path.isdir(pdir): continue
    for t in os.listdir(pdir):
        tdir = os.path.join(pdir, t)
        try: meta = json.load(open(os.path.join(tdir, 'meta.json')))
        except Exception: continue
        if not meta.get('model'): continue  # fixture threads carry no model
        ev = os.path.join(tdir, 'events.jsonl')
        if not os.path.exists(ev) or os.path.getmtime(ev) < since: continue
        msgs, decs = [], []
        for e in lines(ev):
            if e.get('type') == 'message': msgs.append(e)
            elif e.get('type') == 'decision' and e.get('actor') == 'user' and e.get('verdict') in ('approved', 'denied'):
                decs.append(e)
        if not decs: continue
        msgs.sort(key=lambda m: m.get('createdAt', 0))
        for d in decs:
            T = d['at']
            if T < since * 1000: continue
            before = [m for m in msgs if m.get('createdAt', 0) <= T]
            ui = max((i for i, m in enumerate(before) if m.get('role') == 'user'), default=None)
            if ui is None: continue
            U = before[ui]
            A = next((m for m in reversed(before[:ui]) if m.get('role') == 'assistant' and text(tdir, m).strip()), None)
            cur = [m for m in before[ui+1:] if m.get('role') == 'assistant']
            calls = [norm(tdir, c) for m in cur[-1:] for c in (m.get('toolCalls') or [])]
            if d.get('kind') == 'mcp':
                cand = [norm(tdir, c) for m in cur for c in (m.get('toolCalls') or []) if base(c.get('name')) == base(d.get('subject',''))]
                cand = cand[-1:]
            elif d.get('kind') == 'shell':
                cand = [c for c in calls if c['name'] == 'run_shell']
            else:
                cand = []
            # turns elapsed since the user spoke: assistant messages between U and the prompt
            out.append({
                'project': proj, 'thread': t, 'model': meta.get('model'), 'at': T,
                'kind': d.get('kind'), 'cause': d.get('cause'), 'verdict': d.get('verdict'),
                'subject': d.get('subject'), 'scope': d.get('scope'),
                'assistant_prior': text(tdir, A)[-2500:] if A else '',
                'user': text(tdir, U)[:2000],
                'assistant_msgs_since_user': len(cur),
                'actions': cand,
            })
json.dump(out, open('prompts.json', 'w'))
print(len(out))
