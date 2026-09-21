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
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { buildReviewContext } from './context.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import type { IsolationBackend } from './isolation.ts'
import { resolveLenses } from './lenses.ts'
import { serializeCell } from './isolation.ts'
import {
  isProviderKind,
  selectProvider,
  PROVIDER_KINDS,
  type ProviderKind,
} from './provider-selection.ts'
import { renderReviewReport } from './report-text.ts'
import { toSarif } from './sarif.ts'
import { decodeMockScript, type MockScript } from './scripted-provider.ts'
import { openReviewGround, runStage0Checks } from './stage0.ts'
import { runReviewers, type Stage2Result } from './stage2.ts'
import { verifyFindings, type Stage4Result } from './stage4.ts'
import { assembleReviewReport, canonicalFindings } from './stage5.ts'
import type { Finding } from './finding.ts'

export const CLI_VERSION = '0.1.0'

export const USAGE = `usage: copse-review [options]

Review the current repository's working tree against a base ref: build, typecheck,
lint and test on head and base (Stage 0); then models × lenses review it (Stages 1–2),
their candidates are clustered (Stage 3) and verified by reproducer and by an adversarial
challenger (Stage 4), and the survivors are ranked (Stage 5). Findings are the output,
never the exit code.

  --base <ref>            the ref the change is against (default: origin/main, else main)
  --allow-unisolated      consent to run your own tree with no isolation backend
  --no-model              Stage 0 only; no model is called
  --provider <kind>       ${PROVIDER_KINDS.join(' | ')} (default: inferred from --model)
  --model <id>            model id for the reviewer (repeat, or comma-separate, to fan out)
  --lenses <ids|all>      lenses to run: correctness (default), contracts, tests, security, concurrency
  --challenger <id>       model that challenges and writes reproducers (default: the first --model)
  --no-verify             skip Stage 4 (no reproducers, no challenge)
  --max-verify <n>        findings to verify, most promising first (default 10)
  --concurrency <n>       reviewers running at once (default 2)
  --base-url <url>        endpoint for lmstudio / openai-compatible
  --mock-script <path>    scripted steps for --provider mock (a list, or {roles:{...}})
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
        model: { type: 'string', multiple: true },
        lenses: { type: 'string' },
        challenger: { type: 'string' },
        'no-verify': { type: 'boolean', default: false },
        'max-verify': { type: 'string' },
        concurrency: { type: 'string' },
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

  let providerKind: ProviderKind | undefined
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
  let maxVerify: number | undefined
  let concurrency: number | undefined
  let lenses
  try {
    budgetChars = integer(values['budget-chars'], '--budget-chars')
    maxSteps = integer(values['max-steps'], '--max-steps')
    maxVerify = integer(values['max-verify'], '--max-verify')
    concurrency = integer(values.concurrency, '--concurrency')
    lenses = resolveLenses(values.lenses)
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

    let reviews: Stage2Result[] = []
    let verification: Stage4Result | null = null
    let findings: Finding[] = stage0.findings.slice()
    let context = null
    let modelError: string | null = null
    if (!values['no-model'] && ground.checkouts !== null) {
      try {
        let script: MockScript | undefined
        if (values['mock-script'] !== undefined) {
          const parsedScript = safeJsonParse(
            await readFile(values['mock-script'], 'utf8'),
            decodeMockScript,
          )
          if (parsedScript === null) {
            throw new Error(`${values['mock-script']} is not a valid mock script`)
          }
          script = parsedScript
        }
        const modelIds = (values.model ?? [])
          .flatMap((entry) => entry.split(','))
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
        const selections = (modelIds.length === 0 ? [undefined] : modelIds).map((model) =>
          selectProvider(
            { kind: providerKind, model, baseUrl: values['base-url'], script },
            io.env,
          ),
        )
        const first = selections[0]
        if (first === undefined) throw new Error('no model selected')
        const challengerSelection =
          values.challenger === undefined
            ? first
            : selectProvider(
                {
                  kind: providerKind,
                  model: values.challenger,
                  baseUrl: values['base-url'],
                  script,
                },
                io.env,
              )
        context = await buildReviewContext({
          checkouts: ground.checkouts,
          ...(budgetChars !== undefined ? { budgetChars } : {}),
        })
        const eventLines: string[] = []
        const onEvent = (event: Parameters<typeof serializeHeadlessEvent>[0]): void => {
          const line = serializeHeadlessEvent(event)
          if (values.events === '-') io.stdout(`${line}\n`)
          else eventLines.push(line)
        }
        const cell = ground.cell === null ? null : serializeCell(ground.cell)
        const threadId = `copse-review:${stage0.repositoryRoot}`
        const turnPrefix = `review-${stage0.headCommit?.slice(0, 10) ?? 'head'}`
        const host = {
          context,
          headCheckout: ground.checkouts.head,
          cell,
          shellDecision,
          scrub: (text: string): string => ground.scrub(text),
        }
        reviews = await runReviewers({
          ...host,
          reviewers: selections.map((selection) => ({
            model: selection.model,
            providerFor: (lens): LLMProvider => selection.providerFor(`review:${lens.id}`),
          })),
          lenses,
          threadId,
          turnPrefix,
          concurrency,
          signal: io.signal,
          onEvent,
          maxSteps,
        })
        findings = canonicalFindings(stage0, reviews)
        if (!values['no-verify']) {
          const role = (name: string): { model: string; provider: LLMProvider } => ({
            model: challengerSelection.model,
            provider: challengerSelection.providerFor(name),
          })
          verification = await verifyFindings({
            ...host,
            baseCheckout: ground.checkouts.base,
            findings,
            reproducer: role('reproduce'),
            challenger: role('challenge'),
            threadId,
            turnPrefix,
            maxVerified: maxVerify,
            signal: io.signal,
            onEvent,
          })
          findings = [...verification.findings]
        }
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

    const report = assembleReviewReport({
      stage0,
      context,
      reviews,
      verification,
      findings,
      startedAt,
    })
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
    if (modelError !== null || reviews.some((review) => review.outcome === 'failed')) {
      return HEADLESS_EXIT.FAILURE
    }
    return HEADLESS_EXIT.SUCCESS
  } finally {
    await ground.close()
  }
}
