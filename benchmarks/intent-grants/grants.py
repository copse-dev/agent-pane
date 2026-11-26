"""Structured intent grants and a deterministic command matcher.

A user's message becomes a list of scoped grants: {action, pr, branch, package, flags}.
A pending command is parsed into operations, and the prompt is skipped only when every
operation is covered by a grant. Nothing here reads tool output, file contents or the
agent's own text, except the assistant's final question, which is used only to resolve
what a bare "yes" refers to (and never to widen flags).
"""
import json, re, shlex

DEFAULT_BRANCHES = {'main', 'master', 'develop', 'trunk', 'gh-pages'}
REMOTE_ONCE = {'pr-create', 'pr-merge', 'pr-comment', 'pr-automerge', 'pr-ready', 'ci-rerun', 'dep-add', 'dep-remove'}

# --- which operation each grant covers ----------------------------------------------------
# 'any' operations are harmless (version probes, local reads) and ride along with any grant.
COVERS = {
    'pr.open':      {'git-local', 'git-fetch', 'git-push', 'pr-create', 'pr-edit', 'gh-read'},
    'branch.push':  {'git-local', 'git-fetch', 'git-push', 'pr-edit', 'gh-read'},
    'pr.merge':     {'pr-merge', 'gh-read', 'git-fetch'},
    'pr.automerge': {'pr-automerge', 'gh-read'},
    'pr.ready':     {'pr-ready', 'gh-read'},
    'pr.comment':   {'pr-comment', 'gh-read'},
    'ci.rerun':     {'ci-rerun', 'gh-read'},
    'ci.inspect':   {'gh-read', 'git-fetch'},
    'dep.add':      {'dep-add', 'dep-view', 'dep-remove', 'dev-install'},
    # implied dev loop: build/test/lint/format through the project's own scripts
    'code.work':    {'git-local', 'git-fetch', 'dev', 'dev-install'},
}
POLICIES = {
    # P1: explicit, outward actions only
    'scoped': {'pr.open', 'branch.push', 'pr.merge', 'pr.automerge', 'pr.ready', 'pr.comment',
               'ci.rerun', 'ci.inspect', 'dep.add'},
    # P2: P1 plus the implied project dev loop
    'scoped+dev': {'pr.open', 'branch.push', 'pr.merge', 'pr.automerge', 'pr.ready', 'pr.comment',
                   'ci.rerun', 'ci.inspect', 'dep.add', 'code.work'},
}
# P2 also treats "make a PR" as consent to validate it first
IMPLIES = {'scoped+dev': {'pr.open': {'code.work'}, 'branch.push': {'code.work'}}}

# --- user text ------------------------------------------------------------------------------
def own_words(text):
    """The user's own words: drop fenced code, quoted lines, pasted blocks and attachments."""
    t = re.sub(r'```.*?(```|\Z)', ' ', text or '', flags=re.S)
    t = re.sub(r'<pasted[^>]*>.*?(</pasted[^>]*>|\Z)', ' ', t, flags=re.S | re.I)
    t = '\n'.join(l for l in t.split('\n') if not l.lstrip().startswith('>'))
    return t.replace('￼', ' ')

