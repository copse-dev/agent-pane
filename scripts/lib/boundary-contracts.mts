// Pure half of the production-boundary contract lane (issue #1370): outcome
// classification, waiver expiry, secret redaction and report rendering. The
// targets themselves — the real network calls — live in
// scripts/boundary-contracts.mts. docs/boundary-contracts.md is the reader's
// guide to both.
//
// The one distinction this module exists to make is "our regression" versus
// "their outage". A scheduled lane that goes red whenever a provider has a bad
// hour gets ignored; one that stays green while a product contract is broken is
// worse. So an unexpected failure is classified by what the boundary said: a
// 429 is rate limiting, a 5xx / connection failure / timeout is a third-party
// outage, and everything else — a 4xx the product did not expect, a response
// that no longer decodes, a contract assertion — is a regression.

import { z } from 'zod'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

export const CONTRACT_OUTCOMES = [
  'pass',
  'regression',
  'outage',
  'rate-limited',
  'skipped',
  'waived',
] as const
export type ContractOutcome = (typeof CONTRACT_OUTCOMES)[number]

export interface ContractResult {
  readonly target: string
  readonly contract: string
  readonly outcome: ContractOutcome
  /** Human-readable reason. Already redacted when it reaches a report. */
  readonly detail: string
  readonly durationMs: number
}

/**
 * A contract assertion that failed against a boundary that answered normally.
 * Always a regression: the upstream was up and said something the product does
 * not handle.
 */
export class ContractViolation extends Error {
  override readonly name = 'ContractViolation'
}

/** The contract's own deadline elapsed before the boundary answered. */
export class ContractTimeout extends Error {
  override readonly name = 'ContractTimeout'
}

/** Duck-typed HTTP status, the same shape the provider SDKs and `fetch` wrappers expose. */
export function errorStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined
  const status = err['status']
  return typeof status === 'number' ? status : undefined
}

/**
 * The status to classify a response by. GitHub reports an exhausted primary or
 * secondary rate limit as 403 with `x-ratelimit-remaining: 0` or a
 * `retry-after` header, not only as 429; read as a plain 403 that would be
 * filed as a product regression every time the hourly budget runs out.
 */
export function effectiveStatus(status: number, headers: Headers): number {
  if (status !== 403) return status
  const exhausted = headers.get('x-ratelimit-remaining') === '0'
  return exhausted || headers.has('retry-after') ? 429 : status
}

/** Transport-level failures: nothing answered, so nothing can be a product verdict. */
const TRANSPORT_FAILURE =
  /fetch failed|socket hang up|econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enet(unreachable|down)|connection error|network/i

function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') return true
  if (err.name === 'TimeoutError') return true
  const cause: unknown = err.cause
  return TRANSPORT_FAILURE.test(err.message) || (cause !== err && isTransportFailure(cause))
}

/** Classify an error thrown by a contract that expected the boundary to succeed. */
export function classifyFailure(err: unknown): { outcome: ContractOutcome; detail: string } {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  if (err instanceof ContractViolation) return { outcome: 'regression', detail: err.message }
  if (err instanceof ContractTimeout) return { outcome: 'outage', detail: err.message }
  const status = errorStatus(err)
  if (status === 429) return { outcome: 'rate-limited', detail: `HTTP 429 — ${message}` }
  if (status !== undefined && (status >= 500 || status === 408)) {
    return { outcome: 'outage', detail: `HTTP ${String(status)} — ${message}` }
  }
  if (status === undefined && isTransportFailure(err)) return { outcome: 'outage', detail: message }
  return {
    outcome: 'regression',
    detail: status === undefined ? message : `HTTP ${String(status)} — ${message}`,
  }
}

/**
 * Classify the status of a DEGRADED call — one the contract expects to fail.
 * `expected` lists the statuses the product handles for this case; an outage
 * status still means "could not tell", never a pass or a regression.
 */
