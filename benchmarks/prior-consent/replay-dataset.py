import json, os, subprocess, hashlib, collections
P = json.load(open('prompts.json'))
cfg = json.load(open(os.path.expanduser('~/.copse/user-data/config.json')))
roots = {p['id']: p.get('path') for p in cfg.get('projects', []) if p.get('id')}
meta_cache, remote_cache = {}, {}
def meta(p):
    k = (p['project'], p['thread'])
    if k not in meta_cache:
        try: meta_cache[k] = json.load(open(os.path.expanduser(f"~/.copse/workspace/{p['project']}/{p['thread']}/meta.json")))
        except Exception: meta_cache[k] = {}
    return meta_cache[k]
def remotes(d):
    if d not in remote_cache:
        try: remote_cache[d] = sorted(set(subprocess.run(['/usr/bin/git','-C',d,'remote'],capture_output=True,text=True,timeout=10).stdout.split()))
        except Exception: remote_cache[d] = []
    return remote_cache[d]
rows, stats = [], collections.Counter()
for i, p in enumerate(P):
    if p['kind'] != 'shell': continue
    stats['shell'] += 1
    acts = [a for a in p['actions'] if a['name'] == 'run_shell' and isinstance((a.get('args') or {}).get('command'), str)]
    if not acts: stats['unresolved'] += 1; continue
    if len(acts) > 1: stats['ambiguous'] += 1
    m = meta(p); root = roots.get(p['project'])
    cwd = (m.get('worktree') or {}).get('path') or root
    if not cwd: stats['no-cwd'] += 1; continue
    r = remotes(cwd) if os.path.isdir(cwd) else []
    if not os.path.isdir(cwd): stats['cwd-gone'] += 1
    for k, a in enumerate(acts):
      rows.append({'id': f'p{i}-{k}', 'prompt': f'p{i}', 'candidates': len(acts), 'command': a['args']['command'], 'cwd': cwd, 'projectRoot': root,
                   'configuredRemotes': r or ['origin'], 'cause': p['cause'], 'verdict': p['verdict'], 'at': p['at']})
with open('replay/dataset.jsonl', 'w') as f:
    for r in rows: f.write(json.dumps(r) + '\n')
os.chmod('replay/dataset.jsonl', 0o600)
print(stats, 'rows', len(rows))
