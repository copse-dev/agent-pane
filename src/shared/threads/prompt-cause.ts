/**
 * Why a permission prompt interrupted the user (plans: `deferred-approvals.md`
 * phase D0, `unattended-runs.md` phase U0).
 *
 * The durable decision log (`decision-log.ts`) already records *what* was decided
 * and *how it settled*. It does not record *why the user was asked at all*, so
 * "which interruptions could we remove, and by what means?" is currently an
 * anecdote rather than a measurement. Every interactive gate path tags its
 * decision with one {@link PromptCause}, and each cause carries a fixed
 * {@link PromptCauseContainment} judgement: would running the work inside a
 * container have removed this prompt?
 *
 * That judgement is the gate on building a container runtime at all. If real
 * long runs are dominated by `kept` causes — effects whose blast radius leaves
 * any runtime — then containment buys few prompts back and the answer is
 * deferral alone.
 *
 * Pure and Node-free so the renderer, the report script, and unit tests can all
 * use it.
 */

/**
 * The enumerated reasons a gate interrupts. Stable slugs: they are persisted in
 * `decisions.jsonl` and read back by tooling, so renaming one is a log-format
 * change. Add rather than repurpose.
 */
export const PROMPT_CAUSES = [
  // ── Shell ────────────────────────────────────────────────────────────────
  /** Up-front gate: the command must run outside the OS sandbox to work. */
  'shell-sandbox-escalation',
  /** A contained attempt already failed; asking to retry outside the sandbox. */
  'shell-sandbox-retry',
  /** The agent declared up front that it expects the sandbox to block this. */
  'shell-expected-sandbox-block',
  /** Contained run, but policy still wants a human (destructive shape, etc.). */
  'shell-in-sandbox',
  /** No OS sandbox backend on this platform, so nothing contains the command. */
  'shell-no-containment',
  /** ASRT's process-global network allowlist is widened for another process. */
  'shell-network-scope-overlap',
  /** A package install: arbitrary post-install code from a registry. */
  'shell-package-install',
  /** Guarded YOLO's harm gate found a destructive or irreversible shape. */
  'shell-guarded-yolo-harm',
  /** A background command wants to bind a local port. */
  'shell-port-binding',
  /** A command reads paths outside the project, with every path accounted for. */
  'shell-read-outside-project',

  // ── Terminal ─────────────────────────────────────────────────────────────
  /** Opening a terminal while the sandbox network scope is widened. */
  'terminal-network-widened',
  /** Opening a terminal on a remote (SSH) workspace. */
  'terminal-remote',
  /** Opening a terminal that will not be contained. */
  'terminal-unsandboxed',

  // ── Tools and origins ────────────────────────────────────────────────────
  /** An MCP tool call whose annotations do not clear it automatically. */
  'mcp-tool',
  /** A full-privilege custom tool. */
  'custom-tool',
  /** A GitHub write: PR, issue, comment, review, merge. */
  'github-write',
  /** A web fetch to an origin outside the allowlist. */
  'web-origin',
  /** In-app browser navigation to an origin outside the allowlist. */
  'browser-navigation',
  /** Revealing redacted PII to the model or the user. */
  'pii-reveal',
  /** Reaching a model-provider host that has not been approved. */
  'provider-host',
  /** Spending on a multi-model review/comparison run. */
  'review-spend',
  /** A hook returned `ask`, so the user decides. */
  'hook-ask',
  /** Sharing captured terminal output with the model. */
  'terminal-output-share',
  /** An ACP agent asked its host for permission. */
  'acp-permission',
  /** Installing or updating an ACP agent's packages. */
  'acp-package-setup',
  /**
   * Arming a mode the user themselves just asked for. Not an interruption —
   * counted so the log stays complete, and labelled so a reader discounts it.
   */
  'mode-arming',
] as const

export type PromptCause = (typeof PROMPT_CAUSES)[number]