YES = re.compile(r"^\W*(y|yes|yep|yeah|yup|sure|ok|okay|go|go ahead|do it|please do|please|yes please|yes,? (do it|go ahead|please)|go for it|ship it|proceed|sounds good|let'?s do (it|that))\W*$", re.I)
NEG = re.compile(r"\b(don'?t|do not|not yet|no need|without|hold off|never|stop|wait|instead of|skip|no,|rather than|avoid)\b|^\s*no\b", re.I)
OPINION = re.compile(r"^\W*(should (we|i)|do (we|i|you) (need|want|think)|would|could (we|this)|is (it|there|this)|what|why|how|did (we|you)|does|are (we|you|there)|can (this|it|they|these))\b", re.I)
PR = r"(?:(?:draft )?pr|p\.\s?r\.?|pull request|draft)s?"
PATTERNS = [
    ('pr.open',      re.compile(rf"\b(make|open|create|raise|file|put up|send|do|submit|need)\b[^.?!\n]{{0,25}}\b{PR}\b|\bvia an? {PR}\b|^\W*\*?\s*{PR}\W*(please)?\W*$|\b{PR} (please|it|this)\b", re.I)),
    ('branch.push',  re.compile(r"\bpush\b(?! ?back)|\bupdate (the|my|this|that) (pr|branch|pull request)\b|\b(extend|onto|on top of|target)\b[^.?!\n]*\b(?:copse|claude|feature|fix)/", re.I)),
    ('pr.merge',     re.compile(r"\bmerge\b(?!\s+(main|master|origin|conflicts?))", re.I)),
    ('pr.automerge', re.compile(r"\bauto-?merge\b", re.I)),
    ('pr.ready',     re.compile(r"\b(mark (it|this|the pr)? ?(as )?ready|ready for review|undraft)\b", re.I)),
    ('pr.comment',   re.compile(r"\b(comment|reply|respond)\b[^.?!\n]{0,40}(#\d+|\bpr\b|\bissue\b|\bthread\b)|\b(post|leave|add) (a |the )?(cross-link )?comment\b", re.I)),
    ('ci.rerun',     re.compile(r"\b(re-?run|retry|restart)\b[^.?!\n]{0,25}\b(ci|jobs?|checks?|workflows?|actions)\b|\b(retry|run) (this|it) in ci\b", re.I)),
    ('ci.inspect',   re.compile(r"\b(check|look|see|watch)\b[^.?!\n]{0,15}\bci\b|\bci\b[^.?!\n]{0,10}\b(status|failures?|failing|results?)\b|\bin ci\b", re.I)),
    ('dep.add',      re.compile(r"\b(add|install|update|upgrade|bump|use|remove|uninstall|drop)\b\s+(?:the\s+|to\s+)?(?!(?:the|a|an|this|that|it|them|those|dot|some|more)\b)([@\w][\w./@-]*(?:[ -][\w]+)?)", re.I)),
    ('code.work',    re.compile(r"\b(fix|implement|add|build|change|update|refactor|devise|investigate|make (it|this|that|the)|run (the )?(tests?|checks?|build|e2e)|test (it|this)|run the built)\b", re.I)),
]
LEADING_NO = re.compile(r"^\W*(no|nope|not (yet|now)|wait|hold (on|off)|stop)\b", re.I)
INFO = re.compile(r"\b(tell me|explain|describe|remind me|what (would|do|does|is)|how (would|do|does))\b", re.I)
# a target the extractor cannot bind ("the other branch", "a different repo") grants nothing
UNBOUND = re.compile(r"\b(other|another|different|separate|second|their|upstream|fork(ed)?)\b[^.?!\n]{0,15}\b(branch|pr|pull request|repo|repository|remote|one)\b", re.I)
FORCE = re.compile(r"\bforce[- ]?push|--force\b|force-with-lease|\bforce it\b", re.I)
BRANCH = re.compile(r"\b((?:copse|claude|feature|fix|feat)/[\w./-]+[\w])")
PRNUM = re.compile(r"(?:#|\bpr\s*|\bpull request\s*|/pull/)(\d{2,6})\b", re.I)

def last_question(a):
    s = (a or '').strip()[-500:]
    qs = re.findall(r'[^.?!\n]*\?', s)
    return qs[-1].strip() if qs else ''

def _clauses(t):
    t = re.sub(r"\bp\.\s?r\b\.?", "PR", t, flags=re.I)
    return [c for c in re.split(r"[.;!?,\n]+|\bbut\b|\bthen\b(?=\s*(?:don|do not|not))", t, flags=re.I) if c and c.strip()]

def pkg_name(s):
    """'@scope/name@^1.2' -> '@scope/name'; 'name@1' -> 'name'."""
    s = s.lower()
    return '@' + s[1:].split('@')[0] if s.startswith('@') else s.split('@')[0]

def _norm_pkg(s):
    return re.sub(r'[^a-z0-9]', '', pkg_name(s).split('/')[-1])

