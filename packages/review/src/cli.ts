// `copse-review` — Shell A (docs/plans/copse-reviewer.md, §Packaging), Phase 1.
//
// Stage 0 over the author's own working tree, then one model under one lens
// (Stages 1, 2 and 5), findings as text, JSON or SARIF. It speaks the headless
// automation contract rather than a private dialect: the model turn is emitted
// as the canonical `turn_start … turn_end` event envelope (`--events`), the
// run resolves its tool permissions from a declared profile that fails closed,
// and exit codes are the contract's.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  CI_DENY_BY_DEFAULT_PROFILE,
  HEADLESS_EXIT,
  capabilityDecision,
  resolveNonInteractiveDecision,
  serializeHeadlessEvent,
  type HeadlessExitCode,
  type HeadlessPermissionProfile,
} from '@copse/agent/headless-contract.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { buildReviewContext } from './context.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import type { IsolationBackend } from './isolation.ts'
import { CORRECTNESS_LENS } from './lenses.ts'
import { isProviderKind, selectProvider, PROVIDER_KINDS } from './provider-selection.ts'
import { renderReviewReport } from './report-text.ts'
import { toSarif } from './sarif.ts'
import { decodeScript } from './scripted-provider.ts'
import { openReviewGround, runStage0Checks } from './stage0.ts'
import { runStage2, type Stage2Result } from './stage2.ts'
import { assembleReviewReport } from './stage5.ts'

export const CLI_VERSION = '0.1.0'

export const USAGE = `usage: copse-review [options]

Review the current repository's working tree against a base ref: build, typecheck,
lint and test on head and base (Stage 0), then one model under the bugs-and-
regressions lens (Stages 1, 2, 5). Findings are the output, never the exit code.

  --base <ref>            the ref the change is against (default: origin/main, else main)
  --allow-unisolated      consent to run your own tree with no isolation backend
  --no-model              Stage 0 only; no model is called
  --provider <kind>       ${PROVIDER_KINDS.join(' | ')} (default: inferred from --model)
  --model <id>            model id for the reviewer
  --base-url <url>        endpoint for lmstudio / openai-compatible
  --mock-script <path>    scripted steps for --provider mock
  --json [<path>]         write the full report as JSON (path, or - for stdout)
  --sarif <path>          write the surfaced findings as SARIF 2.1.0
  --events <path>         write the model turn's headless events as JSONL (- for stdout)
  --budget-chars <n>      diff budget handed to the model (default 60000)
  --max-steps <n>         tool-using steps the reviewer may take
  --store <dir>           pnpm store to mount read-only (default: \`pnpm store path\`)
  --quiet                 no text report on stdout
  --help

Keys are read from the environment only: ANTHROPIC_API_KEY, OPENAI_API_KEY,
OPENROUTER_API_KEY, LM_STUDIO_URL / LM_STUDIO_MODEL / LM_STUDIO_API_KEY,
COPSE_REVIEW_API_KEY. Remote providers receive the diff with secrets redacted.

Exit codes follow the headless contract: 0 the reviewer looked (findings or not),
1 the model turn failed, 2 bad usage or an undetectable project, 3 execution was
refused for want of consent or isolation, 130 cancelled.`

export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly backend?: IsolationBackend
  readonly signal?: AbortSignal
}

function refExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function pnpmStorePath(cwd: string): string | undefined {
  try {
    return execFileSync('pnpm', ['store', 'path'], { cwd, encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

/** The reviewer's permission profile: deny everything, allow the cell's shell only when execution was allowed. */
export function reviewPermissionProfile(executionAllowed: boolean): HeadlessPermissionProfile {
  return {
    ...CI_DENY_BY_DEFAULT_PROFILE,
    id: 'copse-review',
    shell: executionAllowed ? 'allow' : 'deny',
  }
}

export async function main(argv: readonly string[], io: CliIo): Promise<HeadlessExitCode> {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        base: { type: 'string' },
        'allow-unisolated': { type: 'boolean', default: false },
        'no-model': { type: 'boolean', default: false },
        provider: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'mock-script': { type: 'string' },
        json: { type: 'string' },
        sarif: { type: 'string' },
        events: { type: 'string' },
        'budget-chars': { type: 'string' },
        'max-steps': { type: 'string' },
        store: { type: 'string' },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    })
  } catch (err) {
    io.stderr(`copse-review: ${errorMessage(err)}\n${USAGE}\n`)
    return HEADLESS_EXIT.USAGE
  }
  const { values } = parsed
  if (values.help) {
    io.stdout(`${USAGE}\n`)
    return HEADLESS_EXIT.SUCCESS
  }

  let providerKind
  if (values.provider !== undefined) {
    if (!isProviderKind(values.provider)) {
      io.stderr(
        `copse-review: unknown provider ${values.provider}; one of ${PROVIDER_KINDS.join(', ')}\n`,
      )
      return HEADLESS_EXIT.USAGE
    }
    providerKind = values.provider
  }
  let budgetChars: number | undefined
  let maxSteps: number | undefined
  try {
    budgetChars = integer(values['budget-chars'], '--budget-chars')
    maxSteps = integer(values['max-steps'], '--max-steps')
  } catch (err) {
    io.stderr(`copse-review: ${errorMessage(err)}\n`)
    return HEADLESS_EXIT.USAGE
  }

  const startedAt = Date.now()
  const baseRef = values.base ?? (refExists('origin/main', io.cwd) ? 'origin/main' : 'main')
  const backend = io.backend ?? createHostProcessBackend()
  const ground = await openReviewGround({
    repoRoot: io.cwd,
    baseRef,
    backend,
    diffOrigin: 'own',
    unisolatedConsent: values['allow-unisolated'],
    hostEnv: io.env,
    dependencyStore: values.store ?? pnpmStorePath(io.cwd),
  })
  try {
    const stage0 = await runStage0Checks(ground)
    const profile = reviewPermissionProfile(ground.decision.execute && ground.cell !== null)
    const shellDecision = resolveNonInteractiveDecision(capabilityDecision(profile, 'shell'), {
      interactive: false,
    })

    let stage2: Stage2Result | null = null
    let context = null
    let modelError: string | null = null
    if (!values['no-model'] && ground.checkouts !== null) {
      try {
        let script
        if (values['mock-script'] !== undefined) {
          script = safeJsonParse(await readFile(values['mock-script'], 'utf8'), decodeScript)
          if (script === null)
            throw new Error(`${values['mock-script']} is not a valid mock script`)
        }
        const selected = selectProvider(
          { kind: providerKind, model: values.model, baseUrl: values['base-url'], script },
          io.env,
        )
        context = await buildReviewContext({
          checkouts: ground.checkouts,
          ...(budgetChars !== undefined ? { budgetChars } : {}),
        })
        const eventLines: string[] = []
        const turnId = `review-${stage0.headCommit?.slice(0, 10) ?? 'head'}`
        stage2 = await runStage2({
          provider: selected.provider,
          model: selected.model,
          lens: CORRECTNESS_LENS,
          context,
          headCheckout: ground.checkouts.head,
          cell: ground.cell,
          shellDecision,
          scrub: (text) => ground.scrub(text),
          threadId: `copse-review:${stage0.repositoryRoot}`,
          turnId,
          ...(io.signal ? { signal: io.signal } : {}),
          ...(maxSteps !== undefined ? { maxSteps } : {}),
          onEvent: (event) => {
            const line = serializeHeadlessEvent(event)
            if (values.events === '-') io.stdout(`${line}\n`)
            else eventLines.push(line)
          },
        })
        if (values.events !== undefined && values.events !== '-') {
          await writeFile(values.events, `${eventLines.join('\n')}\n`, 'utf8')
        }
      } catch (err) {
        modelError = errorMessage(err)
      }
    } else if (!values['no-model']) {
      modelError = ground.decision.execute
        ? 'no checkouts were materialised'
        : `not executed: ${ground.decision.reason}`
    }

    const report = assembleReviewReport({ stage0, context, stage2, startedAt })
    if (values.json !== undefined) {
      const json = JSON.stringify(report, null, 2)
      if (values.json === '-') io.stdout(`${json}\n`)
      else await writeFile(values.json, `${json}\n`, 'utf8')
    }
    if (values.sarif !== undefined) {
      const sarif = toSarif(report.findings, {
        toolVersion: CLI_VERSION,
        repositoryRoot: stage0.repositoryRoot,
        headCommit: stage0.headCommit,
      })
      await writeFile(values.sarif, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8')
    }
    if (!values.quiet && values.json !== '-' && values.events !== '-') {
      io.stdout(`${renderReviewReport(report)}\n`)
    }
    if (modelError !== null) io.stderr(`copse-review: model review did not run: ${modelError}\n`)

    if (!ground.decision.execute) return HEADLESS_EXIT.APPROVAL_REQUIRED
    if (stage0.coverage.notChecked.some((note) => note.kind === 'all')) return HEADLESS_EXIT.USAGE
    if (io.signal?.aborted) return HEADLESS_EXIT.CANCELLED
    if (modelError !== null || stage2?.outcome === 'failed') return HEADLESS_EXIT.FAILURE
    return HEADLESS_EXIT.SUCCESS
  } finally {
    await ground.close()
  }
}