const PROMPT_CAUSE_SET: ReadonlySet<string> = new Set<string>(PROMPT_CAUSES)

export function isPromptCause(value: unknown): value is PromptCause {
  return typeof value === 'string' && PROMPT_CAUSE_SET.has(value)
}

/**
 * Whether running the same work inside a Copse-provisioned container would have
 * removed this prompt.
 *
 * - `removed` — the prompt exists because the action reaches past a boundary the
 *   container supplies. Inside a disposable guest the blast radius dies with the
 *   container, so no human is needed.
 * - `kept` — the effect leaves any runtime by design (it writes to GitHub, sends
 *   traffic, spends money, reveals data) or the ask is user-authored. A container
 *   changes nothing about it.
 * - `mixed` — depends on the specific action, so it cannot be settled from the
 *   cause alone. Reported separately rather than folded into either side; a
 *   summary that quietly counted these as `removed` would overstate the case for
 *   building a runtime.
 */
export type PromptCauseContainment = 'removed' | 'kept' | 'mixed'

const CONTAINMENT: Readonly<Record<PromptCause, PromptCauseContainment>> = {
  'shell-sandbox-escalation': 'removed',
  'shell-sandbox-retry': 'removed',
  'shell-expected-sandbox-block': 'removed',
  'shell-in-sandbox': 'removed',
  'shell-no-containment': 'removed',
  // The overlap prompt is an artifact of ASRT's allowlist being process-global.
  // A per-runtime container has its own network namespace, so the overlap that
  // triggers this prompt cannot arise.
  'shell-network-scope-overlap': 'removed',
  'shell-package-install': 'removed',
  // The harm gate covers both host-destructive shapes (contained) and
  // irreversible outward effects (not contained), so it cannot be settled here.
  'shell-guarded-yolo-harm': 'mixed',
  'shell-port-binding': 'removed',
  // The prompt exists because the read reaches the user's own filesystem past
  // the project. A container guest holds only the workspace, so there is no
  // host filesystem there to reach and the question does not arise.
  'shell-read-outside-project': 'removed',
  'terminal-network-widened': 'removed',
  // A remote terminal is a user-selected host, not something a local container
  // replaces.
  'terminal-remote': 'kept',
  'terminal-unsandboxed': 'removed',
  // An MCP server or custom tool may do anything from reading a file to filing a
  // ticket; the tool decides, not the runtime.
  'mcp-tool': 'mixed',
  'custom-tool': 'mixed',
  'github-write': 'kept',
  'web-origin': 'kept',
  'browser-navigation': 'kept',
  'pii-reveal': 'kept',
  'provider-host': 'kept',
  'review-spend': 'kept',
  'hook-ask': 'kept',
  'terminal-output-share': 'kept',
  // An ACP agent runs under its own host policy; a Copse container does not
  // decide what that agent asks for.
  'acp-permission': 'kept',
  'acp-package-setup': 'removed',
  'mode-arming': 'kept',
}

export function promptCauseContainment(cause: PromptCause): PromptCauseContainment {
  return CONTAINMENT[cause]
}

