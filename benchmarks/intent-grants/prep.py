# Turn prior-consent's prompts.json into intent cases with thread context (branch, repo, PR).
# Run from bench-results/prior-consent (private data never leaves the git-ignored directory).
import json, os, re, sys, hashlib, collections
sys.path.insert(0, os.path.dirname(__file__))

P = json.load(open('prompts.json'))
_meta = {}
def meta(p):
    k = (p['project'], p['thread'])
    if k not in _meta:
        try: _meta[k] = json.load(open(os.path.expanduser(f"~/.copse/workspace/{p['project']}/{p['thread']}/meta.json")))
        except Exception: _meta[k] = {}
    return _meta[k]

def render(a):
    args = a.get('args') or {}
    if a['name'] == 'run_shell': return 'run_shell: ' + str(args.get('command', ''))
    return a['name'] + ' ' + json.dumps(args, ensure_ascii=False)

def ctx_of(m):
    prs = [r for r in (m.get('prRefs') or []) if isinstance(r, dict)]
    prods = [r.get('pr') for r in (m.get('prProductions') or []) if isinstance(r, dict) and isinstance(r.get('pr'), dict)]
    repo = None
    for r in prs + prods:
        if r.get('owner') and r.get('repo'): repo = f"{r['owner']}/{r['repo']}"; break
    if not repo:
        for c in m.get('commitProductions') or []:
            if isinstance(c, dict) and c.get('repository'): repo = c['repository'].replace('github.com/', ''); break
    nums = sorted({r.get('number') for r in prs + prods if r.get('number')})
    c = {'branch': m.get('gitBranch'), 'repo': repo, 'pr': nums[0] if len(nums) == 1 else None}
    if repo == 'copse-dev/agent-pane': c['deps'] = DEPS
    return c

pj = json.load(open(os.path.join(os.path.dirname(__file__), '../../package.json')))
DEPS = sorted(set(pj.get('dependencies', {})) | set(pj.get('devDependencies', {})))
cases = []
for p in sorted(P, key=lambda p: p['at']):
    m = meta(p)
    turn = hashlib.sha256(f"{p['thread']}|{p['user']}".encode()).hexdigest()[:10]
    cases.append({
        'id': hashlib.sha256(f"{p['thread']}|{p['at']}".encode()).hexdigest()[:10],
        'source': 'real', 'turn': turn, 'thread': p['thread'], 'at': p['at'], 'kind': p['kind'], 'cause': p['cause'],
        'user': p['user'], 'assistant': p['assistant_prior'][-1500:], 'actions': [render(a) for a in p['actions']],
        'ctx': ctx_of(m), 'expected': None,
    })
json.dump(cases, open('intent-real.json', 'w'), indent=0)
print(len(cases), 'prompts;', sum(1 for c in cases if c['actions']), 'with a candidate action;',
      len({c['turn'] for c in cases}), 'user turns')
print(collections.Counter(bool(c['ctx']['branch']) for c in cases), collections.Counter(c['ctx']['repo'] for c in cases).most_common(6))
