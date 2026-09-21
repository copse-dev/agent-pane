// Copse Reviewer, Stage 0, over this repository's own working tree
// (docs/plans/copse-reviewer.md, Phase 0 — binding decision B6: Copse dogfoods
// first). Materialises the merge-base and head, runs the project's own build,
// typecheck, lint and test commands in an execution cell, and reports the delta.
//
//   pnpm run review:stage0 -- --allow-unisolated            # text report
//   pnpm run review:stage0 -- --allow-unisolated --json     # findings + checks as JSON
//   pnpm run review:stage0 -- --base origin/main --allow-unisolated
//
// Outside the app there is no OS sandbox to lean on, so the only backend here
// is the host process with a scrubbed environment; the trust × isolation table
// then requires explicit per-run consent (`--allow-unisolated`) and refuses a
// foreign diff outright. The OS-sandbox backend is the app's
// (`src/main/services/review/os-sandbox-backend.ts`).
//
// Imports only the workspace packages — no Electron, no src/main — so, like
// `bench-agent-lib.mts`, it doubles as the external-consumer proof of the
// `@copse/review` package boundary.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createHostProcessBackend } from '@copse/review/host-process-backend.ts'
import { renderStage0Report } from '@copse/review/report-text.ts'
import { runStage0 } from '@copse/review/stage0.ts'

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    json: { type: 'boolean', default: false },
    'allow-unisolated': { type: 'boolean', default: false },
    store: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(
    [
      'usage: pnpm run review:stage0 -- [--base <ref>] [--allow-unisolated] [--json] [--store <dir>]',
      '',
      '  --base <ref>         the ref the change is against (default: origin/main, else main)',
      '  --allow-unisolated   consent to running your own tree with no isolation backend',
      '  --json               print the full Stage 0 report as JSON instead of text',
      '  --store <dir>        pnpm store to mount read-only (default: `pnpm store path`)',
    ].join('\n'),
  )
  process.exit(0)
}

function refExists(ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function pnpmStorePath(): string | undefined {
  try {
    return execFileSync('pnpm', ['store', 'path'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

const baseRef = values.base ?? (refExists('origin/main') ? 'origin/main' : 'main')
const report = await runStage0({
  repoRoot: process.cwd(),
  baseRef,
  backend: createHostProcessBackend(),
  diffOrigin: 'own',
  unisolatedConsent: values['allow-unisolated'],
  dependencyStore: values.store ?? pnpmStorePath(),
})

if (values.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(renderStage0Report(report))
}
// Advisory, like Fairy: findings are the output, never the exit code. Only a
// refusal to execute, or a project the reviewer could not check at all, is
// signalled — so a wrapper can tell "clean" from "did not look".
process.exit(
  report.execution.decision.execute && report.coverage.notChecked.every((n) => n.kind !== 'all')
    ? 0
    : 2,
)
