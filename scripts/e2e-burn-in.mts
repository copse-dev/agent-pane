/**
 * Burn-in admission for e2e specs that are about to become required.
 *
 * A spec joins the required e2e gate the moment it merges, so one lucky pass
 * should not be enough to admit it. The `e2e-burn-in` job in ci.yml runs every
 * spec a pull request adds, modifies or restores (removes an exclusion marker
 * for) ten times in fresh WebdriverIO processes with no retry, then runs each of
 * its `it` blocks alone. Every run must pass.
 *
 *   plan  --base <rev> [--allow-large] [--github-output <file>] [--summary <file>]
 *         Decide which specs to burn in for the diff <rev>..HEAD.
 *   tests --spec <path>
 *         Print the isolated-test grep patterns the run step would use (JSON).
 *   run   --spec <path> [--repeats <n>] [--out <dir>] [--summary <file>]
 *         Burn one spec in. Needs the built app, like `pnpm run test:e2e:ci`.
 *
 * Selection is deliberately narrow: only `tests/e2e/*.e2e.ts` spec files, never
 * shared helpers, which would select hundreds of specs and are already covered
 * by the oracle-selected e2e shards. See docs/testing-strategy.md ("Burn-in
 * admission").
 */
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import { isDirectExecution } from './lib/direct-execution.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { listCiSpecs } from './test-oracle.mts'

/** Most specs one pull request may burn in without the override label. */
export const BURN_IN_CAP = 5
/** Fresh full-spec runs per selected spec. */
export const BURN_IN_REPEATS = 10
/** Pull request label that lifts {@link BURN_IN_CAP}. */
export const BURN_IN_LARGE_LABEL = 'e2e-burn-in-large'
/** Matrix entry the workflow receives when the cap is exceeded. */
export const OVER_CAP_MATRIX_ENTRY = 'over-cap'

const SPEC_PATH = /^tests\/e2e\/[\w/.-]+\.e2e\.ts$/
const REGISTRY_PATH = 'tests/e2e/exclusions.json'

export type BurnInReason = 'added' | 'modified' | 'renamed' | 'restored'
export interface FileChange {
  status: string
  path: string
}
export interface MarkerEntry {
  spec: string
  markers: string[]
}
export interface BurnInSelection {
  status: 'none' | 'run' | 'over-cap'
  cap: number
  specs: { spec: string; reasons: BurnInReason[] }[]
  skipped: { spec: string; reason: string }[]
}

/**
 * Only the fields burn-in needs. Deliberately not the strict registry schema:
 * the base side may predate a schema change and must still be readable.
 */
const markerRegistrySchema = z.object({
  entries: z.array(z.object({ spec: z.string(), markers: z.array(z.string()) })),
})

export function parseMarkerRegistry(text: string): MarkerEntry[] | null {
  return safeJsonParse(text, decodeWithSchema(markerRegistrySchema))?.entries ?? null
}

/** Parse `git diff --name-status -M` output; a rename or copy reports its new path. */
export function parseNameStatus(text: string): FileChange[] {
  const changes: FileChange[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    const status = fields[0]?.charAt(0)
    const path = fields.at(-1)
    if (status && path && fields.length >= 2) changes.push({ status, path })
  }
  return changes
}

/** Specs that lost at least one exclusion marker between the two registries. */
export function restoredSpecs(
  base: readonly MarkerEntry[],
  head: readonly MarkerEntry[],
): string[] {
  const headMarkers = new Map<string, Set<string>>()
  for (const entry of head) {
    const markers = headMarkers.get(entry.spec) ?? new Set<string>()
    for (const marker of entry.markers) markers.add(marker)
    headMarkers.set(entry.spec, markers)
  }
  const restored = new Set<string>()
  for (const entry of base) {
    const kept = headMarkers.get(entry.spec)
    if (entry.markers.some((marker) => !kept?.has(marker))) restored.add(entry.spec)
  }
  return [...restored].sort()
}