def extract_det(user, assistant='', ctx=None):
    """Deterministic extractor. Grants come from the user's own words; a bare affirmative
    adopts the assistant's final question, with no flags."""
    ctx = ctx or {}
    words = own_words(user)
    sources = [(words, True)]
    if YES.match(words.strip()):
        q = last_question(assistant)
        if q: sources = [(re.sub(r"^\W*(do you )?(want|would you like) me to|^\W*(should|shall|may|can) i\b", '', q, flags=re.I), False)]
    q_prs = sorted({int(x) for x in PRNUM.findall(last_question(assistant))})
    grants = []
    if LEADING_NO.match(words): return grants  # "no, just tell me…" refuses the whole message
    for text, is_user in sources:
        for cl in _clauses(text):
            if NEG.search(cl) or (is_user and (OPINION.search(cl) or INFO.search(cl))) or UNBOUND.search(cl): continue
            for action, rx in PATTERNS:
              for m in (rx.finditer(cl) if action == 'dep.add' else [rx.search(cl)]):
                  if not m: continue
                  g = {'action': action, 'pr': None, 'branch': None, 'package': None, 'flags': []}
                  n = PRNUM.search(cl)
                  if n: g['pr'] = int(n.group(1))
                  elif is_user and q_prs and re.search(r"\b(it|this|that|the pr)\b", cl, re.I) and len(q_prs) == 1:
                      g['pr'] = q_prs[0]  # "merge it" binds to the one PR the question named
                  b = BRANCH.search(cl)
                  if b: g['branch'] = b.group(1)
                  if action == 'dep.add':
                      phrase = m.group(2)
                      named = set(re.findall(r"`(@?[\w./-]+)`", cl)) | set(re.findall(r"(@[\w-]+/[\w.-]+)", cl))
                      if phrase.lower() in {'it', 'this', 'that', 'the', 'a', 'tests', 'test', 'a test', 'support', 'them', 'those'} and not named: continue
                      g['package'] = {'exact': {pkg_name(phrase.split()[0])} | {pkg_name(x) for x in named},
                                      'loose': {_norm_pkg(phrase), _norm_pkg(phrase.split()[0])}}
                  if is_user and FORCE.search(cl): g['flags'].append('force')
                  grants.append(g)
    return grants

# --- command parsing ------------------------------------------------------------------------
TOOLCHAIN_DIR = re.compile(r"^(\$HOME|~|/Users/[^/]+)/(\.local/share/fnm/node-versions/v[\d.]+/installation/bin|\.nvm/versions/node/v[\d.]+/bin)/?$|^/opt/homebrew/(opt/[\w-]+/)?bin/?$|^\$PWD/\.toolchain/bin/?$")
TOOL_PREFIX = re.compile(r"^((\$HOME|~|/Users/[^/]+)/(\.local/share/fnm/node-versions/v[\d.]+/installation/bin|\.nvm/versions/node/v[\d.]+/bin)|/opt/homebrew/bin|/usr/bin|/usr/local/bin)/")
SAFE_ENV = {'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL', 'NVM_DIR', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'TERM'}
DEV_SCRIPTS = re.compile(r"^(build|build:demo|test|test:e2e(:[\w-]+)?|test:demo|typecheck(:[\w-]+)?|lint|format|format:check|check|check:local|oracle|coverage|size)$")
DEV_TOOLS = {'oxfmt', 'eslint', 'tsc', 'vitest', 'prettier', 'wdio', 'tsx'}
READ_CMDS = {'cat', 'head', 'tail', 'ls', 'wc', 'shasum', 'sha256sum', 'grep', 'rg', 'stat', 'file', 'diff', 'sort', 'uniq', 'jq', 'true', 'echo', 'printf', 'pwd', 'date', 'test', '['}
FILTERS = {'tail', 'head', 'grep', 'rg', 'sort', 'uniq', 'wc', 'cat', 'jq', 'sed'}
GIT_READ = {'status', 'log', 'diff', 'rev-parse', 'rev-list', 'show', 'branch', 'remote', 'ls-files', 'merge-base', 'describe', 'shortlog', 'blame', 'cat-file'}
SECRETISH = re.compile(r"(^|/)(\.env|\.npmrc|\.netrc|id_[a-z0-9]+|.*\.pem|.*\.key|credentials|\.ssh|\.aws|\.gnupg|keychain)", re.I)

