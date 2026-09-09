import type { BrowserWindow, IpcMain } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  abortAllAcpPermissions,
  cancelApprovalsForAcpToolCall,
  trackAcpPermissionToolCall,
} from './acp/acp-permission-registry.ts'

// Re-exported so existing importers keep using `approval.ts` as the entry point.
export { cancelApprovalsForAcpToolCall, trackAcpPermissionToolCall }
import { randomUUID } from 'node:crypto'
import {
  approvalRespondSchema,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
} from '../ipc/ipc-guards.ts'
import { getActiveRunThread } from './thread-models.ts'
import { withRunDeadlinePaused } from './hooks/run-deadline.ts'
import { recordDecision } from './security/decision-log-store.ts'
import type { PromptCause } from '@shared/threads/prompt-cause.ts'
import {
  DeferredApprovalError,
  deferredApprovalMessage,
} from '@shared/threads/deferred-approval.ts'
import { isDeferralModeActive } from './security/deferral-mode.ts'
import { deferApproval } from './security/deferred-approval-store.ts'
import type { UserAlertSender } from './user-alerts.ts'
import { resolveRendererPromptTarget } from './renderer-prompt-target.ts'
import { getAgentExecutionRoot } from './execution-root.ts'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * Abort reason a transport passes when the CALLER went away but the user's
 * answer is still wanted.
 *
 * The ACP native bridge aborts a tool call with this when the external agent
 * abandons the MCP request — Codex's client gives up on a silent call after
 * roughly 300 s, and any approval the user takes more than five minutes to
 * click used to be cancelled underneath them, with the agent seeing a bare
 * failure. An abort carrying this reason is a *detach*, not a cancel: the
 * prompt stays open, the caller is told to retry (see
 * {@link ApprovalPendingError}), and the eventual verdict is kept for a bounded
 * time so the retry reuses it without prompting again.
 *
 * `AbortSignal.any` propagates the first source's reason to the merged signal,
 * so the bridge can keep merging its per-call abort with the turn and session
 * aborts and this module still tells the three apart.
 */
export class AbandonedCallAbort extends Error {
  override readonly name = 'AbandonedCallAbort'

  constructor(detail = 'the tool call was abandoned by its client') {
    super(detail)
  }
}

export function isAbandonedCallAbort(reason: unknown): boolean {
  if (reason instanceof AbandonedCallAbort) return true
  return isRecord(reason) && reason['name'] === 'AbandonedCallAbort'
}

/**
 * Thrown to the caller whose call was abandoned while its prompt stays open.
 * A throw rather than a denial for the same reason {@link DeferredApprovalError}
 * is one: every gate caller reads `approved === false` as "the user declined"
 * and carries on quietly, and this must reach the agent as a clear instruction.
 */
export class ApprovalPendingError extends Error {
  override readonly name = 'ApprovalPendingError'

  constructor(title: string) {
    super(approvalPendingMessage(title))
  }
}

export function approvalPendingMessage(title: string): string {
  return (
    `Approval is still pending in Copse ("${title}"): this tool call was abandoned ` +
    `before the user answered, but the prompt stays open. Do not treat this as a denial. ` +
    `Retry the exact same call (same command, working directory and arguments); once the ` +
    `user answers, the retry reuses that answer without prompting again, for up to ` +
    `${String(ABANDONED_VERDICT_TTL_MS / 60_000)} minutes.`
  )
}

/** How long an abandoned call's verdict is kept for an identical retry. */
export const ABANDONED_VERDICT_TTL_MS = 10 * 60_000

/** Model ids for a two-reviewer + judge comparison run. */
export interface ComparisonModelSelection {
  a: string
  b: string
  judge: string
}