export function selectBurnInSpecs(input: {
  changes: readonly FileChange[]
  baseRegistry: readonly MarkerEntry[]
  headRegistry: readonly MarkerEntry[]
  /** The specs the CI e2e gate runs at head (wdio.ci.conf.ts exclusions applied). */
  ciSpecs: ReadonlySet<string>
  allowLarge: boolean
  cap?: number
}): BurnInSelection {
  const cap = input.cap ?? BURN_IN_CAP
  const reasons = new Map<string, Set<BurnInReason>>()
  const add = (spec: string, reason: BurnInReason): void => {
    const set = reasons.get(spec) ?? new Set<BurnInReason>()
    set.add(reason)
    reasons.set(spec, set)
  }
  for (const change of input.changes) {
    if (!SPEC_PATH.test(change.path)) continue
    if (change.status === 'A' || change.status === 'C') add(change.path, 'added')
    else if (change.status === 'M' || change.status === 'T') add(change.path, 'modified')
    else if (change.status === 'R') add(change.path, 'renamed')
  }
  for (const spec of restoredSpecs(input.baseRegistry, input.headRegistry)) add(spec, 'restored')

  const specs: BurnInSelection['specs'] = []
  const skipped: BurnInSelection['skipped'] = []
  for (const spec of [...reasons.keys()].sort()) {
    if (input.ciSpecs.has(spec)) specs.push({ spec, reasons: [...(reasons.get(spec) ?? [])] })
    else skipped.push({ spec, reason: 'not in the CI e2e suite at head (excluded or deleted)' })
  }
  const status =
    specs.length === 0 ? 'none' : specs.length > cap && !input.allowLarge ? 'over-cap' : 'run'
  return { status, cap, specs, skipped }
}

/** The job matrix: one entry per spec, or a single entry that fails the cap. */
export function burnInMatrix(selection: BurnInSelection): string[] {
  if (selection.status === 'over-cap') return [OVER_CAP_MATRIX_ENTRY]
  return selection.status === 'run' ? selection.specs.map((entry) => entry.spec) : []
}

export function overCapMessage(selection: BurnInSelection): string {
  return (
    `This pull request adds, changes or restores ${String(selection.specs.length)} e2e specs; ` +
    `burn-in runs at most ${String(selection.cap)} per pull request. Split the pull request, or ` +
    `add the \`${BURN_IN_LARGE_LABEL}\` label to burn in all of them anyway.`
  )
}

export function renderPlanSummary(selection: BurnInSelection): string {
  const lines = ['### e2e burn-in plan', '']
  if (selection.status === 'none') lines.push('No new, changed or restored e2e spec to burn in.')
  if (selection.status === 'over-cap') lines.push(`**Over the cap.** ${overCapMessage(selection)}`)
  if (selection.specs.length > 0) {
    lines.push('', '| Spec | Why |', '| --- | --- |')
    for (const entry of selection.specs)
      lines.push(`| \`${entry.spec}\` | ${entry.reasons.join(', ')} |`)
  }
  for (const entry of selection.skipped)
    lines.push('', `Not burned in: \`${entry.spec}\`: ${entry.reason}.`)
  return lines.join('\n') + '\n'
}

export interface SpecTests {
  /** Mocha full titles (suite titles and test title joined by spaces). */
  titles: string[]
  /** Tests whose full title is not a static string, so cannot be run alone. */
  dynamic: number
}

const SUITE_CALLEE = /^(?:describe|context|suite)$|^describe[A-Z]\w*$/
const TEST_CALLEE = /^(?:it|specify|test)$/

function staticTitle(node: ts.Expression | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    return node.text
  return null
}

type CalleeKind = { kind: 'suite' | 'test'; skipped: boolean } | null

/**
 * What a call's callee is: `describe`, `describe.only`, `it.skip`, or a runtime
 * choice such as `(supported ? describe : describe.skip)`, which only skips
 * when every branch does.
 */
function calleeKind(callee: ts.Expression): CalleeKind {
  if (ts.isParenthesizedExpression(callee)) return calleeKind(callee.expression)
  if (ts.isConditionalExpression(callee)) {
    const a = calleeKind(callee.whenTrue)
    const b = calleeKind(callee.whenFalse)
    if (!a || !b || a.kind !== b.kind) return a ?? b
    return { kind: a.kind, skipped: a.skipped && b.skipped }
  }
  let modifier: string | null = null
  if (ts.isPropertyAccessExpression(callee)) {
    modifier = callee.name.text
    callee = callee.expression
  }
  if (!ts.isIdentifier(callee) || (modifier !== null && modifier !== 'only' && modifier !== 'skip'))
    return null
  const skipped = modifier === 'skip'
  if (SUITE_CALLEE.test(callee.text)) return { kind: 'suite', skipped }
  if (TEST_CALLEE.test(callee.text)) return { kind: 'test', skipped }
  return null
}

/**
 * The tests of a spec, statically. `.skip` blocks are left out (they never run);
 * a title built at runtime is counted in `dynamic` rather than guessed.
 */
export function discoverSpecTests(source: string, fileName = 'spec.e2e.ts'): SpecTests {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const titles = new Set<string>()
  let dynamic = 0
  const visit = (node: ts.Node, suites: readonly (string | null)[]): void => {
    const callee = ts.isCallExpression(node) ? calleeKind(node.expression) : null
    if (callee && ts.isCallExpression(node) && node.arguments.length >= 2) {
      if (callee.skipped) return
      const title = staticTitle(node.arguments[0])
      if (callee.kind === 'suite') {
        for (const argument of node.arguments.slice(1)) visit(argument, [...suites, title])
      } else if (title === null || suites.includes(null)) dynamic++
      else titles.add([...suites, title].join(' '))
      return
    }
    ts.forEachChild(node, (child) => {
      visit(child, suites)
    })
  }
  visit(file, [])
  return { titles: [...titles], dynamic }
}