class Unparsed(Exception): pass

def _safe_path(p):
    if p in ('/dev/null', '-'): return True
    p = re.sub(r'^\$PWD/', '', p)
    if not p or p.startswith(('/', '~', '$')) or '..' in p.split('/'): return False
    return not SECRETISH.search(p)

def _unquoted_newlines(c):
    """Turn newlines outside quotes into ';' so each line is its own command."""
    out, q, esc = [], None, False
    for ch in c:
        if esc: out.append(ch); esc = False; continue
        if ch == '\\' and q != "'": esc = True; out.append(ch); continue
        if q:
            if ch == q: q = None
        elif ch in ('"', "'"): q = ch
        elif ch == '\n': out.append(' ; '); continue
        elif ch == '#' and (not out or out[-1] in ' \t;'): raise Unparsed('comment')
        out.append(ch)
    return ''.join(out)

def tokenize(cmd):
    c = re.sub(r'eval\s+"\$\(fnm env[^)"]*\)"', ' __fnm_env__ ', cmd)
    if re.search(r'\$\(|`|<<|<\(|>\(|\$\{', c): raise Unparsed('substitution/heredoc')
    c = _unquoted_newlines(c)
    lx = shlex.shlex(c, posix=True, punctuation_chars=';&|<>()')
    lx.whitespace_split = True; lx.commenters = ''
    try: toks = list(lx)
    except ValueError: raise Unparsed('quote')
    # rebuild simple commands
    cmds, cur, pipe_in = [], [], False
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in (';', '&&', '||', '&', ';;'):
            if t == '&': raise Unparsed('background')
            if cur: cmds.append((cur, pipe_in))
            cur, pipe_in = [], False
        elif t in ('|', '|&'):
            if cur: cmds.append((cur, pipe_in))
            cur, pipe_in = [], True
        elif t in ('(', ')'): raise Unparsed('subshell')
        elif t in ('>', '>>', '<', '>&', '&>', '>|'):
            if cur and cur[-1].isdigit() and t != '<': cur.pop()
            if i + 1 >= len(toks): raise Unparsed('redirect')
            tgt = toks[i + 1]; i += 1
            if t == '>&' and tgt in ('1', '2'): pass
            elif not _safe_path(tgt): raise Unparsed('redirect target ' + tgt)
        else: cur.append(t)
        i += 1
    if cur: cmds.append((cur, pipe_in))
    return cmds

