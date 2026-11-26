# Quick look: deterministic extraction + matching over the real prompts.
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
from grants import extract_det, decide
C = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'intent-real.json'))
policy = sys.argv[2] if len(sys.argv) > 2 else 'scoped'
used = collections.defaultdict(set)
skip, why = 0, collections.Counter()
for c in C:
    g = extract_det(c['user'], c['assistant'], c['ctx'])
    ctx = dict(c['ctx'], named_branches=[x['branch'] for x in g if x.get('branch')])
    if not c['actions']: why['no action'] += 1; continue
    ok, r = True, ''
    u = used[c['turn']]
    trial = set(u)
    for a in c['actions']:
        d, r = decide(a, g, ctx, policy, trial)
        if not d: ok = False; break
    if ok: u |= trial; skip += 1; print('SKIP', c['id'], repr(c['user'][:60]), '|', ' || '.join(a[:110] for a in c['actions']).replace('\n', ' '))
    why[r.split(' ')[0] if not ok else 'covered'] += 1
print(policy, 'skipped', skip, 'of', len(C), why.most_common())