export interface ApprovalRequest {
  title: string
  body: string
  /** Explanatory copy rendered outside the monospaced command block when set. */
  bodyAdvice?: string
  /** Call-to-action or trailing context rendered below the command block when set. */
  bodyFooter?: string
  type: 'shell' | 'mcp' | 'web' | 'pii' | 'model-compare' | 'review-spend'
  allowRemember?: boolean
  rememberLabel?: string
  /**
   * Hide the body behind a "Show details" disclosure, so the prompt leads with
   * the decision rather than the command. Honoured only for a single-request
   * prompt; a coalesced batch always shows every body.
   */
  collapseDetails?: boolean
  /**
   * Label for a secondary approve button that approves *only this request*
   * (`remember: false`), leaving the primary button to carry the broader grant
   * (`remember: true`) with no checkbox. Like {@link collapseDetails} it is
   * honoured only for a single-request prompt: in a mixed batch the primary
   * button falls back to the checkbox, so an unrelated request can never be
   * swept into a grant the user answered for something else.
   */
  approveOnceLabel?: string
  /** Intentional Settings-owned flow that must prompt above the open Settings dialog. */
  showWhileSettingsOpen?: boolean
  /** Initial reviewer/judge ids when `type === 'model-compare'` (renderer shows pickers). */
  comparisonModels?: ComparisonModelSelection
  /** Offer a bounded main-process lease for exact retries in this turn tree. */
  allowTurnTreeLease?: boolean
  /** User-facing lease scope; required whenever `allowTurnTreeLease` is true. */
  turnTreeLeaseLabel?: string
  /** Whether approving also grants the bounded task lease without another user action. */
  turnTreeLeaseDefault?: boolean
  /**
   * What the offered lease would actually cover — the exact command, not the
   * display label. Required whenever `allowTurnTreeLease` is true.
   *
   * The label is a fixed string shared by every shell prompt, so it cannot tell
   * two batched requests apart. A batch settles with ONE tick box but issues one
   * lease per request, so without a per-request identity a single tick would
   * grant leases for unrelated commands under a label reading "this task". The
   * renderer hides the box unless every batched request shares this subject —
   * the same coherence rule `rememberLabel` gets, on a value that discriminates.
   */
  turnTreeLeaseSubject?: string
  /** Secret-free operation or tool name stored in the durable decision log. */
  subject?: string
  /** Scope the decision applies at, such as `sandbox` or `external`. */
  scope?: string
  /**
   * Why this prompt is interrupting the user, recorded to the durable decision
   * log so interruptions can be counted by cause rather than estimated. Every
   * interactive gate path should set it; see `@shared/threads/prompt-cause.ts`.
   *
   * Distinct from `reasons` below: this is the fixed taxonomy slug the report
   * aggregates on, while `reasons` is the free-text detail of *this* request.
   */
  cause?: PromptCause
  /**
   * Why the prompt was raised, recorded verbatim on the decision-log line this
   * answer produces. Durable shell decisions omit the command itself
   * (`SHELL_DECISION_SUBJECT`), so a gate that can name *what* it is asking
   * about — the paths a read touches, the origin a fetch reaches — passes it
   * here to leave the answer legible in the log. Redacted at record time; keep
   * it secret-free at the call site anyway.
   */
  reasons?: string[]
}

export interface ApprovalResponse {
  approved: boolean
  remember: boolean
  /** Scope selected for this approval; absent is the backwards-compatible one-shot grant. */
  grantScope?: 'once' | 'turn-tree'
  /**
   * How the prompt settled; omitted by external handlers means a user decision.
   * There is no wall-clock timeout — `timeout` remains in the union for older
   * recorded logs / handlers that still emit it.
   */
  resolution?: 'user' | 'timeout' | 'window-closed' | 'unavailable'
  /** User-selected models from the comparison approval pickers. */
  comparisonModels?: ComparisonModelSelection
}

const DENIED: ApprovalResponse = { approved: false, remember: false }

/**
 * Fingerprint for coalescing identical in-flight approval prompts. Parallel tool
 * calls (and ACP `session/request_permission` bursts) often ask the same question
 * twice; one dialog row should answer every waiter.
 */
