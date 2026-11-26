# Must-ask sweep: every must-ask command from the risk-classifier adversarial and red-team sets,
# checked against the widest grant set a user could plausibly give in one message. None may skip.
import json, os, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
from grants import decide, POLICIES
from adversarial import CTX

def widest(ctx):
    acts = sorted(set().union(*POLICIES.values()))
    return [{'action': a, 'pr': ctx['pr'], 'branch': None, 'flags': [],
             'package': {'exact': {'happy-dom'}, 'loose': {'happydom', 'streamingmarkdown'}}} for a in acts]

def rows(path):
    for l in open(path):
        if l.strip(): yield json.loads(l)

if __name__ == '__main__':
    adv, red = sys.argv[1], sys.argv[2]
    R = [r for r in rows(adv) if r['label'] == 'must_ask'] + [dict(r, source='redteam') for r in rows(red)]
    for policy in POLICIES:
        skipped = collections.Counter(); total = collections.Counter()
        for r in R:
            ctx = dict(CTX)
            if r.get('files'): ctx['untrusted_files'] = sorted(r['files'])
            ok, why = decide('run_shell: ' + r['command'], widest(ctx), ctx, policy, set())
            total[r['family']] += 1
            if ok:
                skipped[r['family']] += 1
                print('MUST-ASK SKIPPED', policy, r['family'], r['command'][:160].replace('\n', ' '))
        print(f'{policy}: {sum(skipped.values())} of {sum(total.values())} must-ask commands skipped under the widest grants')