/** A Mocha grep (`/pattern/` form) matching exactly one full title. */
export function titleGrep(title: string): string {
  return `/^${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`
}

export interface RunCounts {
  passing: number
  pending: number
  failing: number
}

/** Totals from the WDIO spec reporter's `N passing` / `N skipped` / `N failing` lines. */
export function reporterCounts(output: string): RunCounts {
  const sum = (word: string): number => {
    let total = 0
    for (const match of output.matchAll(new RegExp(`\\b(\\d+) ${word}\\b`, 'g')))
      total += Number(match[1])
    return total
  }
  return {
    passing: sum('passing'),
    pending: sum('skipped') + sum('pending'),
    failing: sum('failing'),
  }
}

export type IsolatedVerdict = 'passed' | 'skipped' | 'failed'
export function isolatedVerdict(exitCode: number, counts: RunCounts): IsolatedVerdict {
  if (exitCode !== 0 || counts.failing > 0) return 'failed'
  if (counts.passing > 0) return 'passed'
  // Exit 0 with nothing run: the grep matched no test. That is a failure, not a pass.
  return counts.pending > 0 ? 'skipped' : 'failed'
}

export interface BurnInResult {
  spec: string
  repeats: number
  fullPassed: number
  fullFailures: { run: number; exitCode: number }[]
  isolated: { title: string; verdict: IsolatedVerdict; exitCode: number }[]
  dynamicTests: number
}

export function burnInPassed(result: BurnInResult): boolean {
  return (
    result.fullPassed === result.repeats &&
    result.fullFailures.length === 0 &&
    result.isolated.every((test) => test.verdict !== 'failed')
  )
}