def classify(argv, piped, ctx):
    """Return a list of (op, detail) for one simple command, or raise Unparsed."""
    # assignments and toolchain preambles
    while argv and re.match(r'^[A-Za-z_]\w*=', argv[0]):
        k, v = argv[0].split('=', 1)
        if k == 'PATH':
            if not all(TOOLCHAIN_DIR.match(x) or x in ('$PATH',) for x in v.split(':')): raise Unparsed('PATH')
        elif k == 'result' and v == '$?': pass
        elif k not in SAFE_ENV or (v.startswith('/') and not v.startswith('$PWD')): raise Unparsed('env ' + k)
        argv = argv[1:]
    if not argv: return [('any', 'assign')]
    h = argv[0]
    if h == 'export': return classify(argv[1:], piped, ctx) if len(argv) > 1 else [('any', 'export')]
    if h in ('__fnm_env__',): return [('any', 'fnm-env')]
    if h in ('set',) and all(re.match(r'^[-+][euxo]+$|^pipefail$', a) for a in argv[1:]): return [('any', 'set')]
    if h == 'exit' and all(a in ('$result', '0', '1') for a in argv[1:]): return [('any', 'exit')]
    if h in ('.', 'source') and len(argv) == 2 and re.match(r'^(\$NVM_DIR|~/\.nvm|\$HOME/\.nvm)/nvm\.sh$', argv[1]): return [('any', 'nvm')]
    if h in ('nvm', 'fnm') and len(argv) >= 2 and argv[1] in ('use', 'current', 'list', 'ls'): return [('any', 'toolchain')]
    if h == 'fnm' and len(argv) >= 3 and argv[1] == 'exec':
        rest = argv[2:]
        while rest and rest[0].startswith('--using'):
            rest = rest[1:] if '=' in rest[0] else rest[2:]
        return classify(rest, piped, ctx)
    if h == 'cd':
        if len(argv) == 2 and _safe_path(argv[1]): return [('any', 'cd')]
        raise Unparsed('cd')
    h = TOOL_PREFIX.sub('', h)
    if '/' in h and not h.startswith('./node_modules/.bin/'): raise Unparsed('path exe ' + h)
    h = h.replace('./node_modules/.bin/', '')
    if h == 'corepack':
        if len(argv) == 1 or argv[1] in ('--version', '-v'): return [('any', 'probe')]
        argv = argv[1:]; h = argv[0]
    if re.match(r'^(pnpm|npm|npx)(@[\d.]+)?$', h): h = h.split('@')[0]
    if piped and h not in FILTERS: raise Unparsed('pipe into ' + h)
    if piped:
        if h == 'sed' and not all(a == '-n' or re.match(r"^\d*,?\d*p$", a) for a in argv[1:]): raise Unparsed('sed')
        return [('any', 'filter')]
    if len(argv) >= 2 and argv[1] in ('--version', '-v', '-V', 'version') and h in ('node', 'pnpm', 'npm', 'git', 'gh', 'corepack', 'fnm', 'nvm', 'python3', 'cargo', 'rustc', 'swift', 'xcodebuild'): return [('any', 'probe')]
    if h in ('command', 'which', 'type') : return [('any', 'probe')]
    if h == 'node' and argv[1:] == ['-p', 'process.execPath']: return [('any', 'probe')]
    if h in READ_CMDS:
        if h in ('echo', 'printf', 'true', 'pwd', 'date', 'test', '['):
            if any('$' in x for x in argv[1:]): raise Unparsed('variable in echo')
            return [('any', 'read')]
        files = [a for a in argv[1:] if not a.startswith('-')]
        if h in ('grep', 'rg') and files: files = files[1:]
        if h == 'jq' and files: files = files[1:]
        if all(_safe_path(f) for f in files): return [('any', 'read')]
        raise Unparsed('read outside')
    if h == 'git': return _git(argv[1:], ctx)
    if h == 'gh': return _gh(argv[1:], ctx)
    if h in ('pnpm', 'npm'): return _pnpm(argv[1:], ctx, h)
    if h == 'node':
        rest = [a for a in argv[1:]]
        while rest and rest[0] in ('--import', '--require', '-r', '--loader'):
            if rest[1] != 'tsx': raise Unparsed('node loader')
            rest = rest[2:]
        if rest and rest[0] == '--test': rest = rest[1:]
        if rest and all(_safe_path(a) for a in rest if not a.startswith('-')) and re.match(r'^(src|tests?|scripts)/', rest[0]):
            if ctx.get('untrusted_files') and any(a in ctx['untrusted_files'] for a in rest): raise Unparsed('modified script')
            return [('dev', 'node ' + rest[0])]
        raise Unparsed('node')
    raise Unparsed('unknown ' + h)

