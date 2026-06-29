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
 *   node scripts/test-oracle.mts                 # changes vs origin/main + working tree
 *   node scripts/test-oracle.mts --base HEAD~3   # against a different base
 *   node scripts/test-oracle.mts --files a.ts b  # explicit file list
 *   node scripts/test-oracle.mts --explain       # show why each spec was picked
 *   node scripts/test-oracle.mts --json          # machine-readable
 *   node scripts/test-oracle.mts --run e2e       # run the recommended e2e subset
 *   node scripts/test-oracle.mts --plan          # CI plan (see .github/workflows/ci.yml)
 *
 * CI gating (.github/workflows/ci.yml `plan-e2e` job): on a pull_request the
 * `--plan` output thins the e2e tier to the affected specs; a push to main
 * always runs the full suite, so main is never gated on a partial map.
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
  /^package(-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^scripts\/(build|dev|run-tests)\.mts$/,
  /^src\/renderer\/index\.html$/,
  /^src\/renderer\/(main|app|bootstrap)\.ts$/,
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
  --base <ref>     compare against this ref (default: origin/main)
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
  files: string[] | null
  explain: boolean
  json: boolean
  plan: boolean
  run: 'e2e' | 'unit' | 'all' | null
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    base: 'origin/main',
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
    } else if (arg === '--base') a.base = argv[++i]!
    else if (arg === '--explain') a.explain = true
    else if (arg === '--json') a.json = true
    else if (arg === '--plan') a.plan = true
    else if (arg === '--run') {
      const v = argv[i + 1]
      a.run = v === 'unit' || v === 'all' ? (++i, v) : 'e2e'
    } else if (arg === '--files') {
      a.files = []
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) a.files.push(argv[++i]!)
    }
  }
  return a
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return ''
  }
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
    out.add(m[1]!)
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

/** Emit the plan as `key=value` lines (ready for $GITHUB_OUTPUT). */
function emitCiPlan(sel: Selection): void {
  const { mode, specs, count } = computePlan(sel)
  process.stdout.write(`mode=${mode}\n`)
  process.stdout.write(`count=${count}\n`)
  process.stdout.write(`specs=${specs.join(' ')}\n`)
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
  const push = (kind: Token['kind'], value: string) => {
    if (!value || TOKEN_STOPLIST.has(value)) return
    if (!tokens.has(kind + value)) tokens.set(kind + value, { kind, value })
  }
  const selectorCall =
    /(?:\$\$?|querySelector(?:All)?|closest|matches)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  let m: RegExpExecArray | null
  while ((m = selectorCall.exec(src))) {
    const sel = m[2]!
    if (sel.includes('/')) continue // not a selector (path / url)
    for (const id of sel.matchAll(/#([A-Za-z][\w-]*)/g)) push('id', id[1]!)
    for (const cls of sel.matchAll(/\.([A-Za-z][\w-]*)/g)) push('cls', cls[1]!)
    for (const at of sel.matchAll(/(?:aria-label|title|data-[\w-]+)=["']([^"']+)["']/g))
      push('txt', at[1]!)
  }
  // getElementById('x') — id without the leading '#'.
  for (const g of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g)) push('id', g[1]!)
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
    aliases.set(m[1]!, m[2]!)
  // save…Screenshot( … 'foo.png' … ) — literal filename anywhere in the call
  // args (covers helper calls and `browser.saveScreenshot(join(DIR, 'x.png'))`).
  for (const m of src.matchAll(/save\w*Screenshot\(\s*[^)]*?['"`]([\w-]+\.png)['"`]/g))
    out.add(m[1]!)
  // save…Screenshot(NAME) — filename supplied via a const alias.
  for (const m of src.matchAll(/save\w*Screenshot\(\s*([A-Z][A-Z0-9_]*)\s*\)/g)) {
    const f = aliases.get(m[1]!)
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

function resolveImport(fromRel: string, spec: string): string | null {
  let baseRel: string
  if (spec.startsWith('@shared/')) baseRel = `src/shared/${spec.slice('@shared/'.length)}`
  else if (spec.startsWith('.')) {
    const abs = resolve(join(ROOT, fromRel), '..', spec)
    baseRel = relative(ROOT, abs)
  } else return null // bare package import
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
    const resolved = resolveImport(rel, m[1]!)
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
    const cur = stack.pop()!
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

/** Unit test files (selected via the import graph). */
export function listUnitTests(): string[] {
  return walk('src')
    .filter((f) => f.endsWith('.test.ts'))
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
  const addReason = (m: Map<string, string[]>, k: string, why: string) => {
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
      if (specImports.get(s)!.has(f)) {
        addReason(e2eReasons, s, `imports ${f}`)
        e2eMappedFiles.add(f)
      }
    for (const t of unitTests)
      if (unitImports.get(t)!.has(f)) addReason(unitReasons, t, `imports ${f}`)

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
        const hits = specTokens
          .get(s)!
          .filter((tok) => fileContainsToken(body, tok) && !SELECTOR_STOPLIST.has(tok.value))
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
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
  console.log(bold(`\nTest oracle — ${c.changed.length} changed file(s)`))
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

  console.log(`\ne2e: ${bold(`${c.selectedE2e.length}`)} / ${c.specs.length} spec(s)`)
  for (const s of c.selectedE2e) {
    console.log(`  ${s.replace(`${E2E_DIR}/`, '')}`)
    if (args.explain)
      for (const why of dedupe(c.e2eReasons.get(s) ?? [])) console.log(dim(`      ${why}`))
  }

  console.log(`\nunit: ${bold(`${c.selectedUnit.length}`)} / ${c.unitTests.length} test(s)`)
  for (const t of c.selectedUnit) {
    console.log(`  ${t}`)
    if (args.explain)
      for (const why of dedupe(c.unitReasons.get(t) ?? [])) console.log(dim(`      ${why}`))
  }

  console.log(bold('\nRun:'))
  if (c.broad || c.selectedE2e.length === c.specs.length) {
    console.log('  npm run test:e2e')
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

function runSelected(
  which: 'e2e' | 'unit' | 'all',
  broad: boolean,
  e2e: string[],
  _unit: string[],
  totalE2e: number,
  _totalUnit: number,
): void {
  const run = (cmd: string, cmdArgs: string[]) => {
    console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`)
    execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })
  }
  if (which === 'unit' || which === 'all') run('npm', ['test'])
  if (which === 'e2e' || which === 'all') {
    if (broad || e2e.length === totalE2e || e2e.length === 0) run('npm', ['run', 'test:e2e'])
    else run('npx', ['wdio', 'run', 'wdio.conf.ts', ...e2e.flatMap((s) => ['--spec', s])])
  }
}

// Run the CLI only when invoked directly — importing this module (e.g. from
// scripts/check-oracle.mts) must not trigger a git diff + report.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
