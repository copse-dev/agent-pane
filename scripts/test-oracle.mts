/**
 * Test oracle — recommends which tests to run for a set of changes, so you can
 * run the expensive e2e tier (52 specs, sharded 8× in CI) less often.
 *
 * It is a *local accelerator*, not a CI coverage reducer: it tells you the
 * tests most likely affected by your diff and how confident it is, then leaves
 * the call to you. It never claims a clean bill of health it can't back up.
 *
 * How it maps changes → tests:
 *   • e2e specs barely import source — they drive the built app through DOM
 *     selectors and aria-labels (`#pane-files`, `.titlebar-btn`, "Terminal").
 *     Those same strings live in the renderer/HTML/CSS that defines them, so we
 *     build each spec's *selector vocabulary* and select a spec when a changed
 *     file contains one of its selectors. We also follow real imports (helpers
 *     and the few specs that import a src module directly).
 *   • unit tests (`*.test.ts`) import source directly, so those are selected via
 *     a transitive import graph — exact, no heuristics.
 *
 * Confidence:
 *   • HIGH  — every changed source file was mapped to at least one test (or is a
 *             non-code file). The selected subset is trustworthy.
 *   • LOW   — some changed source has no selector match and no importing test
 *             (typically backend/logic with no DOM coupling). The subset may be
 *             incomplete; a full run is the safe choice. Reported explicitly.
 *   • Broad — a cross-cutting file changed (wdio config, e2e helpers, index.html,
 *             store, preload api, build scripts…). Everything is recommended.
 *
 * Usage:
 *   node scripts/test-oracle.mts                 # changes vs the default branch + working tree
 *   node scripts/test-oracle.mts --base HEAD~3   # against a different base
 *   node scripts/test-oracle.mts --files a.ts b  # explicit file list
 *   node scripts/test-oracle.mts --explain       # show why each spec was picked
 *   node scripts/test-oracle.mts --json          # machine-readable
 *   node scripts/test-oracle.mts --run unit      # run the recommended unit subset
 *   node scripts/test-oracle.mts --run e2e       # run the recommended e2e subset
 *   node scripts/test-oracle.mts --plan          # CI plan (see .github/workflows/ci.yml)
 *
 * CI gating (.github/workflows/ci.yml `precheck` job): on a pull_request the
 * `--plan` output thins the e2e tier to the affected specs; a push to main
 * always runs the full suite, so main is never gated on a partial map.
 *
 * `--plan` also emits a UNIT plan (`unit_mode` / `unit_specs`). CI applies it
 * only to a PR that targets another PR's branch — a stacked layer that cannot
 * merge yet — so every PR that can actually reach trunk still runs the whole
 * suite under the coverage ratchet. See {@link computeUnitPlan}.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const E2E_DIR = 'tests/e2e'
const E2E_GLOB_EXCLUDE = new Set(['agent-eval-drive.e2e.ts']) // excluded by wdio.conf.ts

// Files whose change plausibly affects (almost) every spec. Changing one of
// these flips the recommendation to "run everything" rather than a subset.
const BROAD_PATTERNS: RegExp[] = [
  /^wdio\..*\.ts$/,
  /^tests\/e2e\/helpers\//,
  /^tests\/e2e\/helpers\.ts$/,
  /^tests\/e2e\/electron-shell\//,
  /^tests\/e2e\/fixtures\//,
  /^tests\/e2e\/scenarios\//,
  /^tests\/demo\//,
  /^package(-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^scripts\/(build|dev|run-tests)\.mts$/,
  /^src\/renderer\/index\.html$/,
  /^src\/renderer\/(main|app|bootstrap)\.ts$/,
  /^src\/renderer\/demo\//,
  /^src\/shared\/demo-scenarios\.ts$/,
  /^src\/renderer\/styles\/global\//,
  /^src\/preload\//,
  /^src\/shared\/store\//,
  /^src\/main\/index\.ts$/,
  /^src\/main\/ipc\/index\.ts$/,
]

// Generic selector tokens so common they'd match nearly any file; ignored as
// the *sole* reason to select a spec (they still ride along with a real match).
export const SELECTOR_STOPLIST = new Set([
  'is-active',
  'active',
  'hidden',
  'disabled',
  'open',
  'selected',
  'visible',
  'error',
  'hide',
  'show',
])

const HELP = `test oracle — recommend which tests to run for your changes

Usage: node scripts/test-oracle.mts [options]   (or: npm run oracle -- [options])

Options:
  --base <ref>     compare against this ref (default: the remote's default branch)
  --files <a b…>   use an explicit file list instead of git
  --explain        show why each test was selected
  --json           machine-readable output
  --plan           emit a CI plan (mode=/count=/specs=) for $GITHUB_OUTPUT
  --run <tier>     run the recommendation: e2e (default) | unit | all
  --help           show this help

Confidence: HIGH = changes mapped to tests; LOW = unmapped src changes the
e2e subset may miss (run all to be safe); broad = a cross-cutting file changed.`

type Args = {
  base: string
  /** Whether `--base` was given, so a guessed base is only warned about when it was guessed. */
  baseExplicit: boolean
  files: string[] | null
  explain: boolean
  json: boolean
  plan: boolean
  run: 'e2e' | 'unit' | 'all' | null
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    base: defaultBase(),
    baseExplicit: false,
    files: null,
    explain: false,
    json: false,
    plan: false,
    run: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (arg === '--base') {
      a.base = argv[++i] ?? a.base
      a.baseExplicit = true
    } else if (arg === '--explain') a.explain = true
    else if (arg === '--json') a.json = true
    else if (arg === '--plan') a.plan = true
    else if (arg === '--run') {
      const v = argv[i + 1]
      a.run = v === 'unit' || v === 'all' ? (++i, v) : 'e2e'
    } else if (arg === '--files') {
      const files: string[] = []
      a.files = files
      let next = argv[i + 1]
      while (next !== undefined && !next.startsWith('--')) {
        files.push(next)
        i++
        next = argv[i + 1]
      }
    }
  }
  return a
}