export function approvalDedupeKey(req: ApprovalRequest): string {
  return JSON.stringify({
    title: req.title,
    body: req.body,
    bodyAdvice: req.bodyAdvice ?? '',
    bodyFooter: req.bodyFooter ?? '',
    type: req.type,
    allowRemember: req.allowRemember ?? false,
    rememberLabel: req.rememberLabel ?? '',
    collapseDetails: req.collapseDetails ?? false,
    approveOnceLabel: req.approveOnceLabel ?? '',
    // Part of the key so two prompts that read alike but are *about* different
    // things can never share one answer — and one recorded line.
    reasons: req.reasons ?? [],
    showWhileSettingsOpen: req.showWhileSettingsOpen ?? false,
    comparisonModels: req.comparisonModels ?? null,
    allowTurnTreeLease: req.allowTurnTreeLease ?? false,
    turnTreeLeaseLabel: req.turnTreeLeaseLabel ?? '',
    turnTreeLeaseDefault: req.turnTreeLeaseDefault ?? false,
    turnTreeLeaseSubject: req.turnTreeLeaseSubject ?? '',
  })
}

/**
 * Transport that actually asks for approval. The GUI registers a
 * BrowserWindow/IPC handler (see {@link initApproval}); a headless host (the ACP
 * agent) registers one that maps to its own permission channel. With no handler
 * set, approvals are denied rather than left hanging.
 */