def _git(a, ctx):
    while a and a[0] in ('-C', '-c', '--git-dir', '--work-tree') or (a and a[0].startswith(('--git-dir=', '--work-tree='))):
        raise Unparsed('git -C/-c')
    if not a: raise Unparsed('git')
    sub, args = a[0], a[1:]
    if sub in GIT_READ:
        if sub == 'branch' and any(x in ('-D', '-d', '-m', '-M', '--delete', '-f', '--force') for x in args): raise Unparsed('branch write')
        if sub == 'remote' and args and args[0] not in ('-v', 'show', 'get-url'): raise Unparsed('remote write')
        return [('any', 'git-read')]
    if sub == 'fetch':
        rest = [x for x in args if x not in ('--prune', '--quiet', '-q', '--tags') or x == '--tags']
        if '--tags' in args: raise Unparsed('fetch tags')
        if rest and rest[0] != 'origin': raise Unparsed('fetch remote')
        return [('git-fetch', 'fetch')]
    if sub in ('add', 'commit', 'stash', 'restore'):
        if sub == 'add' and any(x in ('-f', '--force') for x in args): raise Unparsed('add -f')
        if sub == 'add' and any(SECRETISH.search(x) for x in args): raise Unparsed('add secret')
        if sub == 'commit' and any(x.startswith(('--author', '-S', '--gpg')) for x in args): pass
        return [('git-local', sub)]
    if sub in ('rebase', 'merge'):
        if any(x in ('-i', '--interactive', '--exec', '-x') for x in args): raise Unparsed('rebase -i')
        tgt = [x for x in args if not x.startswith('-')]
        if sub == 'merge' and not all(re.match(r'^origin/[\w./-]+$', t) for t in tgt): raise Unparsed('merge target')
        if sub == 'rebase' and not all(re.match(r'^origin/[\w./-]+$', t) for t in tgt): raise Unparsed('rebase target')
        if ctx.get('branch') in DEFAULT_BRANCHES or not ctx.get('branch'): raise Unparsed('rebase on default branch')
        return [('git-local', sub)]
    if sub == 'push': return _push(args, ctx)
    raise Unparsed('git ' + sub)

def _push(args, ctx):
    flags = [x for x in args if x.startswith('-')]
    pos = [x for x in args if not x.startswith('-')]
    force = False
    for f in flags:
        if f in ('-u', '--set-upstream', '-q', '--quiet', '--porcelain'): continue
        if f in ('-f', '--force') or f.startswith('--force-with-lease') or f == '--force-if-includes': force = True; continue
        raise Unparsed('push flag ' + f)
    if not pos or pos[0] != 'origin': raise Unparsed('push remote')
    refs = pos[1:]
    if not refs: refs = ['HEAD']
    cur = ctx.get('branch')
    targets = []
    for r in refs:
        if r.startswith('+'): force = True; r = r[1:]
        src, _, dst = r.partition(':')
        dst = dst or src
        if src not in ('HEAD', cur) and not (src == dst): raise Unparsed('push src ' + src)
        if dst == 'HEAD': dst = cur
        dst = (dst or '').replace('refs/heads/', '')
        if not dst or dst in DEFAULT_BRANCHES or dst.startswith(('refs/tags', 'release')): raise Unparsed('push to default/tag ' + str(dst))
        targets.append(dst)
    return [('git-push', {'targets': targets, 'force': force})]

def _gh(a, ctx):
    if len(a) < 2:
        raise Unparsed('gh')
    group, sub, args = a[0], a[1], a[2:]
    if any(x in ('--repo', '-R') or x.startswith('--repo=') for x in args):
        i = next(i for i, x in enumerate(args) if x in ('--repo', '-R') or x.startswith('--repo='))
        repo = args[i].split('=', 1)[1] if '=' in args[i] else (args[i + 1] if i + 1 < len(args) else '')
        if repo.lower() != (ctx.get('repo') or '').lower(): raise Unparsed('gh --repo')
    nums = [int(x) for x in args if x.isdigit()]
    if group == 'pr' and sub in ('view', 'checks', 'list', 'diff', 'status'): return [('gh-read', 'pr ' + sub)]
    if group == 'run' and sub in ('view', 'list', 'watch'): return [('gh-read', 'run ' + sub)]
    if group == 'api':
        rest = a[1:]
        if any(x in ('-X', '--method', '-f', '-F', '--field', '--raw-field', '--input') for x in rest): raise Unparsed('gh api write')
        return [('gh-read', 'api')]
    if group == 'pr' and sub == 'create':
        i = 0
        while i < len(args):
            x = args[i]
            if x in ('--title', '-t', '--body', '-b', '--label', '-l', '--assignee', '--reviewer', '-r'): i += 2; continue
            if x in ('--draft', '-d', '--fill', '--fill-first'): i += 1; continue
            if x in ('--base', '-B'):
                if args[i + 1] not in DEFAULT_BRANCHES and args[i + 1] != ctx.get('base'): raise Unparsed('pr base')
                i += 2; continue
            if x in ('--head', '-H'):
                if args[i + 1].split(':')[-1] not in (ctx.get('branch'), ) and args[i + 1].split(':')[-1] not in ctx.get('named_branches', []): raise Unparsed('pr head')
                i += 2; continue
            if x in ('--body-file', '-F'):
                if not _safe_path(args[i + 1]): raise Unparsed('body-file')
                i += 2; continue
            if x in ('--repo', '-R'): i += 2; continue
            raise Unparsed('pr create flag ' + x)
        return [('pr-create', {})]
    if group == 'pr' and sub == 'comment':
        if any(x in ('--body-file', '-F') for x in args): raise Unparsed('comment body-file')
        return [('pr-comment', {'pr': nums[0] if nums else None})]
    if group == 'pr' and sub == 'merge':
        if any(x in ('--admin',) for x in args): raise Unparsed('merge --admin')
        if '--auto' in args: return [('pr-automerge', {'pr': nums[0] if nums else None})]
        return [('pr-merge', {'pr': nums[0] if nums else None})]
    if group == 'pr' and sub == 'edit':
        if any(x in ('--body-file', '-F', '--base', '-B', '--add-reviewer', '--add-assignee') for x in args): raise Unparsed('pr edit flag')
        return [('pr-edit', {'pr': nums[0] if nums else None})]
    if group == 'pr' and sub == 'ready': return [('pr-ready', {'pr': nums[0] if nums else None})]
    if group == 'run' and sub == 'rerun': return [('ci-rerun', {'pr': None})]
    raise Unparsed('gh ' + group + ' ' + sub)