export function classifyExpectedFailure(
  status: number | undefined,
  expected: readonly number[],
  what: string,
): { outcome: ContractOutcome; detail: string } {
  if (status !== undefined && expected.includes(status)) {
    return { outcome: 'pass', detail: `${what} answered HTTP ${String(status)}` }
  }
  if (status === 429) return { outcome: 'rate-limited', detail: `${what} answered HTTP 429` }
  if (status !== undefined && status >= 500) {
    return { outcome: 'outage', detail: `${what} answered HTTP ${String(status)}` }
  }
  return {
    outcome: 'regression',
    detail: `${what} answered ${status === undefined ? 'with no HTTP status' : `HTTP ${String(status)}`}; expected ${expected.join(' or ')}`,
  }
}

// ── Waivers ─────────────────────────────────────────────────────────────────

/** A waiver may run at most this long. Renewing one is a reviewed edit, not a default. */
export const MAX_WAIVER_DAYS = 60

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

export const waiverSchema = z
  .object({
    target: z.string().min(1),
    /** A contract id, or `*` for the whole target. */
    contract: z.string().min(1),
    /** Tracking issue URL: a waiver without an owner-visible issue is a silent skip. */
    issue: z.url().regex(/^https:\/\/github\.com\/copse-dev\/agent-pane\/issues\/\d+$/),
    reason: z.string().min(10),
    expires: isoDate,
  })
  .strict()
export type Waiver = z.infer<typeof waiverSchema>

export const waiverFileSchema = z.object({ waivers: z.array(waiverSchema) }).strict()

/** `target/contract` pairs a waiver may name. */
export type ContractMatrix = ReadonlyMap<string, readonly string[]>

function dayNumber(isoDay: string): number {
  return Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / 86_400_000)
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Problems with the waiver file itself. Each is reported as a regression. */
export function validateWaivers(
  waivers: readonly Waiver[],
  matrix: ContractMatrix,
  now: Date,
): ContractResult[] {
  const today = dayNumber(todayIso(now))
  const problems: ContractResult[] = []
  for (const waiver of waivers) {
    const contracts = matrix.get(waiver.target)
    const label = `${waiver.target}/${waiver.contract}`
    const problem = (detail: string): void => {
      problems.push({
        target: waiver.target,
        contract: waiver.contract,
        outcome: 'regression',
        detail: `waiver ${label}: ${detail} (${waiver.issue})`,
        durationMs: 0,
      })
    }
    if (!contracts) {
      problem('names an unknown target')
      continue
    }
    if (waiver.contract !== '*' && !contracts.includes(waiver.contract)) {
      problem('names an unknown contract')
      continue
    }
    const expires = dayNumber(waiver.expires)
    if (Number.isNaN(expires)) problem(`has an invalid expiry ${waiver.expires}`)
    else if (expires < today) problem(`expired on ${waiver.expires}`)
    else if (expires - today > MAX_WAIVER_DAYS) {
      problem(`expires ${waiver.expires}, more than ${String(MAX_WAIVER_DAYS)} days out`)
    }
  }
  return problems
}

/** Whether `waiver` is in force today: not expired and within the maximum horizon. */
function isLive(waiver: Waiver, now: Date): boolean {
  const days = dayNumber(waiver.expires) - dayNumber(todayIso(now))
  return days >= 0 && days <= MAX_WAIVER_DAYS
}

function covers(waiver: Waiver, result: ContractResult): boolean {
  return (
    waiver.target === result.target &&
    (waiver.contract === '*' || waiver.contract === result.contract)
  )
}

/**
 * Downgrade a non-passing result covered by a live waiver to `waived`. Passing
 * and skipped results are left alone, so a waiver that is no longer needed
 * shows up as "waived contract passed" in the report rather than hiding.
 */
export function applyWaivers(
  results: readonly ContractResult[],
  waivers: readonly Waiver[],
  now: Date,
): ContractResult[] {
  return results.map((result) => {
    if (result.outcome === 'pass' || result.outcome === 'skipped') return result
    const waiver = waivers.find((w) => covers(w, result) && isLive(w, now))
    if (!waiver) return result
    return {
      ...result,
      outcome: 'waived',
      detail: `${result.outcome} waived until ${waiver.expires} (${waiver.issue}): ${result.detail}`,
    }
  })
}