function git(args: string[]): string {
  try {
    // stderr ignored: every call here is best-effort (a missing ref is a normal
    // outcome, not something to print a git fatal about mid-report).
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/** `origin/HEAD` resolved, or null when the clone never set it. */
export function resolvedRemoteHead(): string | null {
  return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim() || null
}

/**
 * The base a local run diffs against: the remote's default branch, resolved
 * from `origin/HEAD`. Hard-coding one branch name mis-scopes every branch cut
 * from a different default — the diff picks up every commit that default is
 * ahead by, which reads as a broad change and recommends the full suite, so
 * the subset silently stops being a subset.
 *
 * A shallow or `--no-tags` clone may have no `origin/HEAD` at all. There is no
 * way to learn the real default offline, so we keep the historical
 * `origin/main` rather than guess, and {@link report} says so — an unnoticed
 * wrong base is exactly the failure this function exists to prevent. CI never
 * relies on any of it; it passes `--base <sha>` explicitly.
 */
export function defaultBase(): string {
  return resolvedRemoteHead() ?? 'origin/main'
}

/** Changed files: committed-vs-base ∪ staged ∪ unstaged ∪ untracked. */
export function changedFiles(base: string): string[] {
  const set = new Set<string>()
  const mergeBase = git(['merge-base', 'HEAD', base]).trim()
  if (mergeBase) for (const f of git(['diff', '--name-only', mergeBase]).split('\n')) add(f)
  for (const f of git(['diff', '--name-only', 'HEAD']).split('\n')) add(f)
  for (const f of git(['diff', '--name-only', '--cached']).split('\n')) add(f)
  for (const line of git(['ls-files', '--others', '--exclude-standard']).split('\n')) add(line)
  function add(f: string): void {
    const t = f.trim()
    if (t) set.add(t)
  }
  return [...set].filter((f) => existsSync(join(ROOT, f)))
}

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

export function read(rel: string): string {
  try {
    return readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    return ''
  }
}

/** Specs wdio.ci.conf.ts excludes from the CI gate (flaky/heavy/network). */
function ciExcludedSpecs(): Set<string> {
  const out = new Set<string>()
  for (const m of read('wdio.ci.conf.ts').matchAll(/['"]\.\/(tests\/e2e\/[^'"]+\.e2e\.ts)['"]/g))
    if (m[1] !== undefined) out.add(m[1])
  return out
}

export type CiPlan = { mode: 'full' | 'subset' | 'skip'; specs: string[]; count: number }

/**
 * Decide how much of the e2e tier a change needs:
 *   full   — run the whole sharded suite (default / safe)
 *   subset — run only `specs` (CI distributes them across the shards)
 *   skip   — nothing e2e-relevant changed
 *
 * Only specs the CI gate actually runs (minus wdio.ci.conf.ts excludes) are
 * considered. LOW confidence and broad changes fall back to `full` so the gate
 * never trusts a partial map; a subset above half the runnable suite isn't
 * worth a partial run either, so it also goes `full`.
 */
export function computePlan(sel: Selection): CiPlan {
  const excluded = ciExcludedSpecs()
  const runnableAll = sel.specs.filter((s) => !excluded.has(s))
  const runnable = sel.selectedE2e.filter((s) => !excluded.has(s))
  let mode: CiPlan['mode']
  let specs: string[] = []
  if (sel.broad || sel.confidence === 'low') mode = 'full'
  else if (runnable.length === 0) mode = 'skip'
  else if (runnable.length > Math.ceil(runnableAll.length / 2)) mode = 'full'
  else {
    mode = 'subset'
    specs = runnable
  }
  return { mode, specs, count: mode === 'full' ? runnableAll.length : specs.length }
}

export type UnitPlan = { mode: 'full' | 'subset' | 'skip'; tests: string[]; count: number }

/**
 * Longest `unit_specs=` line the plan will emit before giving up and running the
 * whole suite. The list crosses into CI through `$GITHUB_OUTPUT` and back out as
 * an argv, so an unbounded subset trades one bounded cost (the full suite) for
 * an unbounded one. The `> half` rule below already caps the count; this caps
 * the bytes for a subset of unusually long paths.
 */
const UNIT_SPECS_MAX_CHARS = 16_000

/**
 * Changes that cannot reach a unit test by any route the runner has. Kept
 * deliberately tiny and prefix-anchored: `docs/` and Markdown are read by humans,
 * never imported or loaded at runtime. Anything else — including `.github/`,
 * `schemas/`, and every fixture directory — is NOT listed, because a JSON or YAML
 * file a test reads from disk is invisible to the import graph and must keep
 * falling through to `full`.
 */
const DOCS_ONLY_PATTERNS: RegExp[] = [/^docs\//, /\.md$/, /^LICENSE$/, /^\.github\/[A-Z_]+\.md$/]

/**
 * Markdown that a unit test CAN observe, and so is never docs-only. `site/*.md`
 * is generated from `site/*.html` and compared byte-for-byte by
 * `scripts/sync-site-markdown.test.ts` — a hand-edit to a published twin is the
 * one change that whole gate exists to catch, and skipping the unit tier for it
 * would let it through.
 */
const DOCS_ONLY_EXCEPTIONS: RegExp[] = [/^site\//]

/** True when every changed file is documentation the unit suite cannot observe. */
export function isDocsOnlyChange(changed: string[]): boolean {
  return (
    changed.length > 0 &&
    changed.every(
      (f) =>
        DOCS_ONLY_PATTERNS.some((re) => re.test(f)) &&
        !DOCS_ONLY_EXCEPTIONS.some((re) => re.test(f)),
    )
  )
}

/**
 * Decide how much of the UNIT tier a change needs. Unit selection is exact in a
 * way e2e selection is not: a unit test is chosen because it transitively
 * imports a changed file, so the import graph — not the selector-vocabulary
 * heuristic — is the whole mapping. That is why `confidence` / `unmapped` (which
 * `computeSelection` documents as being about the e2e tier specifically) play no
 * part here.
 *
 *   full   — the safe default, and what an EMPTY selection means. No unit test
 *            importing a changed file is the same evidence as a fixture, JSON
 *            snapshot, or config the graph cannot see, so it must not thin.
 *   subset — run only `tests` (the tests that reach the diff).
 *   skip   — docs-only, the one change shape no unit test can observe.
 *
 * This mirrors {@link unitCommandArgs}, which the local `--run unit` path has
 * always used; CI now reads the same policy instead of always running all of it.
 */
export function computeUnitPlan(sel: Selection): UnitPlan {
  const all = sel.unitTests
  const selected = sel.selectedUnit
  if (isDocsOnlyChange(sel.changed)) return { mode: 'skip', tests: [], count: 0 }
  if (sel.broad || selected.length === 0 || selected.length > Math.ceil(all.length / 2))
    return { mode: 'full', tests: [], count: all.length }
  if (selected.join(' ').length > UNIT_SPECS_MAX_CHARS)
    return { mode: 'full', tests: [], count: all.length }
  return { mode: 'subset', tests: selected, count: selected.length }
}

/** Emit the plan as `key=value` lines (ready for $GITHUB_OUTPUT). */
function emitCiPlan(sel: Selection): void {
  const { mode, specs, count } = computePlan(sel)
  process.stdout.write(`mode=${mode}\n`)
  process.stdout.write(`count=${String(count)}\n`)
  process.stdout.write(`specs=${specs.join(' ')}\n`)
  const unit = computeUnitPlan(sel)
  process.stdout.write(`unit_mode=${unit.mode}\n`)
  process.stdout.write(`unit_count=${String(unit.count)}\n`)
  process.stdout.write(`unit_specs=${unit.tests.join(' ')}\n`)
}

// ── Selector vocabulary ──────────────────────────────────────────────────────
type Token = { kind: 'id' | 'cls' | 'txt'; value: string }

// File extensions / generic words that look like classes in a path but never
// identify a DOM node — dropped so import strings don't pollute the vocabulary.
const TOKEN_STOPLIST = new Set([
  'ts',
  'tsx',
  'mts',
  'js',
  'mjs',
  'json',
  'css',
  'html',
  'md',
  'png',
  'svg',
  'e2e',
  'test',
  'spec',
])

/**
 * Extract DOM selector / aria-label / title tokens a spec depends on. Only the
 * arguments of selector calls (`$`, `$$`, `querySelector(All)`, `closest`,
 * `matches`, `getElementById`) are scanned, so import paths like
 * `'./helpers/x.ts'` never leak a bogus `.ts` class token.
 */
export function extractSpecTokens(src: string): Token[] {
  const tokens = new Map<string, Token>()
  const push = (kind: Token['kind'], value: string): void => {
    if (!value || TOKEN_STOPLIST.has(value)) return
    if (!tokens.has(kind + value)) tokens.set(kind + value, { kind, value })
  }
  const selectorCall =
    /(?:\$\$?|querySelector(?:All)?|closest|matches)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  let m: RegExpExecArray | null
  while ((m = selectorCall.exec(src))) {
    const sel = m[2]
    if (sel === undefined || sel.includes('/')) continue // not a selector (path / url)
    for (const id of sel.matchAll(/#([A-Za-z][\w-]*)/g)) if (id[1] !== undefined) push('id', id[1])
    for (const cls of sel.matchAll(/\.([A-Za-z][\w-]*)/g))
      if (cls[1] !== undefined) push('cls', cls[1])
    for (const at of sel.matchAll(/(?:aria-label|title|data-[\w-]+)=["']([^"']+)["']/g))
      if (at[1] !== undefined) push('txt', at[1])
  }
  // getElementById('x') — id without the leading '#'.
  for (const g of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g))
    if (g[1] !== undefined) push('id', g[1])
  return [...tokens.values()]
}

/**
 * Reference-screenshot filenames a spec writes. Only a PNG passed to a
 * `saveScreenshot` / `save*Screenshot(...)` call counts — a `.png` literal used
 * as a test fixture (e.g. `clickChange('staged.png')`) is not a committed
 * reference shot and must not map the spec to one. A `const NAME = 'foo.png'`
 * alias passed by name (e.g. `saveAppScreenshot(SCREENSHOT)`) is resolved.
 */
export function extractSpecScreenshots(src: string): string[] {
  const out = new Set<string>()
  // const NAME = 'foo.png' aliases (UPPER_SNAKE consts hold the filename).
  const aliases = new Map<string, string>()
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]*)\s*=\s*['"`]([\w-]+\.png)['"`]/g))
    if (m[1] !== undefined && m[2] !== undefined) aliases.set(m[1], m[2])
  // save…Screenshot( … 'foo.png' … ) — literal filename anywhere in the call
  // args (covers helper calls and `browser.saveScreenshot(join(DIR, 'x.png'))`).
  for (const m of src.matchAll(/save\w*Screenshot\(\s*[^)]*?['"`]([\w-]+\.png)['"`]/g))
    if (m[1] !== undefined) out.add(m[1])
  // save…Screenshot(NAME) — filename supplied via a const alias.
  for (const m of src.matchAll(/save\w*Screenshot\(\s*([A-Z][A-Z0-9_]*)\s*\)/g)) {
    const name = m[1]
    const f = name !== undefined ? aliases.get(name) : undefined
    if (f) out.add(f)
  }
  return [...out]
}

/** Does a (source/css/html) file body contain a token's literal name? */
export function fileContainsToken(body: string, tok: Token): boolean {
  if (tok.kind === 'txt') return body.includes(tok.value)
  // id/class: word-bounded so `pane` doesn't match `pane-files`.
  const esc = tok.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(body)
}

// ── Import graph ─────────────────────────────────────────────────────────────
const CODE_EXTS = ['.ts', '.mts', '.tsx', '.js', '.mjs']

/**
 * Workspace package aliases, mirroring `tsconfig.json` `paths` (and the esbuild
 * `alias` in `scripts/run-tests.mts`). Without these, every `@copse/agent/…`
 * import is a dead end in the graph, so a change under `packages/` maps to no
 * test and the unit subset silently misses it.
 */
const PACKAGE_ALIASES: [prefix: string, dir: string][] = [
  ['@shared/', 'src/shared/'],
  ['@copse/agent/', 'packages/agent/src/'],
  ['@copse/llm/', 'packages/llm/src/'],
  ['@copse/plan-usage/', 'packages/plan-usage/src/'],
]

/** Bare package specifiers (no subpath) — resolve to the package entry point. */
const PACKAGE_ENTRIES: Record<string, string> = {
  '@copse/agent': 'packages/agent/src/index',
  '@copse/llm': 'packages/llm/src/index',
  '@copse/plan-usage': 'packages/plan-usage/src/index',
}

function resolveImport(fromRel: string, spec: string): string | null {
  let baseRel: string
  const entry = PACKAGE_ENTRIES[spec]
  const alias = PACKAGE_ALIASES.find(([prefix]) => spec.startsWith(prefix))
  if (entry !== undefined) baseRel = entry
  else if (alias) baseRel = alias[1] + spec.slice(alias[0].length)
  else if (spec.startsWith('.')) {
    const abs = resolve(join(ROOT, fromRel), '..', spec)
    baseRel = relative(ROOT, abs)
  } else return null // bare third-party import
  baseRel = baseRel.replace(/\\/g, '/').replace(/\.(ts|mts|tsx|js|mjs)$/, '')
  for (const ext of CODE_EXTS) if (existsSync(join(ROOT, baseRel + ext))) return baseRel + ext
  for (const ext of CODE_EXTS)
    if (existsSync(join(ROOT, `${baseRel}/index${ext}`))) return `${baseRel}/index${ext}`
  return null
}

function directImports(rel: string): string[] {
  const body = read(rel)
  const out: string[] = []
  for (const m of body.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)) {
    if (m[1] === undefined) continue
    const resolved = resolveImport(rel, m[1])
    if (resolved) out.push(resolved)
  }
  return out
}

/** Transitive set of local files reachable from `entry` (excluding itself). */
export function reachableFiles(entry: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(entry)
  if (cached) return cached
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === undefined) break
    for (const dep of directImports(cur)) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  cache.set(entry, seen)
  return seen
}

// ── Selection ────────────────────────────────────────────────────────────────
export type Selection = {
  changed: string[]
  broad: boolean
  broadHits: string[]
  confidence: 'high' | 'low' | 'broad'
  unmapped: string[]
  specs: string[]
  unitTests: string[]
  selectedE2e: string[]
  selectedUnit: string[]
  e2eReasons: Map<string, string[]>
  unitReasons: Map<string, string[]>
}

/** Runnable e2e specs (the wdio.conf.ts glob minus its one exclude). */
export function listSpecs(): string[] {
  return walk(E2E_DIR)
    .filter((f) => f.endsWith('.e2e.ts') && !E2E_GLOB_EXCLUDE.has(f.replace(`${E2E_DIR}/`, '')))
    .sort()
}

/**
 * Unit test files (selected via the import graph). Must stay the same universe
 * `scripts/run-tests.mts` bundles — `src`, the workspace packages, and the
 * build scripts — or the "N / total" the oracle reports is measured against a
 * suite smaller than the one `npm test` actually runs.
 */
export function listUnitTests(): string[] {
  return [...walk('src'), ...walk('packages'), ...walk('scripts')]
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => !f.startsWith('packages/') || /^packages\/[^/]+\/src\//.test(f))
    .sort()
}

/** Shipped source the selector vocabulary resolves against (no test files). */
export function listSourceFiles(): string[] {
  return walk('src').filter(
    (f) =>
      (CODE_EXTS.some((e) => f.endsWith(e)) || f.endsWith('.css') || f.endsWith('.html')) &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.e2e.ts'),
  )
}

/** Map a set of changed files to the affected e2e specs and unit tests. */
export function computeSelection(changedInput: string[]): Selection {
  const changed = changedInput.map((f) => f.replace(/\\/g, '/'))
  const specs = listSpecs()
  const unitTests = listUnitTests()

  const specTokens = new Map<string, Token[]>()
  for (const s of specs) specTokens.set(s, extractSpecTokens(read(s)))

  const importCache = new Map<string, Set<string>>()
  const specImports = new Map<string, Set<string>>()
  for (const s of specs) specImports.set(s, reachableFiles(s, importCache))
  const unitImports = new Map<string, Set<string>>()
  for (const t of unitTests) unitImports.set(t, reachableFiles(t, importCache))

  const broadHits = changed.filter((f) => BROAD_PATTERNS.some((re) => re.test(f)))
  const broad = broadHits.length > 0

  // Reasons per spec / unit test (for --explain).
  const e2eReasons = new Map<string, string[]>()
  const unitReasons = new Map<string, string[]>()
  const addReason = (m: Map<string, string[]>, k: string, why: string): void => {
    const list = m.get(k) ?? []
    list.push(why)
    m.set(k, list)
  }

  // Files tied to the *e2e* tier (by selector or e2e import). Confidence is
  // about the e2e subset specifically, since that's the tier we want to thin —
  // a backend file covered only by unit tests is still an e2e blind spot.
  const e2eMappedFiles = new Set<string>()

  for (const f of changed) {
    // A changed test file selects itself.
    if (f.endsWith('.e2e.ts') && specs.includes(f)) {
      addReason(e2eReasons, f, 'spec file itself changed')
      e2eMappedFiles.add(f)
    }
    if (f.endsWith('.test.ts') && unitTests.includes(f))
      addReason(unitReasons, f, 'test file itself changed')

    // Import-graph: any spec/test that reaches this changed file.
    for (const s of specs)
      if (specImports.get(s)?.has(f) ?? false) {
        addReason(e2eReasons, s, `imports ${f}`)
        e2eMappedFiles.add(f)
      }
    for (const t of unitTests)
      if (unitImports.get(t)?.has(f) ?? false) addReason(unitReasons, t, `imports ${f}`)

    // Selector vocabulary: which specs' selectors appear in this changed file?
    // Only shipped source — test files carry selector strings of their own that
    // would otherwise pull in unrelated specs by coincidence.
    const isSelectorHost =
      /\.(ts|tsx|css|html)$/.test(f) &&
      f.startsWith('src/') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.e2e.ts')
    if (isSelectorHost) {
      const body = read(f)
      for (const s of specs) {
        const hits = (specTokens.get(s) ?? []).filter(
          (tok) => fileContainsToken(body, tok) && !SELECTOR_STOPLIST.has(tok.value),
        )
        if (hits.length) {
          addReason(
            e2eReasons,
            s,
            `selector ${hits.map((h) => `${h.kind}:${h.value}`).join(', ')} in ${f}`,
          )
          e2eMappedFiles.add(f)
        }
      }
    }
  }

  const selectedE2e = broad ? specs : [...e2eReasons.keys()].sort()
  const selectedUnit = broad ? unitTests : [...unitReasons.keys()].sort()

  // e2e blind spots: shipped source (not tests) we couldn't tie to any spec.
  // Its runtime behaviour may drive an e2e flow that no selector exposes.
  const unmapped = changed.filter(
    (f) =>
      f.startsWith('src/') &&
      !f.endsWith('.test.ts') &&
      (CODE_EXTS.some((e) => f.endsWith(e)) || f.endsWith('.css') || f.endsWith('.html')) &&
      !e2eMappedFiles.has(f) &&
      !broadHits.includes(f),
  )
  const confidence: Selection['confidence'] = broad ? 'broad' : unmapped.length ? 'low' : 'high'

  return {
    changed,
    broad,
    broadHits,
    confidence,
    unmapped,
    specs,
    unitTests,
    selectedE2e,
    selectedUnit,
    e2eReasons,
    unitReasons,
  }
}

// ── Reference-screenshot gate ────────────────────────────────────────────────
const E2E_SCREENSHOT_DIR = 'tests/e2e/screenshots'

/** spec → the reference-screenshot filenames it (re)generates. */
export function specScreenshots(): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const s of listSpecs()) m.set(s, extractSpecScreenshots(read(s)))
  return m
}

/** Reference screenshots the selected e2e specs (re)generate, sorted & unique. */
export function affectedScreenshots(sel: Selection, map = specScreenshots()): string[] {
  const out = new Set<string>()
  for (const s of sel.selectedE2e) for (const png of map.get(s) ?? []) out.add(png)
  return [...out].sort()
}

export type ScreenshotGate = {
  affected: string[] // reference PNGs the change's specs (re)generate
  updated: string[] // screenshot PNGs refreshed in this diff
  missing: string[] // affected − updated: presumed stale
  labeled: boolean // `update-screenshots` label present
  ok: boolean
}

/**
 * Hard gate (cheap lint tier — pure static analysis, no build/Electron/e2e):
 * if a diff touches UI that a committed reference screenshot covers (the oracle
 * maps it to a screenshot-producing spec) but the PNG wasn't refreshed in the
 * same diff, the shot is presumed stale. Reference shots are pixel-rendered on
 * the CI runner, so the sanctioned refresh path is letting CI render and commit
 * them: the e2e gate run re-renders the affected shots and the commit-screenshots
 * job commits the diff. The `update-screenshots` label forces a full refresh — a
 * labeled PR always passes. This static gate never reruns the e2e tier itself.
 *
 * Only files that can influence rendered output drive the gate: shipped source
 * (`src/**`) and the e2e harness/fixtures/specs (`tests/e2e/**`). Root-level
 * infra — a lockfile bump, tsconfig, build scripts, wdio config — is broad for
 * *test selection* but cannot change a pixel, so it must not demand a full
 * screenshot regen. (A genuinely visual broad change like global CSS or
 * index.html lives under `src/` and still fans out to every shot.)
 */
export function computeScreenshotGate(changed: string[], labeled: boolean): ScreenshotGate {
  const renderAffecting = changed.filter(
    (f) => (f.startsWith('src/') || f.startsWith(`${E2E_DIR}/`)) && !f.endsWith('.test.ts'),
  )
  const sel = computeSelection(renderAffecting)
  const affected = affectedScreenshots(sel)
  const updated = new Set(
    changed
      .filter((f) => f.startsWith(`${E2E_SCREENSHOT_DIR}/`) && f.endsWith('.png'))
      .map((f) => f.slice(`${E2E_SCREENSHOT_DIR}/`.length)),
  )
  const missing = affected.filter((p) => !updated.has(p))
  return {
    affected,
    updated: [...updated].sort(),
    missing,
    labeled,
    ok: labeled || missing.length === 0,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const sel = computeSelection(args.files ?? changedFiles(args.base))

  if (args.plan) {
    emitCiPlan(sel)
    return
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          base: args.base,
          changed: sel.changed,
          broad: sel.broad,
          broadHits: sel.broadHits,
          confidence: sel.confidence,
          unmapped: sel.unmapped,
          e2e: { selected: sel.selectedE2e, total: sel.specs.length },
          unit: { selected: sel.selectedUnit, total: sel.unitTests.length },
        },
        null,
        2,
      ),
    )
  } else {
    report(args, sel)
  }

  if (args.run)
    runSelected(
      args.run,
      sel.broad,
      sel.selectedE2e,
      sel.selectedUnit,
      sel.specs.length,
      sel.unitTests.length,
    )
}

function report(args: Args, c: Selection): void {
  const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
  const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
  console.log(bold(`\nTest oracle — ${String(c.changed.length)} changed file(s)`))
  console.log(dim(`  base: ${args.base}`))
  if (args.files === null && !args.baseExplicit && resolvedRemoteHead() === null) {
    console.log(
      dim(
        `  ⚠️  origin/HEAD is unset, so the base is a guess. If your branch was cut\n` +
          `     from another branch the diff is too wide and this recommends too much.\n` +
          `     Fix once with \`git remote set-head origin --auto\`, or pass --base <ref>.`,
      ),
    )
  }
  if (!c.changed.length) {
    console.log(dim('  (no changes detected vs base / working tree)'))
    return
  }

  if (c.broad) {
    console.log(`\n⚠️  Broad change — recommend running EVERYTHING:`)
    for (const f of c.broadHits) console.log(`    ${f}`)
  }

  const verdict =
    c.confidence === 'broad'
      ? '🔶 broad (full run recommended)'
      : c.confidence === 'low'
        ? '🔻 LOW — unmapped changes below; a subset may miss regressions'
        : '🟢 HIGH — all changes mapped to tests'
  console.log(`\nConfidence: ${verdict}`)
  if (c.unmapped.length) {
    console.log(dim('  Unmapped (no selector match, no importing test):'))
    for (const f of c.unmapped) console.log(dim(`    ${f}`))
  }

  // `--explain` is a request for the reasoning behind every pick, so it opts
  // out of the preview cap; the default listing stays short enough to read.
  // Uncapped, a change to a widely-imported module lists a few hundred paths
  // twice over, which buries the recommendation it is supposed to support.
  const preview = <T,>(items: T[]): T[] =>
    args.explain ? items : items.slice(0, LIST_PREVIEW_LIMIT)
  const printHidden = (total: number): void => {
    const hidden = args.explain ? 0 : total - LIST_PREVIEW_LIMIT
    if (hidden > 0) console.log(dim(`  … +${String(hidden)} more (--json for the full list)`))
  }

  console.log(`\ne2e: ${bold(String(c.selectedE2e.length))} / ${String(c.specs.length)} spec(s)`)
  for (const s of preview(c.selectedE2e)) {
    console.log(`  ${s.replace(`${E2E_DIR}/`, '')}`)
    if (args.explain)
      for (const why of dedupe(c.e2eReasons.get(s) ?? [])) console.log(dim(`      ${why}`))
  }
  printHidden(c.selectedE2e.length)

  console.log(
    `\nunit: ${bold(String(c.selectedUnit.length))} / ${String(c.unitTests.length)} test(s)`,
  )
  for (const t of preview(c.selectedUnit)) {
    console.log(`  ${t}`)
    if (args.explain)
      for (const why of dedupe(c.unitReasons.get(t) ?? [])) console.log(dim(`      ${why}`))
  }
  printHidden(c.selectedUnit.length)

  console.log(bold('\nRun:'))
  const unitArgs = unitCommandArgs(c.broad, c.selectedUnit, c.unitTests.length)
  if (unitArgs.length - 2 > UNIT_COMMAND_INLINE_LIMIT) {
    // Hundreds of paths on one line is not a command anyone reads or pastes.
    console.log(`  node scripts/test-oracle.mts --run unit`)
    console.log(dim(`    (runs the ${String(c.selectedUnit.length)} selected unit test files)`))
  } else {
    console.log(`  npm ${unitArgs.join(' ')}`)
  }
  if (unitArgs.length === 1 && c.selectedUnit.length === 0 && !c.broad)
    console.log(dim('    (no unit test maps to these changes — running the full suite)'))
  if (c.broad || c.selectedE2e.length === c.specs.length) {
    console.log('  npm run test:e2e')
  } else if (c.selectedE2e.length > UNIT_COMMAND_INLINE_LIMIT) {
    console.log(`  node scripts/test-oracle.mts --run e2e`)
    console.log(dim(`    (runs the ${String(c.selectedE2e.length)} selected spec(s))`))
  } else if (c.selectedE2e.length) {
    console.log(`  npx wdio run wdio.conf.ts ${c.selectedE2e.map((s) => `--spec ${s}`).join(' ')}`)
  } else {
    console.log(dim('  (no e2e specs selected)'))
  }
  if (c.confidence === 'low')
    console.log(dim('  …but confidence is LOW — consider `npm run test:e2e` to be safe.'))
  console.log()
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}

/**
 * Above this many selected files, `--run unit` / `--run e2e` is offered instead
 * of a literal command line: a few hundred paths on one line is not a command
 * anyone reads, and pasting it costs more attention than it saves.
 */
const UNIT_COMMAND_INLINE_LIMIT = 20

/** How many files each tier enumerates before the listing is summarised. */
const LIST_PREVIEW_LIMIT = 20

/**
 * The `npm` args that run the recommended unit subset. Three cases collapse to
 * a plain full `npm test`:
 *   • a broad change — the map isn't trustworthy, so don't pretend it is;
 *   • a selection covering more than half the suite — mirrors `computePlan`'s
 *     e2e rule; below that ratio the bundling saved doesn't pay for the risk of
 *     a partial map;
 *   • an *empty* selection — no mapped test means the oracle has no opinion,
 *     and "0 tests, all green" is the one answer it must never give.
 */
export function unitCommandArgs(broad: boolean, unit: string[], totalUnit: number): string[] {
  if (broad || unit.length === 0) return ['test']
  if (unit.length > Math.ceil(totalUnit / 2)) return ['test']
  return ['test', '--', ...unit]
}

function runSelected(
  which: 'e2e' | 'unit' | 'all',
  broad: boolean,
  e2e: string[],
  unit: string[],
  totalE2e: number,
  totalUnit: number,
): void {
  const run = (cmd: string, cmdArgs: string[]): void => {
    console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
    execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
  }
  if (which === 'unit' || which === 'all') run('npm', unitCommandArgs(broad, unit, totalUnit))
  if (which === 'e2e' || which === 'all') {
    if (broad || e2e.length === totalE2e || e2e.length === 0) run('npm', ['run', 'test:e2e'])
    else run('npx', ['wdio', 'run', 'wdio.conf.ts', ...e2e.flatMap((s) => ['--spec', s])])
  }
}

// Run the CLI only when invoked directly — importing this module (e.g. from
// scripts/check-oracle.mts) must not trigger a git diff + report.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