def _pnpm(a, ctx, h):
    while a and a[0] in ('--silent', '-s', '--offline'): a = a[1:]
    if a and a[0].startswith('--filter'): raise Unparsed('filter')
    if not a: raise Unparsed('pnpm')
    sub, args = a[0], a[1:]
    if sub == 'run' or (h == 'pnpm' and DEV_SCRIPTS.match(sub)):
        script = args[0] if sub == 'run' else sub
        if not script or not DEV_SCRIPTS.match(script): raise Unparsed('script ' + str(script))
        if ctx.get('untrusted_files') and ('package.json' in ctx['untrusted_files']): raise Unparsed('modified package.json')
        return [('dev', 'run ' + script)]
    if sub in ('test', 't'):
        if ctx.get('untrusted_files') and 'package.json' in ctx['untrusted_files']: raise Unparsed('modified package.json')
        return [('dev', 'test')]
    if sub == 'exec':
        if not args or args[0] not in DEV_TOOLS: raise Unparsed('exec ' + (args[0] if args else ''))
        if args[0] in ('tsx',) and not (len(args) > 1 and re.match(r'^(src|tests?|scripts)/', args[1])): raise Unparsed('tsx')
        return [('dev', 'exec ' + args[0])]
    if sub in ('install', 'i', 'ci') and h in ('pnpm', 'npm'):
        if any(not x.startswith('-') for x in args): raise Unparsed('install with packages')
        if any(x in ('-g', '--global', '--registry') or x.startswith('--registry') for x in args): raise Unparsed('install flags')
        return [('dev-install', 'install')]
    if sub in ('add', 'remove', 'rm', 'uninstall', 'view', 'info'):
        if any(x in ('-g', '--global') or x.startswith('--registry') for x in args): raise Unparsed('global/registry')
        pk = [x for x in args if not x.startswith('-')]
        if sub in ('view', 'info'): pk = pk[:1]
        if not pk: raise Unparsed('no package')
        if any(re.match(r'^(https?:|git\+|github:|file:|link:|\.|/)', p) for p in pk): raise Unparsed('package source')
        op = 'dep-view' if sub in ('view', 'info') else 'dep-remove' if sub in ('remove', 'rm', 'uninstall') else 'dep-add'
        return [(op, {'packages': [pkg_name(p) for p in pk]})]
    raise Unparsed(f'{h} {sub}')