export type ApprovalHandler = (
  req: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalResponse>

let handler: ApprovalHandler | null = null
interface ScopedApprovalHandler {
  readonly handler: ApprovalHandler
  readonly dedupePrefix: string
}

const scopedHandler = new AsyncLocalStorage<ScopedApprovalHandler>()
let nextScopedHandlerId = 0

/** Scope non-interactive approvals to one headless run without replacing the desktop handler. */
export function runWithApprovalHandler<T>(next: ApprovalHandler, fn: () => T): T {
  nextScopedHandlerId++
  return scopedHandler.run(
    { handler: next, dedupePrefix: `headless-${String(nextScopedHandlerId)}` },
    fn,
  )
}

/** In-flight coalesced approvals keyed by {@link approvalDedupeKey}. */
interface InflightApproval {
  /** Aborts the underlying handler prompt once every waiter has left. */
  controller: AbortController
  waiters: Set<InflightWaiter>
}

interface InflightWaiter {
  resolve: (response: ApprovalResponse) => void
  signal: AbortSignal | undefined
  onAbort: () => void
  /** Thread that opened this waiter; used to dismiss orphans when the turn ends. */
  threadId: string | null
  /**
   * Set on the waiter that stands in for an abandoned caller: it keeps the
   * shared prompt open and, when the user answers, records the verdict under
   * this key instead of returning it to anyone. Never a real caller.
   */
  ledgerKey?: string
}

const inflight = new Map<string, InflightApproval>()

/**
 * Verdicts whose callers were gone by the time the user answered, keyed by
 * thread + execution root + the prompt's own dedupe key — "the same command in
 * the same directory of the same thread". Consumed by the first identical
 * request within {@link ABANDONED_VERDICT_TTL_MS}; one answer authorises one
 * run, exactly as it would have had the caller stayed. Session-only, like the
 * rest of this module's state.
 */
interface StoredVerdict {
  response: ApprovalResponse
  settledAt: number
}

const abandonedVerdicts = new Map<string, StoredVerdict>()
let approvalClock: () => number = () => Date.now()

/** Test helper — replace the clock the abandoned-verdict window is measured on. */
export function setApprovalClockForTest(clock: (() => number) | null): void {
  approvalClock = clock ?? ((): number => Date.now())
}

/** Test helper — forget every stored verdict. */
export function clearAbandonedVerdictsForTest(): void {
  abandonedVerdicts.clear()
}

function abandonedVerdictKey(threadId: string, promptKey: string): string {
  return `${threadId}\u0000${getAgentExecutionRoot() ?? ''}\u0000${promptKey}`
}

function storeAbandonedVerdict(ledgerKey: string, response: ApprovalResponse): void {
  const now = approvalClock()
  for (const [key, entry] of abandonedVerdicts) {
    if (now - entry.settledAt > ABANDONED_VERDICT_TTL_MS) abandonedVerdicts.delete(key)
  }
  abandonedVerdicts.set(ledgerKey, { response, settledAt: now })
}

function takeAbandonedVerdict(ledgerKey: string): ApprovalResponse | null {
  const entry = abandonedVerdicts.get(ledgerKey)
  if (!entry) return null
  abandonedVerdicts.delete(ledgerKey)
  if (approvalClock() - entry.settledAt > ABANDONED_VERDICT_TTL_MS) return null
  return entry.response
}

/** How many prompts are being held open for abandoned callers (diagnostics/tests). */
export function parkedApprovalCount(): number {
  let count = 0
  for (const entry of inflight.values()) {
    for (const waiter of entry.waiters) if (waiter.ledgerKey !== undefined) count++
  }
  return count
}

/** A stored verdict handed to an identical retry: the user's answer, replayed. */
function recordReplayedDecision(req: ApprovalRequest, response: ApprovalResponse): void {
  recordDecision({
    kind: req.type,
    actor: 'user',
    verdict: response.approved ? 'approved' : 'denied',
    subject: req.subject ?? req.title,
    ...(req.scope ? { scope: req.scope } : {}),
    ...(req.cause ? { cause: req.cause } : {}),
    ...(req.reasons?.length ? { reasons: req.reasons } : {}),
    remembered: response.remember,
    source: 'abandoned-call-replay',
  })
}

/** Best-effort: persistence never blocks the approval flow it describes. */
function recordApprovalDecision(
  req: ApprovalRequest,
  response: ApprovalResponse,
  resolutionOverride?: string,
): void {
  const resolution = resolutionOverride ?? response.resolution ?? 'user'
  recordDecision({
    kind: req.type,
    actor: resolution === 'user' ? 'user' : 'system',
    verdict:
      resolution === 'user'
        ? response.approved
          ? 'approved'
          : 'denied'
        : resolution === 'timeout'
          ? 'timeout'
          : resolution === 'deferred'
            ? 'deferred'
            : 'cancelled',
    subject: req.subject ?? req.title,
    ...(req.scope ? { scope: req.scope } : {}),
    ...(req.cause ? { cause: req.cause } : {}),
    ...(req.reasons?.length ? { reasons: req.reasons } : {}),
    remembered: response.remember,
    ...(resolution === 'user' ? {} : { source: resolution }),
  })
}

export function setApprovalHandler(next: ApprovalHandler | null): void {
  handler = next
  // Drop coalesced waiters when the transport is torn down (tests / shutdown) so
  // the next handler never inherits a stale shared prompt.
  if (!next) {
    for (const entry of inflight.values()) {
      entry.controller.abort()
      for (const waiter of entry.waiters) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        // A parked prompt torn down with the transport was never answered;
        // storing a denial would replay one the user did not give.
        if (waiter.ledgerKey !== undefined) continue
        waiter.resolve(DENIED)
      }
    }
    inflight.clear()
    abandonedVerdicts.clear()
    abortAllAcpPermissions()
  }
}

function settleInflight(
  key: string,
  entry: InflightApproval,
  response: ApprovalResponse,
  req: ApprovalRequest,
): void {
  if (inflight.get(key) !== entry) return
  inflight.delete(key)
  // One shared prompt → one audit event (not one per coalesced waiter).
  recordApprovalDecision(req, response)
  for (const waiter of entry.waiters) {
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(response)
  }
  entry.waiters.clear()
}

/**
 * Dismiss every in-flight approval waiter owned by `threadId` (deny + tear down
 * the dialog when no other threads remain on the shared prompt).
 *
 * Called when an agent turn ends while a prompt is still open — e.g. an ACP
 * agent abandoned a bridged `run_shell` MCP call, streamed a summary, and
 * stopped the turn, leaving Copse's "Run outside sandbox?" modal orphaned.
 * Detectable in the UI as completed turn output (incl. Sandbox Network Audit)
 * behind a still-modal approval.
 */
export function cancelApprovalsForThread(threadId: string): number {
  let cancelled = 0
  for (const entry of [...inflight.values()]) {
    for (const waiter of [...entry.waiters]) {
      if (waiter.threadId !== threadId) continue
      waiter.onAbort()
      cancelled++
    }
  }
  return cancelled
}