export function renderRunSummary(result: BurnInResult): string {
  const isolatedPassed = result.isolated.filter((test) => test.verdict === 'passed').length
  const skipped = result.isolated.filter((test) => test.verdict === 'skipped').length
  const verdict = burnInPassed(result) ? 'passed' : '**FAILED**'
  const lines = [
    `### e2e burn-in: \`${result.spec}\` ${verdict}`,
    '',
    '| Full runs passed | Isolated tests passed | Isolated skipped | Dynamic titles (not isolated) |',
    '| --- | --- | --- | --- |',
    `| ${String(result.fullPassed)}/${String(result.repeats)} | ${String(isolatedPassed)}/${String(result.isolated.length)} | ${String(skipped)} | ${String(result.dynamicTests)} |`,
  ]
  if (result.fullFailures.length > 0)
    lines.push(
      '',
      `Failed full runs: ${result.fullFailures.map((f) => `#${String(f.run)} (exit ${String(f.exitCode)})`).join(', ')}`,
    )
  const failing = result.isolated.filter((test) => test.verdict === 'failed')
  if (failing.length > 0) {
    lines.push('', 'Failing isolated tests:')
    for (const test of failing) lines.push(`- \`${test.title}\` (exit ${String(test.exitCode)})`)
  }
  return lines.join('\n') + '\n'
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function plan(args: readonly string[]): void {
  const base = option(args, '--base')
  if (!base) throw new Error('plan requires --base <rev>')
  const changes = parseNameStatus(
    execFileSync('git', ['diff', '--name-status', '-M', base, 'HEAD', '--', 'tests/e2e'], {
      encoding: 'utf8',
    }),
  )
  let baseText = ''
  try {
    baseText = execFileSync('git', ['show', `${base}:${REGISTRY_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // No registry at the base: nothing could have been restored.
  }
  const headRegistry = parseMarkerRegistry(readFileSync(REGISTRY_PATH, 'utf8'))
  if (!headRegistry) throw new Error(`Invalid ${REGISTRY_PATH}`)
  const selection = selectBurnInSpecs({
    changes,
    baseRegistry: (baseText && parseMarkerRegistry(baseText)) || [],
    headRegistry,
    ciSpecs: new Set(listCiSpecs()),
    allowLarge: args.includes('--allow-large'),
  })
  const summary = renderPlanSummary(selection)
  process.stdout.write(summary)
  const summaryFile = option(args, '--summary')
  if (summaryFile) appendFileSync(summaryFile, summary)
  const outputFile = option(args, '--github-output')
  if (outputFile)
    appendFileSync(
      outputFile,
      `status=${selection.status}\nmatrix=${JSON.stringify(burnInMatrix(selection))}\n`,
    )
  if (selection.status === 'over-cap')
    console.log(`::warning title=e2e burn-in over cap::${overCapMessage(selection)}`)
}

function cleanupProcesses(): void {
  // The same reaper the e2e shards run between attempts. It matches every
  // Electron on the machine, so only a CI runner (which owns its processes)
  // runs it; a local run relies on WDIO's own session teardown.
  if (process.env['GITHUB_ACTIONS'] !== 'true') return
  try {
    execFileSync('bash', ['scripts/e2e-process-cleanup.sh'], { stdio: 'inherit' })
  } catch {
    console.warn('e2e process cleanup failed; continuing')
  }
}

const RUN_TIMEOUT_SECONDS = 600
function runOnce(
  spec: string,
  attempt: number,
  out: string,
  extra: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  cleanupProcesses()
  const timeout = ['timeout', 'gtimeout'].find((bin) => {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  const wdio = ['scripts/run-e2e.mts', 'wdio.ci.conf.ts', '--spec', spec, ...extra]
  const [command, ...commandArgs] = timeout
    ? [timeout, '-k', '15', String(RUN_TIMEOUT_SECONDS), process.execPath, ...wdio]
    : [process.execPath, ...wdio]
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const child = spawn(command ?? process.execPath, commandArgs, {
      env: {
        ...process.env,
        COPSE_E2E_OUTCOMES_DIR: join(out, 'outcomes'),
        COPSE_E2E_ATTEMPT: String(attempt),
        SHARD_INDEX: 'burn-in',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tee = (chunk: Buffer): void => {
      chunks.push(chunk)
      process.stdout.write(chunk)
    }
    child.stdout.on('data', tee)
    child.stderr.on('data', tee)
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8')
      writeFileSync(join(out, 'logs', `attempt-${String(attempt)}.log`), output)
      resolve({ exitCode: code ?? 1, output })
    })
  })
}

async function run(args: readonly string[]): Promise<void> {
  const spec = option(args, '--spec')
  if (!spec || !SPEC_PATH.test(spec) || !existsSync(spec))
    throw new Error('run requires --spec tests/e2e/<name>.e2e.ts')
  const repeats = Number(option(args, '--repeats') ?? BURN_IN_REPEATS)
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('--repeats must be a positive integer')
  const out = option(args, '--out') ?? 'e2e-burn-in'
  mkdirSync(join(out, 'logs'), { recursive: true })
  const tests = discoverSpecTests(readFileSync(spec, 'utf8'), spec)
  const result: BurnInResult = {
    spec,
    repeats,
    fullPassed: 0,
    fullFailures: [],
    isolated: [],
    dynamicTests: tests.dynamic,
  }
  let attempt = 0
  try {
    for (let i = 1; i <= repeats; i++) {
      attempt++
      console.log(`::group::burn-in ${spec}: full run ${String(i)}/${String(repeats)}`)
      const { exitCode } = await runOnce(spec, attempt, out, [])
      console.log('::endgroup::')
      if (exitCode === 0) result.fullPassed++
      else {
        result.fullFailures.push({ run: i, exitCode })
        console.log(
          `::error title=e2e burn-in::${spec} full run ${String(i)} failed (exit ${String(exitCode)})`,
        )
      }
    }
    for (const title of tests.titles) {
      attempt++
      console.log(`::group::burn-in ${spec}: isolated "${title}"`)
      const { exitCode, output } = await runOnce(spec, attempt, out, [
        '--mochaOpts.grep',
        titleGrep(title),
      ])
      console.log('::endgroup::')
      const verdict = isolatedVerdict(exitCode, reporterCounts(output))
      result.isolated.push({ title, verdict, exitCode })
      if (verdict === 'failed')
        console.log(`::error title=e2e burn-in::${spec} failed when "${title}" ran alone`)
    }
  } finally {
    cleanupProcesses()
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  const summary = renderRunSummary(result)
  process.stdout.write(summary)
  const summaryFile = option(args, '--summary')
  if (summaryFile) appendFileSync(summaryFile, summary)
  if (!burnInPassed(result)) process.exitCode = 1
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv
  if (command === 'plan') plan(args)
  else if (command === 'tests') {
    const spec = option(args, '--spec')
    if (!spec) throw new Error('tests requires --spec <path>')
    const tests = discoverSpecTests(readFileSync(spec, 'utf8'), spec)
    console.log(JSON.stringify({ ...tests, greps: tests.titles.map(titleGrep) }, null, 2))
  } else if (command === 'run') await run(args)
  else throw new Error('usage: e2e-burn-in.mts plan|tests|run (see the header comment)')
}

if (isDirectExecution(import.meta.url, 'e2e-burn-in'))
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