/** Passing contracts that still carry a live waiver: candidates to delete. */
export function staleWaivers(
  results: readonly ContractResult[],
  waivers: readonly Waiver[],
  now: Date,
): Waiver[] {
  return waivers.filter((waiver) => {
    if (!isLive(waiver, now)) return false
    const covered = results.filter((r) => covers(waiver, r))
    return covered.length > 0 && covered.every((r) => r.outcome === 'pass')
  })
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * Every string that leaves the runner — console, step summary, annotations,
 * JSON artifact — goes through this. Literal secret values come first (an
 * upstream that echoes the key back is the realistic leak), then the shared
 * credential-shape patterns catch anything else that looks like a token.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const literals = secrets.filter((s) => s.length > 0)
  return (text) => redactSecrets(text, literals)
}

// ── Reporting ───────────────────────────────────────────────────────────────

export interface ContractReport {
  readonly startedAt: string
  readonly finishedAt: string
  /** Commit the contracts ran from (GITHUB_SHA), when known. */
  readonly sha: string | null
  /** Run URL, when running in Actions. */
  readonly runUrl: string | null
  readonly results: readonly ContractResult[]
  readonly staleWaivers: readonly Waiver[]
}

export function countOutcomes(results: readonly ContractResult[]): Record<ContractOutcome, number> {
  const counts: Record<ContractOutcome, number> = {
    pass: 0,
    regression: 0,
    outage: 0,
    'rate-limited': 0,
    skipped: 0,
    waived: 0,
  }
  for (const r of results) counts[r.outcome] += 1
  return counts
}

/**
 * 1 when any contract regressed (including a broken or expired waiver); 0
 * otherwise. Outages and rate limits do not fail the run: they are annotated as
 * warnings, because a red run that means "a vendor had a bad hour" trains
 * everyone to ignore the lane.
 */
export function exitCodeFor(results: readonly ContractResult[]): number {
  return results.some((r) => r.outcome === 'regression') ? 1 : 0
}

const OUTCOME_MARK: Record<ContractOutcome, string> = {
  pass: 'PASS',
  regression: 'FAIL',
  outage: 'OUTAGE',
  'rate-limited': 'RATE-LIMITED',
  skipped: 'SKIP',
  waived: 'WAIVED',
}

export function formatConsoleLine(result: ContractResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1)
  return `${OUTCOME_MARK[result.outcome].padEnd(12)} ${result.target}/${result.contract} (${seconds}s) ${result.detail}`
}

function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderMarkdown(report: ContractReport): string {
  const counts = countOutcomes(report.results)
  const lines = [
    '## Production-boundary contracts',
    '',
    `Ran ${report.startedAt} → ${report.finishedAt}` +
      (report.sha ? ` at \`${report.sha.slice(0, 12)}\`` : '') +
      (report.runUrl ? ` ([run](${report.runUrl}))` : '') +
      '.',
    '',
    CONTRACT_OUTCOMES.map((o) => `${OUTCOME_MARK[o]}: ${String(counts[o])}`).join(' · '),
    '',
    '| Outcome | Target | Contract | Time | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...report.results.map(
      (r) =>
        `| ${OUTCOME_MARK[r.outcome]} | ${r.target} | ${r.contract} | ${(r.durationMs / 1000).toFixed(1)}s | ${tableCell(r.detail)} |`,
    ),
  ]
  if (report.staleWaivers.length > 0) {
    lines.push('', '**Waivers whose contracts now pass — delete them:**', '')
    for (const w of report.staleWaivers) lines.push(`- ${w.target}/${w.contract} (${w.issue})`)
  }
  lines.push('', 'See docs/boundary-contracts.md for what each outcome means.', '')
  return lines.join('\n')
}

/** GitHub workflow-command escaping for annotation messages. */
function escapeAnnotation(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** `::error::` for regressions, `::warning::` for third-party trouble; nothing else is annotated. */
export function renderAnnotations(results: readonly ContractResult[]): string[] {
  const out: string[] = []
  for (const r of results) {
    const level =
      r.outcome === 'regression'
        ? 'error'
        : r.outcome === 'outage' || r.outcome === 'rate-limited'
          ? 'warning'
          : null
    if (!level) continue
    const title = escapeAnnotation(`${r.target}/${r.contract} ${OUTCOME_MARK[r.outcome]}`)
    out.push(`::${level} title=${title.replace(/[,:]/g, ' ')}::${escapeAnnotation(r.detail)}`)
  }
  return out
}