/** How many in-flight approval waiters are attributed to `threadId`. */
export function pendingApprovalCountForThread(threadId: string): number {
  let count = 0
  for (const entry of inflight.values()) {
    for (const waiter of entry.waiters) {
      if (waiter.threadId === threadId) count++
    }
  }
  return count
}

/**
 * Ask the user (or registered handler) for approval. Identical in-flight requests
 * share one underlying prompt — the first call opens it; later duplicates wait on
 * the same answer. The prompt stays open until the user responds, the window
 * closes, or every waiter aborts (e.g. Stop / ACP `$/cancel_request`). There is
 * no wall-clock timeout: auto-denying after a few minutes let the agent continue
 * underneath an still-open dialog and was a common source of "Approve all (N)"
 * growth plus ACP session drops after long waits.
 *
 * While the prompt is open the active run's sliding idle deadline is paused so a
 * long think-before-click cannot abort the turn (and cancel the dialog) underneath
 * the user.
 *
 * Settled outcomes are appended to the durable decision log (best-effort).
 */
/**
 * Queue this request instead of prompting, when the thread is running
 * unattended. Returns null for the ordinary interactive case so the caller falls
 * through to the normal handler.
 *
 * Always rejects — never resolves — because every gate caller reads
 * `approved === false` as "the user declined" and carries on quietly. A resolved
 * denial would drop the request on the floor after telling nobody; the thrown
 * {@link DeferredApprovalError} is what makes a deferral impossible to swallow
 * (plan Decision 3).
 *
 * If the queue write fails we return null and let the modal happen. Blocking an
 * unattended run is bad; telling the agent something was queued when it was not
 * is worse, because the request would then exist nowhere at all.
 */
/**
 * Queue the request and tell the agent, instead of opening a modal nobody is
 * there to answer.
 *
 * Always throws on the happy path — never resolves — because every gate caller
 * reads `approved === false` as "the user declined" and carries on quietly. A
 * resolved denial would drop the request on the floor after telling nobody; the
 * thrown {@link DeferredApprovalError} is what makes a deferral impossible to
 * swallow by accident (plan Decision 3).
 *
 * If the queue write fails, fall back to prompting. Blocking an unattended run
 * is bad, but telling the agent something was queued when it was not is worse:
 * the request would then exist nowhere at all.
 */
async function deferInsteadOfPrompting(
  req: ApprovalRequest,
  threadId: string,
  prompt: () => Promise<ApprovalResponse>,
): Promise<ApprovalResponse> {
  let entryId: string
  try {
    const entry = await deferApproval({
      threadId,
      kind: req.type,
      title: req.title,
      subject: req.subject ?? req.title,
      ...(req.cause !== undefined ? { cause: req.cause } : {}),
      ...(req.reasons?.length ? { reasons: req.reasons } : {}),
      ...(req.scope !== undefined ? { scope: req.scope } : {}),
    })
    entryId = entry.id
  } catch (error) {
    console.warn('[approval] could not queue a deferral; prompting instead:', error)
    return prompt()
  }
  recordApprovalDecision(req, DENIED, 'deferred')
  throw new DeferredApprovalError(
    entryId,
    deferredApprovalMessage({ title: req.title, reasons: req.reasons }),
  )
}

export function requestApproval(
  req: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  if (signal?.aborted) return Promise.resolve(DENIED)
  // Unattended runs never open a modal (deferred-approvals.md Decision 6). This
  // is the one choke point every gate already funnels through, so intercepting
  // here covers shell, MCP, web, browser, PII, ACP and the rest without any of
  // them growing a second code path — and without a gate being able to forget.
  const deferringThread = getActiveRunThread()
  if (deferringThread !== null && isDeferralModeActive(deferringThread)) {
    return deferInsteadOfPrompting(req, deferringThread, () =>
      requestApprovalInteractive(req, signal),
    )
  }
  return requestApprovalInteractive(req, signal)
}

