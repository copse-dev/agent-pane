import json,collections,re,sys,datetime
run=sys.argv[1]
D={r['id']:r for r in map(json.loads,open(f'{run}/deterministic.jsonl'))}
R=[json.loads(l) for l in open(f'{run}/dataset.jsonl')]
RANK=['read','local-write','remote-write','contain','harm-allow','ask']
def cls(d):
    aa=d['autoApproval']
    if d['harm']=='deny': return 'ask'
    for t in ('read','local-write','remote-write'):
        if aa.get(t): return t
    if d['scope']=='sandbox' and d['harm']=='allow' and not d['dangerous']: return 'contain'
    return 'harm-allow' if d['harm']=='allow' else 'ask'
by=collections.defaultdict(list)
for r in R: by[r['prompt']].append(r)
P={p:(rs[0],max((cls(D[r['id']]) for r in rs),key=RANK.index)) for p,rs in by.items()}
tot=len(P); c=collections.Counter(k for _,k in P.values())
print(f'{tot} resolved prompts'); [print(f'  {k:13}{c[k]:6}{100*c[k]/tot:6.1f}%') for k in RANK]
def head(cmd):
    cmd=re.sub(r'^\s*((cd|W=|export|set)\b[^\n;&]*(&&|;|\n)\s*|[A-Z_]+=\S+\s+)+','',cmd.strip()); t=cmd.split()
    return ' '.join(t[:2]) if t and t[0] in('git','gh','pnpm','npx','node','corepack','python3','npm') else (t[0] if t else '?')
for k in RANK:
    rs=[r for r,kk in P.values() if kk==k]
    print(f'\n[{k}] top commands:',collections.Counter(head(r['command']) for r in rs).most_common(10))
asks=[p for p,(r,k) in P.items() if k=='ask']
rc=collections.Counter()
for p in asks:
    seen=set()
    for r in by[p]:
        for x in D[r['id']]['harmReasons'][:1]:
            x=re.sub(r': .*| \(.*','',str(x))[:70]
            if x not in seen: seen.add(x); rc[x]+=1
print('\n[ask] reasons:'); [print(f'  {n:5} {k}') for k,n in rc.most_common(14)]
wk=collections.defaultdict(collections.Counter)
for r,k in P.values(): wk[datetime.date.fromtimestamp(r['at']/1000).isocalendar()[1]][k]+=1
print('\nweek '+''.join(f'{k:>13}' for k in RANK))
for w in sorted(wk): print(f'{w:4} '+''.join(f'{wk[w][k]:>13}' for k in RANK))