def parse_action(action, ctx):
    """Parse a rendered action ('run_shell: …' or '<mcp tool> {json}') into ops."""
    if action.startswith('run_shell: '):
        ops = []
        for argv, piped in tokenize(action[len('run_shell: '):]):
            ops += classify(argv, piped, ctx)
        return ops
    name, _, js = action.partition(' ')
    try: args = json.loads(js) if js.strip() else {}
    except Exception: raise Unparsed('mcp args')
    if not isinstance(args, dict): raise Unparsed('mcp args')
    repo = f"{args.get('owner')}/{args.get('repo')}" if args.get('owner') else args.get('repo')
    if (args.get('owner') or args.get('repo')) and str(repo).lower() != (ctx.get('repo') or '').lower(): raise Unparsed('mcp repo')
    n = args.get('number') or args.get('pr') or args.get('pull_number')
    if name in ('gh_pr_create',):
        if args.get('head') and args['head'] != ctx.get('branch') and args['head'] not in ctx.get('named_branches', []): raise Unparsed('mcp head')
        if args.get('base') and args['base'] not in DEFAULT_BRANCHES: raise Unparsed('mcp base')
        return [('pr-create', {})]
    if name == 'git_push':
        if any(args.get(k) for k in ('force', 'tags', 'delete', 'mirror')): raise Unparsed('mcp push flags')
        b = args.get('branch') or ctx.get('branch')
        if not b or b in DEFAULT_BRANCHES: raise Unparsed('mcp push default')
        return [('git-push', {'targets': [b], 'force': False})]
    table = {'gh_pr_comment': 'pr-comment', 'gh_pr_merge': 'pr-merge', 'gh_pr_enable_auto_merge': 'pr-automerge',
             'gh_pr_mark_ready': 'pr-ready', 'gh_pr_rerun_failed_ci': 'ci-rerun'}
    if name in table:
        if name == 'gh_pr_merge' and args.get('admin'): raise Unparsed('admin merge')
        return [(table[name], {'pr': n})]
    raise Unparsed('mcp ' + name)

# --- matching -------------------------------------------------------------------------------
def covers(grant, op, detail, ctx, policy):
    if op == 'any': return True
    allowed = COVERS[grant['action']]
    if op not in allowed: return False
    if op == 'git-push':
        if detail['force'] and 'force' not in grant['flags']: return False
        ok = {ctx.get('branch')} | ({grant['branch']} if grant.get('branch') else set())
        return all(t in ok and t not in DEFAULT_BRANCHES for t in detail['targets'])
    if op == 'pr-edit':
        return detail.get('pr') is None or detail['pr'] == ctx.get('pr')
    if op in ('pr-comment', 'pr-merge', 'pr-automerge', 'pr-ready', 'ci-rerun'):
        want = grant.get('pr') or ctx.get('pr')
        if op == 'ci-rerun' and detail.get('pr') is None: return True
        return want is not None and detail.get('pr') is not None and int(detail['pr']) == int(want)
    if op in ('dep-add', 'dep-remove', 'dep-view'):
        # a package the user named exactly, or a loose name for a dependency the project already has
        gp = grant.get('package') or {}
        deps = set(ctx.get('deps') or ())
        return bool(gp) and all(p in gp.get('exact', ()) or (p in deps and _norm_pkg(p) in gp.get('loose', ())) for p in detail['packages'])
    return True

def expand(grants, policy):
    out = [g for g in grants if g['action'] in POLICIES[policy]]
    for g in list(out):
        for extra in IMPLIES.get(policy, {}).get(g['action'], ()):
            out.append({**g, 'action': extra, 'flags': []})
    return out

def decide(action, grants, ctx, policy, used):
    """True when the prompt can be skipped. `used` tracks once-only grants this turn."""
    gs = expand(grants, policy)
    if not gs: return False, 'no grant'
    try: ops = parse_action(action, ctx)
    except Unparsed as e: return False, 'unparsed: ' + str(e)
    if not any(op != 'any' for op, _ in ops) and not ops: return False, 'empty'
    consume = []
    for op, detail in ops:
        hit = next((i for i, g in enumerate(gs) if covers(g, op, detail, ctx, policy)
                    and not (op in REMOTE_ONCE and (g['action'], op) in used)), None)
        if hit is None: return False, f'uncovered {op}'
        if op in REMOTE_ONCE: consume.append((gs[hit]['action'], op))
    used.update(consume)
    return True, 'covered'