function requestApprovalInteractive(
  req: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  const scoped = scopedHandler.getStore()
  const activeHandler = scoped?.handler ?? handler
  if (!activeHandler) {
    const unavailable: ApprovalResponse = {
      approved: false,
      remember: false,
      resolution: 'unavailable',
    }
    recordApprovalDecision(req, unavailable)
    return Promise.resolve(unavailable)
  }

  const threadId = getActiveRunThread() ?? undefined
  return withRunDeadlinePaused(threadId, () =>
    requestApprovalUnpaused(
      req,
      activeHandler,
      signal,
      threadId ?? null,
      scoped?.dedupePrefix ?? 'desktop',
    ),
  )
}

function requestApprovalUnpaused(
  req: ApprovalRequest,
  activeHandler: ApprovalHandler,
  signal: AbortSignal | undefined,
  threadId: string | null,
  dedupePrefix: string,
): Promise<ApprovalResponse> {
  if (signal?.aborted) return Promise.resolve(DENIED)

  const key = `${dedupePrefix}:${approvalDedupeKey(req)}`
  // Only a thread-attributed request can be parked and replayed: the ledger is
  // keyed by thread, and a headless/untracked caller has no retry to serve.
  const ledgerKey = threadId === null ? null : abandonedVerdictKey(threadId, key)

  // An identical request whose earlier call was abandoned, answered since: the
  // user already decided this. Checked before joining an open prompt, so a
  // retry that arrives while the prompt is still up simply joins it instead.
  if (ledgerKey !== null) {
    const stored = takeAbandonedVerdict(ledgerKey)
    if (stored) {
      recordReplayedDecision(req, stored)
      return Promise.resolve(stored)
    }
  }

  return new Promise<ApprovalResponse>((resolve, reject) => {
    // Register the waiter before invoking the handler so a synchronous settle
    // (tests, immediate deny) still reaches this caller.
    if (signal?.aborted) {
      resolve(DENIED)
      return
    }

    let entry = inflight.get(key)
    const isLeader = !entry
    if (!entry) {
      entry = { controller: new AbortController(), waiters: new Set() }
      inflight.set(key, entry)
    }
    const active = entry
    // A live retry of an abandoned call takes over as the prompt's consumer:
    // retire the stand-in, or the answer would be both delivered here and
    // stored for a further replay — one answer authorising two runs.
    if (ledgerKey !== null) {
      for (const other of active.waiters) {
        if (other.ledgerKey === ledgerKey) active.waiters.delete(other)
      }
    }

    const teardownIfIdle = (): void => {
      // Only tear down the shared prompt once nobody is left waiting — a
      // sibling tool call may still need the user's answer.
      if (active.waiters.size === 0 && inflight.get(key) === active) {
        inflight.delete(key)
        active.controller.abort()
      }
    }

    const waiter: InflightWaiter = {
      resolve,
      signal,
      threadId,
      onAbort: () => {
        if (!active.waiters.has(waiter)) return
        active.waiters.delete(waiter)
        signal?.removeEventListener('abort', waiter.onAbort)
        if (ledgerKey !== null && isAbandonedCallAbort(signal?.reason)) {
          // The caller is gone but the question stands: keep the prompt open
          // with a stand-in waiter that files the answer for the caller's
          // retry, and tell the caller so — this is not a denial.
          if (![...active.waiters].some((other) => other.ledgerKey === ledgerKey)) {
            active.waiters.add(parkedWaiter(ledgerKey, threadId, active, teardownIfIdle))
          }
          reject(new ApprovalPendingError(req.title))
          return
        }
        // Abort is a transport cancel, not a user denial — record per waiter so
        // coalesced siblings that stay open are not blamed for this leave.
        recordApprovalDecision(req, DENIED, 'aborted')
        resolve(DENIED)
        teardownIfIdle()
      },
    }
    active.waiters.add(waiter)
    signal?.addEventListener('abort', waiter.onAbort, { once: true })

    if (!isLeader) return

    void activeHandler(req, active.controller.signal).then(
      (response) => {
        settleInflight(key, active, response, req)
      },
      () => {
        // Handler rejection must not hang waiters — transport failure, not a
        // user denial (see "Record audit evidence without inventing user denials").
        settleInflight(
          key,
          active,
          { approved: false, remember: false, resolution: 'unavailable' },
          req,
        )
      },
    )
  })
}

