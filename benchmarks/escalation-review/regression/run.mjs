// Check the anonymised regression cases against Copse's deterministic analysis.
//
//   node benchmarks/escalation-review/regression/run.mjs [--check]
//
// Every case runs as if the workspace were /Users/dev/project and the home
// directory /Users/dev, with files (scripts, binaries, node_modules/.bin entries)
// served from the case's `files` map, trusted SSH hosts from `trustedSshHosts`,
// and nothing read from this machine. `enforced` cases must hold; `known-gap` cases
// record behaviour a planned fix changes. With --check the exit status is non-zero
// when an enforced case fails or a known gap starts passing (flip it to enforced).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyze, benchmark, loadGuard } from '../scripts/guard.mjs'

export const HOME = '/Users/dev'
export const WORKSPACE = '/Users/dev/project'

export function loadCases(path = join(benchmark, 'regression', 'cases.jsonl')) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/** Differences between a case's expectations and what the analysis returned. */
export function mismatches(testCase, result) {
  const out = []
  const { expect } = testCase
  if (Object.hasOwn(expect, 'harm')) {
    const allowed = [expect.harm].flat()
    if (!allowed.includes(result.harm))
      out.push(
        `harm ${result.harm} (${result.harmReasons.join('; ')}), expected ${allowed.join(' or ')}`,
      )
  }
  if (Object.hasOwn(expect, 'scope') && result.scope !== expect.scope) {
    out.push(`scope ${result.scope} (${result.scopeReasons.join('; ')}), expected ${expect.scope}`)
  }
  if (Object.hasOwn(expect, 'readOutside') && result.readOutside !== expect.readOutside) {
    out.push(
      `outside-read proof ${result.readOutside ? 'eligible' : 'ineligible'}, expected ${expect.readOutside ? 'eligible' : 'ineligible'}`,
    )
  }
  if (Object.hasOwn(expect, 'read') && result.autoApproval.read !== expect.read) {
    out.push(
      `read tier ${result.autoApproval.read ?? 'prompt'} (${result.autoApprovalReasons.join('; ')}), expected ${expect.read ?? 'prompt'}`,
    )
  }
  return out
}

export async function run(cases = loadCases()) {
  const previousHome = process.env.HOME
  // shell-scope resolves `~` through os.homedir(), which reads HOME.
  process.env.HOME = HOME
  try {
    const guard = await loadGuard()
    return cases.map((testCase) => {
      const files = testCase.files ?? {}
      const readScript = (path) => (Object.hasOwn(files, path) ? (files[path].text ?? null) : null)
      const workspace = Object.hasOwn(testCase, 'workspace') ? testCase.workspace : WORKSPACE
      const isCompiledProgram = (path) => Object.hasOwn(files, path) && files[path].binary === true
      const pathExists = (path) => Object.hasOwn(files, path)
      const result = analyze(guard, testCase.command, workspace, {
        homeDir: HOME,
        readScript,
        isCompiledProgram,
        pathExists,
        trustedSshHosts: testCase.trustedSshHosts ?? [],
      })
      const problems = mismatches(testCase, result)
      const outcome =
        testCase.status === 'enforced'
          ? problems.length === 0
            ? 'pass'
            : 'fail'
          : problems.length === 0
            ? 'gap closed'
            : 'known gap'
      return {
        id: testCase.id,
        status: testCase.status,
        fix: testCase.fix ?? null,
        outcome,
        problems,
      }
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
}

export async function main(argv = process.argv.slice(2)) {
  const results = await run()
  const tally = {}
  for (const r of results) {
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
    if (r.outcome === 'pass') continue
    console.log(`${r.outcome.padEnd(10)} ${r.id}${r.fix ? ` [${r.fix}]` : ''}`)
    for (const problem of r.problems) console.log(`           ${problem}`)
  }
  console.log(tally)
  const broken = results.filter((r) => r.outcome === 'fail' || r.outcome === 'gap closed')
  if (argv.includes('--check') && broken.length > 0) {
    console.error(
      `${broken.length} case(s) disagree with their status: fix the regression or mark closed gaps enforced.`,
    )
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
