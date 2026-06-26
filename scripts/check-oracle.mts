/**
 * Keep the test oracle honest. The oracle (scripts/test-oracle.mts) gates the
 * e2e tier in CI by mapping a diff to the specs it can affect. The danger is
 * silent drift: a selector gets renamed or a spec adopts a query pattern the
 * extractor doesn't recognise, the spec's vocabulary goes empty, and it stops
 * being selected for changes that should run it — a false green.
 *
 * This guard runs in the cheap `lint` job and fails CI on two conditions:
 *
 *   1. Liveness — every spec must be selectable by SOME mechanism: at least one
 *      of its selector tokens resolves to real source, OR it imports a src/
 *      module (import-graph reachable). A spec that satisfies neither is invisible
 *      to the oracle and would be silently skipped by `subset` mode forever.
 *
 *   2. Invariants — the oracle's behaviour on representative diffs is pinned, so
 *      a regression in the extractor/plan logic is caught here, not in prod CI.
 *
 * Run: npm run check:oracle
 */
import {
  type CiPlan,
  type Selection,
  SELECTOR_STOPLIST,
  computePlan,
  computeScreenshotGate,
  computeSelection,
  extractSpecTokens,
  fileContainsToken,
  listSourceFiles,
  listSpecs,
  read,
  reachableFiles,
} from './test-oracle.mts'

type Violation = { spec: string; reason: string }

/** Specs the oracle genuinely cannot map to source and that we accept run only
 * in `full` mode (never thinned). Keep this empty if at all possible — an entry
 * here is a coverage blind spot for `subset` runs. Document every addition. */
const LIVENESS_ALLOWLIST = new Set<string>([])

function checkLiveness(): Violation[] {
  // One corpus of all shipped source; a token "resolves" if it appears in any of
  // it. Joining with newlines preserves the per-file word boundaries the matcher
  // relies on, while letting us test each token once instead of per-file.
  const corpus = listSourceFiles()
    .map((f) => read(f))
    .join('\n')

  const importCache = new Map<string, Set<string>>()
  const violations: Violation[] = []

  for (const spec of listSpecs()) {
    if (LIVENESS_ALLOWLIST.has(spec)) continue

    const tokens = extractSpecTokens(read(spec)).filter((t) => !SELECTOR_STOPLIST.has(t.value))
    const resolves = tokens.some((t) => fileContainsToken(corpus, t))
    const importsSrc = [...reachableFiles(spec, importCache)].some((f) => f.startsWith('src/'))

    if (!resolves && !importsSrc) {
      const detail = tokens.length
        ? `selectors [${tokens.map((t) => `${t.kind}:${t.value}`).join(', ')}] match no source file`
        : 'no selector tokens extracted and no src import'
      violations.push({ spec, reason: detail })
    }
  }
  return violations
}

type Invariant = { name: string; check: () => string | null }

function expectSelects(files: string[], spec: string): string | null {
  const sel = computeSelection(files)
  return sel.selectedE2e.includes(spec)
    ? null
    : `expected ${spec} selected for ${files.join(', ')}; got [${sel.selectedE2e.join(', ') || 'none'}]`
}

function expectPlan(files: string[], mode: CiPlan['mode']): string | null {
  const got = computePlan(computeSelection(files)).mode
  return got === mode ? null : `expected plan '${mode}' for ${files.join(', ')}; got '${got}'`
}

function expectConfidence(files: string[], conf: Selection['confidence']): string | null {
  const got = computeSelection(files).confidence
  return got === conf ? null : `expected confidence '${conf}' for ${files.join(', ')}; got '${got}'`
}

function expectGate(files: string[], labeled: boolean, ok: boolean): string | null {
  const gate = computeScreenshotGate(files, labeled)
  return gate.ok === ok
    ? null
    : `expected screenshot gate ok=${ok} for ${files.join(', ')} (labeled=${labeled}); ` +
        `got ok=${gate.ok} (affected=[${gate.affected.join(', ')}], missing=[${gate.missing.join(', ')}])`
}

// A screenshot-producing spec + the reference PNGs it writes. Changing the spec
// selects itself, so its shots become "affected"; if these are renamed the pins
// below fail loudly, exactly the drift we want surfaced. (context-wheel.e2e.ts
// writes these two via footer.saveScreenshot(join(SCREENSHOT_DIR, …)).)
const SHOT_SPEC = 'tests/e2e/context-wheel.e2e.ts'
const SHOT_PNGS = [
  'tests/e2e/screenshots/context-wheel-seeded-30pct.png',
  'tests/e2e/screenshots/context-wheel-live-running.png',
]

// Representative diffs whose mapping must hold. Each references a file/spec that
// exists today; if one is renamed away, this fails loudly so the pin is updated
// alongside the move (exactly the drift we want surfaced).
const INVARIANTS: Invariant[] = [
  {
    name: 'renderer panel change selects a panel spec',
    check: () =>
      expectSelects(['src/renderer/controller/panels.ts'], 'tests/e2e/panel-toggle.e2e.ts'),
  },
  {
    name: 'renderer panel change plans a subset (not full)',
    check: () => expectPlan(['src/renderer/controller/panels.ts'], 'subset'),
  },
  {
    name: 'broad change (package.json) forces full',
    check: () => expectPlan(['package.json'], 'full'),
  },
  {
    name: 'e2e helper change forces full',
    check: () => expectPlan(['tests/e2e/helpers/seed-config.ts'], 'full'),
  },
  {
    name: 'backend-only change is LOW confidence and runs full',
    check: () =>
      expectConfidence(['src/main/services/git-service.ts'], 'low') ??
      expectPlan(['src/main/services/git-service.ts'], 'full'),
  },
  {
    name: 'docs-only change skips e2e',
    check: () => expectPlan(['README.md'], 'skip'),
  },
  {
    name: 'screenshot-affecting change without refreshed PNGs fails the gate',
    check: () => expectGate([SHOT_SPEC], false, false),
  },
  {
    name: 'update-screenshots label is the escape hatch for an affected change',
    check: () => expectGate([SHOT_SPEC], true, true),
  },
  {
    name: 'affected change passes once its reference PNGs are in the diff',
    check: () => expectGate([SHOT_SPEC, ...SHOT_PNGS], false, true),
  },
  {
    name: 'a change affecting no reference shots passes the gate',
    check: () => expectGate(['README.md'], false, true),
  },
]

function main(): void {
  const liveness = checkLiveness()
  const failedInvariants = INVARIANTS.map((inv) => ({ inv, err: inv.check() })).filter((r) => r.err)

  if (!liveness.length && !failedInvariants.length) {
    console.log(
      `✓ oracle check: ${listSpecs().length} specs live, ${INVARIANTS.length} invariants hold`,
    )
    return
  }

  if (liveness.length) {
    console.error(`\n✗ ${liveness.length} spec(s) not selectable by the oracle (liveness):`)
    for (const v of liveness) console.error(`    ${v.spec.replace('tests/e2e/', '')} — ${v.reason}`)
    console.error(
      '\n  Fix: ensure the spec queries a selector that exists in source, or imports the\n' +
        '  module it exercises. If it truly has no source coupling, add it to\n' +
        '  LIVENESS_ALLOWLIST in scripts/check-oracle.mts with a comment (it will then\n' +
        '  always run in `full`, never thinned).',
    )
  }
  if (failedInvariants.length) {
    console.error(`\n✗ ${failedInvariants.length} oracle invariant(s) broken:`)
    for (const { inv, err } of failedInvariants) console.error(`    ${inv.name}\n        ${err}`)
  }
  process.exit(1)
}

main()
