import type { BrowserWindow, IpcMain } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
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

/** Model ids for a two-reviewer + judge comparison run. */
export interface ComparisonModelSelection {
  a: string
  b: string
  judge: string
}

export interface ApprovalRequest {
  title: string
  body: string
  type: 'shell' | 'mcp' | 'web' | 'pii' | 'model-compare' | 'review-spend'
  allowRemember?: boolean
  rememberLabel?: string
  /** Intentional Settings-owned flow that must prompt above the open Settings dialog. */
  showWhileSettingsOpen?: boolean
  /** Initial reviewer/judge ids when `type === 'model-compare'` (renderer shows pickers). */
  comparisonModels?: ComparisonModelSelection
  /** Secret-free operation or tool name stored in the durable decision log. */
  subject?: string
  /** Scope the decision applies at, such as `sandbox` or `external`. */
  scope?: string
}

export interface ApprovalResponse {
  approved: boolean
  remember: boolean
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
    type: req.type,
    allowRemember: req.allowRemember ?? false,
    rememberLabel: req.rememberLabel ?? '',
    showWhileSettingsOpen: req.showWhileSettingsOpen ?? false,
    comparisonModels: req.comparisonModels ?? null,
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
}

const inflight = new Map<string, InflightApproval>()

/**
 * ACP `session/request_permission` toolCallIds currently blocked in the approval
 * dialog. When the agent later marks that tool call completed/failed/cancelled
 * without waiting for our answer, we abort the matching waiter so the modal
 * dismisses at the tool boundary — not only at turn end.
 */
const acpPermissionByToolCallId = new Map<string, AbortController>()

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
          : 'cancelled',
    subject: req.subject ?? req.title,
    ...(req.scope ? { scope: req.scope } : {}),
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
        waiter.resolve(DENIED)
      }
    }
    inflight.clear()
    for (const controller of acpPermissionByToolCallId.values()) controller.abort()
    acpPermissionByToolCallId.clear()
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
 * Register that an ACP permission prompt is open for `toolCallId`. Returns a
 * signal aborted when {@link cancelApprovalsForAcpToolCall} runs, and an
 * unregister function for the normal settle path.
 */
export function trackAcpPermissionToolCall(toolCallId: string): {
  signal: AbortSignal
  unregister: () => void
} {
  // Replace any stale registration for the same id (agent retried the call).
  acpPermissionByToolCallId.get(toolCallId)?.abort()
  const controller = new AbortController()
  acpPermissionByToolCallId.set(toolCallId, controller)
  return {
    signal: controller.signal,
    unregister: (): void => {
      if (acpPermissionByToolCallId.get(toolCallId) === controller) {
        acpPermissionByToolCallId.delete(toolCallId)
      }
    },
  }
}

/**
 * Dismiss the approval tied to an ACP tool call that reached a terminal status
 * (or was abandoned) before the user answered.
 */
export function cancelApprovalsForAcpToolCall(toolCallId: string): boolean {
  const controller = acpPermissionByToolCallId.get(toolCallId)
  if (!controller) return false
  acpPermissionByToolCallId.delete(toolCallId)
  controller.abort()
  return true
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
export function requestApproval(
  req: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalResponse> {
  if (signal?.aborted) return Promise.resolve(DENIED)
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

  return new Promise<ApprovalResponse>((resolve) => {
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

    const waiter: InflightWaiter = {
      resolve,
      signal,
      threadId,
      onAbort: () => {
        if (!active.waiters.has(waiter)) return
        active.waiters.delete(waiter)
        signal?.removeEventListener('abort', waiter.onAbort)
        // Abort is a transport cancel, not a user denial — record per waiter so
        // coalesced siblings that stay open are not blamed for this leave.
        recordApprovalDecision(req, DENIED, 'aborted')
        resolve(DENIED)
        // Only tear down the shared prompt once nobody is left waiting — a
        // sibling tool call may still need the user's answer.
        if (active.waiters.size === 0 && inflight.get(key) === active) {
          inflight.delete(key)
          active.controller.abort()
        }
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
 * The slice of Electron's macOS `app.dock` we use to draw attention while an
 * approval is pending. Structural so the real `Dock` satisfies it and tests can
 * pass a fake without pulling in Electron.
 */
export interface DockAttention {
  bounce(type?: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

/**
 * Bounce the dock icon ('critical' keeps bouncing until the app is focused) to
 * signal a pending approval, returning a stop function to call once it settles.
 * No-op when there's no dock (non-macOS / headless), so callers need no guards.
 */
export function startDockAttention(dock: DockAttention | undefined): () => void {
  if (!dock) return () => {}
  const id = dock.bounce('critical')
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    dock.cancelBounce(id)
  }
}

export function initApproval(win: BrowserWindow, ipcMain: IpcMain, dock?: DockAttention): void {
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
      const [id, approved, remember, comparisonModels] = parseIpcArgs(
        approvalRespondSchema,
        rawArgs,
      )
      settle(id, {
        approved,
        remember: remember === true,
        resolution: 'user',
        ...(comparisonModels ? { comparisonModels } : {}),
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
        win.webContents.send('agent:approval_request', { id, threadId, ...req })
        // Bounce the dock until the user returns to answer (macOS only; app.dock
        // is undefined elsewhere). macOS auto-stops the bounce on focus, and we
        // also stop it when the approval settles for any reason.
        const stopDockAttention = startDockAttention(dock)
        // No wall-clock timeout: the prompt stays until the user answers, the
        // window closes, or the caller's abort signal fires (Stop / cancel).
        // Auto-deny after 5 minutes previously let the agent keep turning under
        // a still-visible dialog (timeout never sent approval_cancelled).
        const onAbort = (): void => {
          if (!pending.has(id)) return
          win.webContents.send('agent:approval_cancelled', { id })
          settle(id, { approved: false, remember: false })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, (response) => {
          signal?.removeEventListener('abort', onAbort)
          stopDockAttention()
          resolve(response)
        })
      }),
  )
}