/**
 * The waiter that stands in for an abandoned caller. It has no signal of its
 * own: it leaves only when the prompt settles (the answer goes to the ledger)
 * or when the thread's turn ends / the transport is torn down, in which case
 * the answer was never given and nothing is stored.
 */
function parkedWaiter(
  ledgerKey: string,
  threadId: string | null,
  entry: InflightApproval,
  teardownIfIdle: () => void,
): InflightWaiter {
  const waiter: InflightWaiter = {
    threadId,
    signal: undefined,
    ledgerKey,
    resolve: (response) => {
      storeAbandonedVerdict(ledgerKey, response)
    },
    onAbort: () => {
      if (!entry.waiters.has(waiter)) return
      entry.waiters.delete(waiter)
      teardownIfIdle()
    },
  }
  return waiter
}

export function initApproval(
  win: BrowserWindow,
  ipcMain: IpcMain,
  alertUser: UserAlertSender,
): void {
  const pending = new Map<string, (response: ApprovalResponse) => void>()
  const settle = (id: string, response: ApprovalResponse): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(response)
  }

  ipcMain.handle('approval:respond', (event, ...rawArgs) => {
    try {
      // assertMainFrameSender rejects any frame other than the window's main
      // frame, so a compromised/embedded frame can't answer an approval.
      assertMainFrameSender(event, win)
      const [id, approved, remember, comparisonModels, grantScope] = parseIpcArgs(
        approvalRespondSchema,
        rawArgs,
      )
      settle(id, {
        approved,
        remember: remember === true,
        resolution: 'user',
        ...(comparisonModels ? { comparisonModels } : {}),
        ...(grantScope ? { grantScope } : {}),
      })
    } catch (err) {
      if (err instanceof IpcValidationError) return
      throw err
    }
  })

  // If the window goes away, deny everything still pending so callers unblock.
  win.on('closed', () => {
    for (const [id] of pending) {
      settle(id, { approved: false, remember: false, resolution: 'window-closed' })
    }
  })

  setApprovalHandler(
    (req, signal) =>
      new Promise<ApprovalResponse>((resolve) => {
        const id = randomUUID()
        // Attribute the request to the thread whose run triggered it so the
        // renderer can scope the prompt to that thread — a background thread's
        // approval must not pop a modal over whichever project is focused, it
        // shows a sidebar attention indicator instead (issue: cross-project
        // prompt leakage). Null when no run owns it (e.g. headless paths).
        const threadId = getActiveRunThread() ?? undefined
        // Default is the window `initApproval` captured (the main window). A
        // pop-out that triggered this prompt scopes a different target so the
        // dialog appears where the user is looking, not behind it
        // (`renderer-prompt-target.ts`).
        const dest = resolveRendererPromptTarget(win.webContents)
        if (dest.isDestroyed()) {
          resolve(DENIED)
          return
        }
        dest.send('agent:approval-request', { id, threadId, ...req })
        // Deliver the user's configured native alert channels. A repeating
        // Dock/taskbar animation stops on focus and also when this approval
        // settles for any reason.
        const stopAlert = alertUser('interaction', req.title)
        // No wall-clock timeout: the prompt stays until the user answers, the
        // window closes, or the caller's abort signal fires (Stop / cancel).
        // Auto-deny after 5 minutes previously let the agent keep turning under
        // a still-visible dialog (timeout never sent approval_cancelled).
        const onAbort = (): void => {
          if (!pending.has(id)) return
          if (!dest.isDestroyed()) dest.send('agent:approval-cancelled', { id })
          settle(id, { approved: false, remember: false })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, (response) => {
          signal?.removeEventListener('abort', onAbort)
          stopAlert()
          resolve(response)
        })
      }),
  )
}