const LABELS: Readonly<Record<PromptCause, string>> = {
  'shell-sandbox-escalation': 'Shell: needs to run outside the sandbox',
  'shell-sandbox-retry': 'Shell: retry outside the sandbox after a block',
  'shell-expected-sandbox-block': 'Shell: agent expected a sandbox block',
  'shell-in-sandbox': 'Shell: contained but policy asked',
  'shell-no-containment': 'Shell: no sandbox available on this platform',
  'shell-network-scope-overlap': 'Shell: network scope widened elsewhere',
  'shell-package-install': 'Shell: package install',
  'shell-guarded-yolo-harm': 'Shell: Guarded YOLO harm gate',
  'shell-port-binding': 'Shell: binding a local port',
  'shell-read-outside-project': 'Shell: reads outside the project',
  'terminal-network-widened': 'Terminal: opened with widened network access',
  'terminal-remote': 'Terminal: remote workspace',
  'terminal-unsandboxed': 'Terminal: not contained',
  'mcp-tool': 'MCP tool call',
  'custom-tool': 'Custom tool call',
  'github-write': 'GitHub write action',
  'web-origin': 'Web fetch to a new origin',
  'browser-navigation': 'Browser navigation to a new origin',
  'pii-reveal': 'Revealing redacted PII',
  'provider-host': 'New model-provider host',
  'review-spend': 'Spend on a review run',
  'hook-ask': 'A hook asked for confirmation',
  'terminal-output-share': 'Sharing terminal output with the model',
  'acp-permission': 'ACP agent permission request',
  'acp-package-setup': 'ACP agent package setup',
  'mode-arming': 'Arming a mode (user-initiated, not an interruption)',
}

export function promptCauseLabel(cause: PromptCause): string {
  return LABELS[cause]
}

/** How a prompt settled, from the decision log's verdict vocabulary. */
export interface PromptOutcomeCounts {
  approved: number
  denied: number
  /** Timed out, cancelled, or resolved without a user verdict. */
  unresolved: number
}

export interface PromptCauseRow extends PromptOutcomeCounts {
  cause: PromptCause
  containment: PromptCauseContainment
  total: number
}

export interface PromptCauseSummary {
  /** Prompts carrying a recognised cause. */
  total: number
  /** Rows for causes that actually occurred, most frequent first. */
  rows: PromptCauseRow[]
  /** Totals split by what would have removed the prompt. */
  byContainment: Record<PromptCauseContainment, number>
  /**
   * Prompts recorded without a recognised cause. A non-zero count means a gate
   * path is uninstrumented — the summary is a lower bound until it reaches zero.
   */
  uncaused: number
}

/** The decision-log fields this module needs; keeps it decoupled from the event type. */
export interface PromptCauseInput {
  verdict: string
  cause?: string | undefined
}

const USER_VERDICTS: ReadonlySet<string> = new Set(['approved', 'denied'])

/**
 * Aggregate prompt decisions by cause. Only events that represent a prompt —
 * one that reached a user verdict, timed out, or was cancelled — are counted;
 * non-interactive `allowed`/`blocked` policy verdicts are not prompts and are
 * ignored, so the totals answer "how often were you interrupted?" rather than
 * "how many decisions were made?".
 */
export function summarizePromptCauses(events: readonly PromptCauseInput[]): PromptCauseSummary {
  const counts = new Map<PromptCause, PromptOutcomeCounts>()
  let uncaused = 0
  let total = 0

  for (const event of events) {
    const prompted =
      USER_VERDICTS.has(event.verdict) ||
      event.verdict === 'timeout' ||
      event.verdict === 'cancelled'
    if (!prompted) continue
    if (!isPromptCause(event.cause)) {
      uncaused++
      continue
    }
    total++
    const row = counts.get(event.cause) ?? { approved: 0, denied: 0, unresolved: 0 }
    if (event.verdict === 'approved') row.approved++
    else if (event.verdict === 'denied') row.denied++
    else row.unresolved++
    counts.set(event.cause, row)
  }

  const byContainment: Record<PromptCauseContainment, number> = { removed: 0, kept: 0, mixed: 0 }
  const rows: PromptCauseRow[] = []
  for (const [cause, outcome] of counts) {
    const containment = promptCauseContainment(cause)
    const rowTotal = outcome.approved + outcome.denied + outcome.unresolved
    byContainment[containment] += rowTotal
    rows.push({ cause, containment, total: rowTotal, ...outcome })
  }
  // Frequency first, then the stable slug, so equal counts never reorder between
  // runs of the same log.
  rows.sort((a, b) => b.total - a.total || a.cause.localeCompare(b.cause))

  return { total, rows, byContainment, uncaused }
}
