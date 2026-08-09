import { errorMessage } from '@shared/errors.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import {
  assertWriteTargetWithinRoot,
  getActiveProjectId,
  resolvePathWithinRoot,
} from './workspace.ts'
import { getActiveWorkspaceFs } from './workspace-fs/get-workspace-fs.ts'
import { buildIndex } from './search/file-index.ts'
import { getGitStatus } from './github/git-service.ts'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from '../ipc/ipc-guards.ts'
import { isAgentRunReadonly } from './agent-run-readonly.ts'
import { ensureSessionBackup, getSessionBackup } from './worktree-backup.ts'
import { READONLY_MODE_BLOCK_MESSAGE } from '@shared/tools/readonly-tools.ts'
import { getSetting } from './storage/settings.ts'
import { isWorkspaceTrusted } from './security/workspace-trust.ts'
import { runAfterFileEditHooks } from './hooks/after-file-edit.ts'
import { runBeforeDiffApplyHooks, runAfterDiffApplyHooks } from './hooks/diff-apply.ts'
import { currentAgentSessionInfo } from './hooks/agent-session.ts'
import { snapshotHookRunContext } from './hook-run-recorder.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  getThreadExecutionContext,
  requireThreadExecutionOwner,
  type ThreadCheckoutMode,
  type ThreadExecutionOwner,
} from './thread-execution-context.ts'
import { getAgentExecutionRoot, getAgentProjectRoot } from './execution-root.ts'

export type DiffOp = 'write' | 'delete' | 'rename' | 'mkdir'

export interface QueueEntry {
  path: string
  before: string
  after: string
  language: string
  /** Defaults to 'write'. */
  op?: DiffOp
  /** Destination path for 'rename'. */
  renameTo?: string
}

export interface DiffDecision {
  path: string
  status: 'applied_directly' | 'approved' | 'rejected' | 'conflict' | 'error'
  at: number
  error?: string
}

/** One row per path; later edits update `after` but keep the original `before` snapshot. */
export function upsertStagedDiffEntry(entries: QueueEntry[], entry: QueueEntry): void {
  const idx = entries.findIndex((e) => e.path === entry.path)
  const existing = idx === -1 ? undefined : entries[idx]
  if (idx === -1 || !existing) {
    entries.push({ ...entry, op: entry.op ?? 'write' })
    return
  }
  entries[idx] = {
    path: entry.path,
    before: existing.before,
    after: entry.after,
    language: entry.language,
    op: entry.op ?? 'write',
    ...(entry.renameTo ? { renameTo: entry.renameTo } : {}),
  }
}

export type ApplyResult =
  | { status: 'written' }
  | { status: 'conflict'; current: string }
  | { status: 'error'; error: string }

type DecisionWaiter = (status: DiffDecision['status']) => void

interface DiffQueueState {
  root: string | null
  projectRoot: string | null
  /**
   * Whether this thread executes in its own linked worktree. Cached alongside
   * `root` because the ACP native-tool bridge binds only the owner (see
   * `runWithThreadExecutionOwner`), so `getThreadExecutionContext()` is null on
   * that async chain and the last resolved mode is the honest answer.
   */
  checkoutMode: ThreadCheckoutMode
  readonly queue: QueueEntry[]
  readonly recentDecisions: DiffDecision[]
  readonly directAppliedSnapshots: Map<string, string>
  readonly decisionWaiters: Map<string, Set<DecisionWaiter>>
}

const statesByProject = new Map<string, Map<string, DiffQueueState>>()

function createDiffQueueState(
  root: string | null,
  projectRoot: string | null,
  checkoutMode: ThreadCheckoutMode,
): DiffQueueState {
  return {
    root,
    projectRoot,
    checkoutMode,
    queue: [],
    recentDecisions: [],
    directAppliedSnapshots: new Map(),
    decisionWaiters: new Map(),
  }
}

function stateFor(owner: ThreadExecutionOwner = requireThreadExecutionOwner()): DiffQueueState {
  const context = getThreadExecutionContext()
  const ownsContext = context?.projectId === owner.projectId && context.threadId === owner.threadId
  const root = ownsContext ? context.root : null
  const projectRoot = ownsContext ? context.projectRoot : null
  const checkoutMode: ThreadCheckoutMode = ownsContext ? context.checkoutMode : 'shared'
  let projectStates = statesByProject.get(owner.projectId)
  if (!projectStates) {
    projectStates = new Map()
    statesByProject.set(owner.projectId, projectStates)
  }
  let state = projectStates.get(owner.threadId)
  if (!state) {
    state = createDiffQueueState(root, projectRoot, checkoutMode)
    projectStates.set(owner.threadId, state)
  } else if (root) {
    state.root = root
    state.projectRoot = projectRoot
    state.checkoutMode = checkoutMode
  }
  return state
}

function executionRootFor(state: DiffQueueState): string | null {
  return state.root ?? getAgentExecutionRoot()
}

function projectRootFor(state: DiffQueueState): string | null {
  return state.projectRoot ?? getAgentProjectRoot()
}

/**
 * Content Copse last wrote directly (bypassing the approval queue) per path.
 * `canApplyDirectly` uses it to tell its own past edits apart from unowned
 * changes in `git status`. The on-disk content check there is the real safety
 * net — a stale or missing snapshot only makes the fast path more conservative
 * (it falls back to staging for approval), never less safe. Bounded by
 * insertion order so a long-running session can't grow it without limit.
 */
const MAX_DIRECT_APPLIED_SNAPSHOTS = 1000
let mainWindow: BrowserWindow | null = null

/**
 * Headless resolver for a staged diff. In the GUI a staged entry waits for the
 * renderer's `diff:approve`/`diff:reject` IPC. With no window (the ACP agent),
 * nothing would ever answer, so a host can register a resolver: it is asked to
 * approve each just-staged entry, and the entry is applied or dropped inline.
 * Returning true applies the change; false rejects it.
 */
export type StagedDiffResolver = (entry: QueueEntry) => Promise<boolean>

let stagedDiffResolver: StagedDiffResolver | null = null
const scopedStagedDiffResolver = new AsyncLocalStorage<StagedDiffResolver>()

export function runWithStagedDiffResolver<T>(resolver: StagedDiffResolver, fn: () => T): T {
  return scopedStagedDiffResolver.run(resolver, fn)
}

export function setStagedDiffResolver(resolver: StagedDiffResolver | null): void {
  stagedDiffResolver = resolver
}

function activeStagedDiffResolver(): StagedDiffResolver | null {
  return scopedStagedDiffResolver.getStore() ?? stagedDiffResolver
}

/**
 * Decide a just-staged entry through {@link stagedDiffResolver} and apply or drop
 * it immediately, returning the message the calling tool should report. Used in
 * headless mode where there is no renderer to approve via IPC.
 */
async function resolveStagedEntry(path: string): Promise<string> {
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  const entry = state.queue.find((e) => e.path === path)
  if (!entry) return `No staged change found for ${path}.`
  const resolver = activeStagedDiffResolver()
  if (!resolver) return `No staged change found for ${path}.`
  let approved: boolean
  try {
    approved = await resolver(cloneEntry(entry))
  } catch {
    approved = false
  }
  if (!approved) {
    recordDecision(state, owner, { path, status: 'rejected' })
    removeEntry(state, owner, path)
    return `Change to ${path} was rejected; nothing was written to disk.`
  }
  const result = await applyDiffEntry(entry, executionRootFor(state), projectRootFor(state))
  if (result.status === 'conflict') {
    restage(owner, entry, result.current)
    recordDecision(state, owner, { path, status: 'conflict' })
    return `Could not write ${path}: it changed on disk since the edit was prepared. Re-read the file and try again.`
  }
  if (result.status === 'error') {
    recordDecision(state, owner, { path, status: 'error', error: result.error })
    removeEntry(state, owner, path)
    return `Failed to write ${path}: ${result.error}`
  }
  recordOwnershipAfterApply(state, entry)
  recordDecision(state, owner, { path, status: 'approved' })
  removeEntry(state, owner, path)
  const root = projectRootFor(state)
  if (root) await buildIndex(root)
  return `Approved and applied change to ${path}.`
}

/**
 * Canonicalize a path to the same shape `getGitStatus` reports (workspace-relative,
 * forward slashes, no leading `./`). The ownership map is keyed this way so a path
 * the model spells as `./src/foo.ts` one turn and `src/foo.ts` the next still
 * resolves to the same snapshot — otherwise the lookup misses and the next turn
 * treats Copse's own edit as an unowned external change.
 */
function ownedKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

function recordDirectAppliedSnapshot(state: DiffQueueState, path: string, content: string): void {
  const key = ownedKey(path)
  // Re-insert so a refreshed path counts as most-recent for eviction.
  state.directAppliedSnapshots.delete(key)
  state.directAppliedSnapshots.set(key, content)
  while (state.directAppliedSnapshots.size > MAX_DIRECT_APPLIED_SNAPSHOTS) {
    const oldest = state.directAppliedSnapshots.keys().next().value
    if (oldest === undefined) break
    state.directAppliedSnapshots.delete(oldest)
  }
}

/**
 * Mark the result of an approved (or directly-applied) op as Copse-owned so the
 * next turn keeps editing it directly instead of re-proposing it. Approvals run
 * through `applyDiffEntry` just like direct applies, but previously never
 * recorded ownership — so any path that went through the approval panel poisoned
 * the fast path for every later turn. Mirrors what each op leaves on disk: a
 * write/rename-destination holds its new content; a deleted file and a renamed
 * source are gone (empty, matching a missing-file read); a mkdir leaves no file
 * that surfaces in `git status`, so there is nothing to own.
 */
function recordOwnershipAfterApply(state: DiffQueueState, entry: QueueEntry): void {
  const op = entry.op ?? 'write'
  if (op === 'write') {
    recordDirectAppliedSnapshot(state, entry.path, entry.after)
  } else if (op === 'delete') {
    recordDirectAppliedSnapshot(state, entry.path, '')
  } else if (op === 'rename' && entry.renameTo) {
    recordDirectAppliedSnapshot(state, entry.path, '')
    recordDirectAppliedSnapshot(state, entry.renameTo, entry.after)
  }
}

function cloneEntry(entry: QueueEntry): QueueEntry {
  return { ...entry }
}

export function listStagedDiffEntries(owner?: ThreadExecutionOwner): QueueEntry[] {
  return stateFor(owner).queue.map(cloneEntry)
}

export function getStagedDiffEntry(path: string, owner?: ThreadExecutionOwner): QueueEntry | null {
  const entry = stateFor(owner).queue.find((e) => e.path === path)
  return entry ? cloneEntry(entry) : null
}

export function getPendingAfterContent(path: string): string | null {
  return stateFor().queue.find((e) => e.path === path)?.after ?? null
}

async function readCurrentContent(
  path: string,
  root: string | null = getAgentExecutionRoot(),
): Promise<string> {
  if (!root) return ''
  try {
    const fs = getActiveWorkspaceFs()
    return await fs.readFile(await resolvePathWithinRoot(path, root), 'utf-8')
  } catch {
    return ''
  }
}

async function canApplyDirectly(
  state: DiffQueueState,
  path: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (state.queue.length > 0) {
    return { ok: false, reason: 'there are pending staged diffs waiting for user approval' }
  }

  const root = executionRootFor(state)
  const status = await getGitStatus(root)
  if (!status) {
    return { ok: false, reason: 'git is unavailable or the workspace is not a git worktree' }
  }

  const changedPaths = [...status.staged, ...status.unstaged].map((change) => change.path)
  const unownedChanges = changedPaths.filter(
    (changedPath) => !state.directAppliedSnapshots.has(ownedKey(changedPath)),
  )
  if (unownedChanges.length > 0) {
    // The user has uncommitted work Copse didn't make this turn. Rather than
    // route every edit through the approval panel to protect it, take one
    // durable backup of the whole worktree and adopt those paths as recoverable.
    // With a restore point in hand, overwriting them is safe, so the edit — and
    // later edits this turn — can apply directly. Only fall back to approval when
    // the backup fails (e.g. git unavailable), leaving no safety net.
    const backup = await ensureSessionBackup(root)
    if (!backup) {
      return {
        ok: false,
        reason: `git has unowned changes that could not be backed up: ${[...new Set(unownedChanges)].join(', ')}`,
      }
    }
    for (const changedPath of new Set(unownedChanges)) {
      recordDirectAppliedSnapshot(state, changedPath, await readCurrentContent(changedPath, root))
    }
  }

  const lastDirectContent = state.directAppliedSnapshots.get(ownedKey(path))
  if (
    lastDirectContent !== undefined &&
    (await readCurrentContent(path, root)) !== lastDirectContent
  ) {
    return {
      ok: false,
      reason: 'the file changed on disk since Copse last applied a direct edit',
    }
  }

  return { ok: true }
}

/**
 * Whether a non-content file op (delete, rename, mkdir) may skip the approval
 * queue. Writes have always had that option — {@link canApplyDirectly} guards
 * them with a worktree backup — but ops staged unconditionally, so a thread
 * running in its own worktree still had to approve every delete and rename it
 * made inside its own checkout. Nothing there is the user's: the worktree is cut
 * from the default branch, lives on its own branch in its own directory, and the
 * user's checkout is untouched either way (worktree invariant 6), so the prompt
 * was asking about files only the agent had ever written.
 *
 * The exemption is deliberately narrow. It applies only in worktree mode, only
 * while `worktreeAutoApproveEdits` is on, and only under the same policy writes
 * already pass: the op still stages when git can't be read, when the worktree
 * holds unowned work that could not be backed up, or when the target changed on
 * disk since Copse last touched it. Those are safety fallbacks, not friction
 * (issue #699), and worktree mode does not buy an op out of them.
 *
 * A `null` reason means the op was never eligible — shared checkout or the
 * setting off — so the caller keeps the plain staging message rather than
 * explaining a fast path this thread never had.
 */
async function canApplyFileOpDirectly(
  state: DiffQueueState,
  path: string,
): Promise<{ ok: true } | { ok: false; reason: string | null }> {
  if (state.checkoutMode !== 'worktree') return { ok: false, reason: null }
  if (!getSetting<boolean>('worktreeAutoApproveEdits', true)) return { ok: false, reason: null }
  return canApplyDirectly(state, path)
}

/**
 * Snapshot the content of every file currently in `git status`, keyed the same
 * way ownership is (git's workspace-relative path). Used to bracket an
 * agent-triggered shell command: the post-command worktree is compared against
 * this baseline by {@link adoptWorktreeChangesSince} so only paths the command
 * actually changed are adopted.
 */
export async function captureWorktreeBaseline(): Promise<Map<string, string>> {
  const state = stateFor()
  const baseline = new Map<string, string>()
  const status = await getGitStatus(executionRootFor(state))
  if (!status) return baseline
  const paths = new Set([...status.staged, ...status.unstaged].map((c) => c.path))
  const root = executionRootFor(state)
  for (const path of paths) baseline.set(ownedKey(path), await readCurrentContent(path, root))
  return baseline
}

/**
 * After an agent-triggered shell command, mark every file the command changed as
 * Copse-owned so the next edit sees a clean worktree and applies directly instead
 * of proposing the command's own effect (e.g. a formatter rewriting a file Copse
 * just edited). Scoped to genuine command effects by diffing against the
 * pre-command baseline: a path is adopted only when it was clean before (absent
 * from the baseline) or its content now differs from the baseline. Pre-existing
 * unowned edits the command did not touch keep their status, so the
 * stale-overwrite guard still protects them. Returns the adopted paths.
 */
export async function adoptWorktreeChangesSince(baseline: Map<string, string>): Promise<string[]> {
  const state = stateFor()
  const changes = await worktreeChangesSince(baseline)
  for (const { path, after } of changes) recordDirectAppliedSnapshot(state, path, after)
  return changes.map((c) => c.path)
}

/** Paths in `git status` whose content now differs from the baseline snapshot. */
async function worktreeChangesSince(
  baseline: Map<string, string>,
): Promise<{ path: string; after: string }[]> {
  const state = stateFor()
  const root = executionRootFor(state)
  const status = await getGitStatus(executionRootFor(state))
  if (!status) return []
  const paths = new Set([...status.staged, ...status.unstaged].map((c) => c.path))
  const changes: { path: string; after: string }[] = []
  for (const path of paths) {
    const after = await readCurrentContent(path, root)
    const before = baseline.get(ownedKey(path))
    if (before === undefined || before !== after) changes.push({ path, after })
  }
  return changes
}

/**
 * Report — without adopting — the paths changed since a
 * {@link captureWorktreeBaseline} snapshot, in the canonical git-status shape
 * (workspace-relative, forward slashes). Used to bracket an ACP turn: writes the
 * external agent routed through `fs/write_text_file` were user-approved, so
 * anything else that changed came from the agent's own tools (e.g. its shell)
 * and bypassed the diff-approval queue (issue #591). Returns `[]` when the
 * workspace is not a git repo — the audit degrades to silence rather than
 * failing the turn.
 */
export async function listWorktreeChangesSince(baseline: Map<string, string>): Promise<string[]> {
  return (await worktreeChangesSince(baseline)).map((c) => c.path)
}

/**
 * Callers waiting on a final approve/reject for a specific path. The ACP client
 * role stages an external agent's `fs/write_text_file` and must block its
 * JSON-RPC response until the user decides in the diff panel — unlike the GUI
 * agent loop, whose tools return the "staged" message immediately. Keyed by path;
 * resolved from {@link recordDecision}, the single choke point every terminal
 * decision flows through.
 */
/**
 * Resolve once a staged diff for `path` reaches a terminal decision
 * (applied/approved/rejected/error). A `conflict` is not terminal — the entry is
 * re-staged for the user to decide again — so it keeps waiting until the next
 * decision settles it.
 */
export function awaitStagedDiffDecision(path: string): Promise<DiffDecision['status']> {
  const state = stateFor()
  return new Promise((resolve) => {
    let waiters = state.decisionWaiters.get(path)
    if (!waiters) {
      waiters = new Set()
      state.decisionWaiters.set(path, waiters)
    }
    waiters.add(resolve)
  })
}

function settleDecisionWaiters(
  state: DiffQueueState,
  path: string,
  status: DiffDecision['status'],
): void {
  const waiters = state.decisionWaiters.get(path)
  if (!waiters) return
  state.decisionWaiters.delete(path)
  for (const resolve of waiters) resolve(status)
}

function recordDecision(
  state: DiffQueueState,
  owner: ThreadExecutionOwner,
  decision: Omit<DiffDecision, 'at'>,
): void {
  state.recentDecisions.unshift({ ...decision, at: Date.now() })
  state.recentDecisions.splice(20)
  // Unblock awaitStagedDiffDecision on terminal outcomes only; a conflict
  // re-stages the entry and the user decides again.
  if (decision.status !== 'conflict') {
    settleDecisionWaiters(state, decision.path, decision.status)
  }
  // F2: `afterDiffApply` fires at this single terminal-decision choke point.
  // A conflict is not terminal (the entry is re-staged), so it never fires; every
  // other status does — `applied` is true only when the diff actually landed.
  if (decision.status !== 'conflict') {
    const applied = decision.status === 'approved' || decision.status === 'applied_directly'
    fireAfterDiffApply(owner, decision.path, applied)
  }
}

export function listRecentStagedDiffDecisions(owner?: ThreadExecutionOwner): DiffDecision[] {
  return stateFor(owner).recentDecisions.map((d) => ({ ...d }))
}

export function getRecentStagedDiffDecision(
  path: string,
  owner?: ThreadExecutionOwner,
): DiffDecision | null {
  const decision = stateFor(owner).recentDecisions.find((d) => d.path === path)
  return decision ? { ...decision } : null
}

/** @internal test helper */
export function clearStagedDiffsForTest(): void {
  statesByProject.clear()
}

/**
 * Apply a staged diff entry to disk, guarding against stale-overwrite TOCTOU.
 *
 * `before` was snapshotted when the diff was staged. If the on-disk content no
 * longer matches that snapshot, something else (a formatter from run_shell,
 * another approval, an external editor) changed the file in between. Writing the
 * agent's whole-file `after` would silently discard that change, so we refuse
 * and report the conflict instead of overwriting (#117).
 *
 * Missing parent directories are created first so brand-new nested paths can be
 * written (#120), and any write failure is captured as an `error` result rather
 * than thrown so batch callers can isolate it from the rest (#118).
 *
 * Non-content operations (delete, rename, mkdir) flow through the same approval
 * model (#122): they are staged as queue entries and applied here so they share
 * the user-approval safety guarantees instead of bypassing them via run_shell.
 */
export async function applyDiffEntry(
  entry: QueueEntry,
  root: string | null = getAgentExecutionRoot(),
  projectRoot: string | null = getAgentProjectRoot(),
): Promise<ApplyResult> {
  if (!root) return { status: 'error', error: 'No workspace open.' }
  const op = entry.op ?? 'write'
  // F2: the canonical `beforeDiffApply` blocking gate fires at this single
  // apply choke point every path funnels through — direct apply, GUI approve /
  // approve-all, and the headless resolver — before any op lands. A hook deny /
  // halt blocks the apply; the diff stays queued for the user to retry.
  const gate = await fireBeforeDiffApply(entry.path, root, projectRoot)
  if (gate.blocked) return { status: 'error', error: gate.reason }
  if (op === 'mkdir') return applyMkdir(entry, root)
  if (op === 'delete') return applyDelete(entry, root)
  if (op === 'rename') return applyRename(entry, root)
  const result = await applyWrite(entry, root)
  // Fire the canonical `afterFileEdit` hook once the content edit has landed on
  // disk (B2). This is the single choke point every write path funnels through
  // — direct apply, GUI approve / approve-all, and the headless resolver — so
  // the event fires exactly once per successful write regardless of mode. Only
  // content writes qualify: delete / rename / mkdir are not file *edits* in
  // Cursor's afterFileEdit sense.
  if (result.status === 'written') await fireAfterFileEdit(entry.path, root, projectRoot)
  return result
}

/**
 * Fire the `afterFileEdit` hooks for a just-written path (B2). Blocking by
 * default — the write path awaits this so a formatter hook finishes before the
 * agent proceeds (decision 2). Gated behind `cursorHooksEnabled` (default off),
 * the same flag the tool-gate path uses, because honouring hooks spawns
 * user/project scripts. A hook failure can never fail the edit that already
 * landed: the runner resolves per-dialect failure semantics internally, and a
 * defensive catch here swallows any unexpected throw.
 */
async function fireAfterFileEdit(
  path: string,
  root: string,
  projectRoot: string | null,
): Promise<void> {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  try {
    await runAfterFileEditHooks(await resolvePathWithinRoot(path, root), {
      workspaceRoot: projectRoot,
      executionRoot: root,
      projectTrusted: isWorkspaceTrusted(projectRoot),
      // Real conversation/generation ids + running model on the wire payload (B4).
      agentSession: currentAgentSessionInfo(),
    })
  } catch (err) {
    console.warn(`[hooks] afterFileEdit hook error for ${path}:`, errorMessage(err))
  }
}

/**
 * Fire the `beforeDiffApply` hooks for a diff about to land (F2, Copse-native).
 * Blocking — the apply path awaits this so a hook can deny/halt before the edit
 * lands. Gated behind `cursorHooksEnabled` (default off), the same flag every
 * other fire site uses, so disabled behavior is byte-identical. Any unexpected
 * orchestration error fails **open** (the apply proceeds): a broken hook must
 * never wedge the diff queue, and the per-dialect `onFailure` (decision 9) is the
 * knob a security-conscious hook uses to fail closed instead.
 */
async function fireBeforeDiffApply(
  path: string,
  root: string,
  projectRoot: string | null,
): Promise<{ blocked: boolean; reason: string }> {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return { blocked: false, reason: '' }
  try {
    const decision = await runBeforeDiffApplyHooks(await resolvePathWithinRoot(path, root), {
      workspaceRoot: projectRoot,
      executionRoot: root,
      projectTrusted: isWorkspaceTrusted(projectRoot),
      agentSession: currentAgentSessionInfo(),
    })
    if (!decision.blocked) return { blocked: false, reason: '' }
    const detail =
      decision.agentMessage ?? decision.userMessage ?? 'blocked by a beforeDiffApply hook'
    return { blocked: true, reason: `Blocked by a beforeDiffApply hook: ${detail}` }
  } catch (err) {
    console.warn(`[hooks] beforeDiffApply hook error for ${path}:`, errorMessage(err))
    return { blocked: false, reason: '' }
  }
}

/**
 * Fire the `afterDiffApply` hooks for a diff that reached a terminal decision
 * (F2, Copse-native). Detached (decision 3): dispatched and never awaited, so a
 * slow observer never delays the diff-queue UI. Gated behind `cursorHooksEnabled`
 * (default off). `applied` is true for approve / direct-apply, false for a
 * reject or write error.
 */
function fireAfterDiffApply(owner: ThreadExecutionOwner, path: string, applied: boolean): void {
  if (!getSetting<boolean>('cursorHooksEnabled', false)) return
  const state = stateFor(owner)
  const root = executionRootFor(state)
  const projectRoot = projectRootFor(state)
  if (!root) return
  const agentSession = currentAgentSessionInfo()
  const threadId = agentSession.conversationId || owner.threadId
  const turnTreeId = asTurnTreeId(agentSession.generationId || threadId)
  // Snapshot the recording context now, synchronously, like `fireStopHook`: the
  // dispatch below is detached and the path resolution is async, so the live
  // context may be gone by the time the hook's `hook_run` line records
  // (decision 3/6).
  const recordingSnapshot = snapshotHookRunContext()
  void (async (): Promise<unknown> =>
    runAfterDiffApplyHooks(
      { filePath: await resolvePathWithinRoot(path, root), applied },
      {
        threadId,
        turnTreeId,
        workspaceRoot: projectRoot,
        executionRoot: root,
        projectTrusted: isWorkspaceTrusted(projectRoot),
        agentSession,
        recordingSnapshot,
      },
    ))().catch((err: unknown) => {
    console.warn(`[hooks] afterDiffApply dispatch error for ${path}:`, errorMessage(err))
  })
}

async function applyWrite(entry: QueueEntry, root: string): Promise<ApplyResult> {
  const absPath = await resolvePathWithinRoot(entry.path, root)
  const fs = getActiveWorkspaceFs()
  let current = ''
  try {
    current = await fs.readFile(absPath, 'utf-8')
  } catch {
    /* file absent on disk — treated as empty, matching staging snapshot for new files */
  }
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  try {
    await assertWriteTargetWithinRoot(absPath, root)
    await fs.mkdir(dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, entry.after, 'utf-8')
  } catch (err) {
    return { status: 'error', error: errorMessage(err) }
  }
  return { status: 'written' }
}

async function applyDelete(entry: QueueEntry, root: string): Promise<ApplyResult> {
  const absPath = await resolvePathWithinRoot(entry.path, root)
  const fs = getActiveWorkspaceFs()
  let current: string
  try {
    current = await fs.readFile(absPath, 'utf-8')
  } catch {
    // Deletion is idempotent: if the file is already gone the desired end state
    // is met, so report success instead of failing the (whole) approval. This is
    // common when a deletion is staged from `git status` for a file that no
    // longer exists on disk, or when the same path was already removed (#504).
    return { status: 'written' }
  }
  // Same stale-overwrite guard as writes: refuse if the file changed since staging.
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  try {
    await fs.rm(absPath)
  } catch (err) {
    return { status: 'error', error: errorMessage(err) }
  }
  return { status: 'written' }
}

async function applyRename(entry: QueueEntry, root: string): Promise<ApplyResult> {
  if (!entry.renameTo) return { status: 'error', error: 'rename target missing' }
  const fromAbs = await resolvePathWithinRoot(entry.path, root)
  const toAbs = await resolvePathWithinRoot(entry.renameTo, root)
  const fs = getActiveWorkspaceFs()
  let current: string
  try {
    current = await fs.readFile(fromAbs, 'utf-8')
  } catch {
    return { status: 'error', error: `File not found: ${entry.path}` }
  }
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  // Don't clobber an existing destination.
  try {
    await fs.access(toAbs)
    return { status: 'error', error: `Destination already exists: ${entry.renameTo}` }
  } catch {
    /* destination is free */
  }
  try {
    await assertWriteTargetWithinRoot(toAbs, root)
    await fs.mkdir(dirname(toAbs), { recursive: true })
    await fs.rename(fromAbs, toAbs)
  } catch (err) {
    return { status: 'error', error: errorMessage(err) }
  }
  return { status: 'written' }
}

async function applyMkdir(entry: QueueEntry, root: string): Promise<ApplyResult> {
  const absPath = await resolvePathWithinRoot(entry.path, root)
  try {
    await assertWriteTargetWithinRoot(absPath, root)
    await getActiveWorkspaceFs().mkdir(absPath, { recursive: true })
  } catch (err) {
    return { status: 'error', error: errorMessage(err) }
  }
  return { status: 'written' }
}

export function initDiffQueue(win: BrowserWindow, ipcMain: IpcMain): void {
  mainWindow = win

  function parseOwner(projectIdArg: unknown, threadIdArg: unknown): ThreadExecutionOwner {
    const projectId = parseIpcArgs(zProjectId, [projectIdArg])
    const threadId = parseIpcArgs(zThreadId, [threadIdArg])
    if (getActiveProjectId() !== projectId) {
      throw new Error(`Cannot manage diffs for inactive project "${projectId}"`)
    }
    return { projectId, threadId }
  }

  ipcMain.handle(
    'diff:approve',
    async (event, projectIdArg: unknown, threadIdArg: unknown, path: string) => {
      assertMainFrameSender(event, win)
      const owner = parseOwner(projectIdArg, threadIdArg)
      const state = stateFor(owner)
      const entry = state.queue.find((e) => e.path === path)
      if (!entry) return
      const result = await applyDiffEntry(entry, executionRootFor(state), projectRootFor(state))
      if (result.status === 'conflict') {
        restage(owner, entry, result.current)
        recordDecision(state, owner, { path: entry.path, status: 'conflict' })
        mainWindow?.webContents.send('diff:conflict', owner.projectId, owner.threadId, [entry.path])
        return
      }
      if (result.status === 'error') {
        // Leave the entry queued so the user can retry; surface the failure.
        recordDecision(state, owner, { path: entry.path, status: 'error', error: result.error })
        throw new Error(`Failed to write ${entry.path}: ${result.error}`)
      }
      const root = projectRootFor(state)
      if (root) await buildIndex(root)
      recordOwnershipAfterApply(state, entry)
      recordDecision(state, owner, { path: entry.path, status: 'approved' })
      removeEntry(state, owner, path)
    },
  )

  ipcMain.handle(
    'diff:reject',
    (event, projectIdArg: unknown, threadIdArg: unknown, path: string) => {
      assertMainFrameSender(event, win)
      const owner = parseOwner(projectIdArg, threadIdArg)
      const state = stateFor(owner)
      if (state.queue.some((e) => e.path === path)) {
        recordDecision(state, owner, { path, status: 'rejected' })
      }
      removeEntry(state, owner, path)
    },
  )

  // On-demand fetch of a queued diff's full content. `agent:show_diff` pushes the
  // before/after payload once when a diff is staged, but the renderer's Changes
  // pane can miss that event — it mounts a turn after the agent proposes (Monaco
  // loads async, #459) or is remounted on popout/workspace switch, and nothing
  // replays the push. Selecting such a proposed file would otherwise clear the
  // viewer; this lets the pane pull the content the queue still holds.
  ipcMain.handle(
    'diff:content',
    (event, projectIdArg: unknown, threadIdArg: unknown, path: string) => {
      assertMainFrameSender(event, win)
      const owner = parseOwner(projectIdArg, threadIdArg)
      const entry = typeof path === 'string' ? getStagedDiffEntry(path, owner) : null
      if (!entry) return null
      return {
        path: entry.path,
        before: entry.before,
        after: entry.after,
        language: entry.language,
      }
    },
  )

  ipcMain.handle('diff:approveAll', (event, projectIdArg: unknown, threadIdArg: unknown) => {
    assertMainFrameSender(event, win)
    return approveAllStagedDiffs(parseOwner(projectIdArg, threadIdArg))
  })

  ipcMain.handle('diff:rejectAll', (event, projectIdArg: unknown, threadIdArg: unknown) => {
    assertMainFrameSender(event, win)
    const owner = parseOwner(projectIdArg, threadIdArg)
    const state = stateFor(owner)
    for (const entry of state.queue) {
      recordDecision(state, owner, { path: entry.path, status: 'rejected' })
    }
    state.queue.length = 0
    broadcastQueue(state, owner)
  })
}

/**
 * Apply every queued diff, then remove only the entries that were successfully
 * applied. Applying is async, and the agent can stage new diffs into `queue`
 * while we await; rebuilding the queue from scratch afterward would drop those.
 * Instead we track the specific entry objects we applied and remove them by
 * identity, so conflicts and failures stay queued for retry and anything staged
 * concurrently — even a re-stage of an already-applied path, which upsert
 * replaces with a fresh object — survives. Throws if any write failed (#118).
 */
export async function approveAllStagedDiffs(owner?: ThreadExecutionOwner): Promise<void> {
  const resolvedOwner = owner ?? requireThreadExecutionOwner()
  const state = stateFor(resolvedOwner)
  const conflicts: string[] = []
  const failures: { path: string; error: string }[] = []
  const toApply = [...state.queue]
  const appliedEntries = new Set<QueueEntry>()
  for (const entry of toApply) {
    const result = await applyDiffEntry(entry, executionRootFor(state), projectRootFor(state))
    if (result.status === 'conflict') {
      restage(resolvedOwner, entry, result.current)
      recordDecision(state, resolvedOwner, { path: entry.path, status: 'conflict' })
      conflicts.push(entry.path)
    } else if (result.status === 'error') {
      recordDecision(state, resolvedOwner, {
        path: entry.path,
        status: 'error',
        error: result.error,
      })
      failures.push({ path: entry.path, error: result.error })
    } else {
      recordOwnershipAfterApply(state, entry)
      recordDecision(state, resolvedOwner, { path: entry.path, status: 'approved' })
      appliedEntries.add(entry)
    }
  }
  if (appliedEntries.size > 0) {
    const root = projectRootFor(state)
    if (root) await buildIndex(root)
    for (let i = state.queue.length - 1; i >= 0; i--) {
      const queued = state.queue[i]
      if (queued && appliedEntries.has(queued)) state.queue.splice(i, 1)
    }
  }
  if (conflicts.length) {
    mainWindow?.webContents.send(
      'diff:conflict',
      resolvedOwner.projectId,
      resolvedOwner.threadId,
      conflicts,
    )
  }
  broadcastQueue(state, resolvedOwner)
  if (failures.length > 0) {
    throw new Error(
      `Failed to write ${String(failures.length)} file(s):\n${failures
        .map((f) => `  ${f.path}: ${f.error}`)
        .join('\n')}`,
    )
  }
}

/**
 * Re-stage an entry after a conflict: refresh its `before` snapshot to the
 * current on-disk content and re-emit the diff so the user reviews their change
 * against the file's real state before re-approving.
 */
function restage(owner: ThreadExecutionOwner, entry: QueueEntry, current: string): void {
  entry.before = current
  mainWindow?.webContents.send(
    'agent:show_diff',
    owner.projectId,
    owner.threadId,
    entry.path,
    entry.before,
    entry.after,
    entry.language,
  )
}

export function stageDiff(
  path: string,
  before: string,
  after: string,
  language: string,
): Promise<string> {
  if (isAgentRunReadonly()) return Promise.resolve(READONLY_MODE_BLOCK_MESSAGE)
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  const hadPending = state.queue.some((e) => e.path === path)
  upsertStagedDiffEntry(state.queue, { path, before, after, language, op: 'write' })
  const entry = state.queue.find((e) => e.path === path)
  if (!entry) throw new Error(`Staged diff entry for ${path} missing immediately after upsert`)
  // Payload before queue broadcast so the renderer can populate activeDiff first.
  mainWindow?.webContents.send(
    'agent:show_diff',
    owner.projectId,
    owner.threadId,
    path,
    entry.before,
    entry.after,
    entry.language,
  )
  broadcastQueue(state, owner)
  // Headless host (e.g. ACP): resolve the staged entry inline instead of waiting
  // for a renderer that will never answer.
  if (activeStagedDiffResolver()) return resolveStagedEntry(path)
  return Promise.resolve(
    `${hadPending ? 'Updated pending staged diff' : 'Diff staged'} for ${path}. The file on disk is NOT changed until the user approves it in the diff panel. Shell commands, git, and read_file still see the old on-disk content. Use staged_diffs/read_staged_diff to inspect pending proposed changes, or ask the user to approve before validating.`,
  )
}

export async function applyOrStageDiff(
  path: string,
  before: string,
  after: string,
  language: string,
): Promise<string> {
  if (isAgentRunReadonly()) return READONLY_MODE_BLOCK_MESSAGE
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  const direct = await canApplyDirectly(state, path)
  if (!direct.ok) {
    const staged = await stageDiff(path, before, after, language)
    return `${staged}\nReason approval is required: ${direct.reason}.`
  }

  const result = await applyDiffEntry(
    { path, before, after, language },
    executionRootFor(state),
    projectRootFor(state),
  )
  if (result.status === 'written') {
    recordDirectAppliedSnapshot(state, path, after)
    recordDecision(state, owner, { path, status: 'applied_directly' })
    const root = projectRootFor(state)
    if (root) await buildIndex(root)
    const backup = getSessionBackup()
    const safetyNote = backup
      ? `The worktree had uncommitted changes, so those were backed up to ${backup.ref} first; no approval was required.`
      : `Git was clean except for Copse-applied edits in this session, so no approval was required.`
    return `Applied edit directly to ${path}. ${safetyNote} You can validate with run_shell/read_file/git now.`
  }
  if (result.status === 'conflict') {
    const staged = await stageDiff(path, result.current, after, language)
    recordDecision(state, owner, { path, status: 'conflict' })
    return `${staged}\nDirect apply was skipped because the file changed after it was read; review the staged diff before approval.`
  }
  recordDecision(state, owner, { path, status: 'error', error: result.error })
  return `Failed to write ${path}: ${result.error}`
}

interface FileOpRequest {
  op: DiffOp
  path: string
  before: string
  after: string
  language: string
  renameTo?: string
}

/** Noun-phrase description of a pending op, for the staging message. */
function stagedFileOpVerb(entry: FileOpRequest): string {
  if (entry.op === 'delete') return `Deletion of ${entry.path}`
  if (entry.op === 'rename') {
    return `Rename of ${entry.path} → ${entry.renameTo ?? '(unknown target)'}`
  }
  return `Creation of directory ${entry.path}`
}

/** Past-tense description of a landed op, mirroring {@link stagedFileOpVerb}. */
function appliedFileOpVerb(entry: FileOpRequest): string {
  if (entry.op === 'delete') return `Deleted ${entry.path}`
  if (entry.op === 'rename') {
    return `Renamed ${entry.path} → ${entry.renameTo ?? '(unknown target)'}`
  }
  return `Created directory ${entry.path}`
}

/**
 * Apply a non-content file operation (delete, rename, mkdir) directly when this
 * thread's worktree makes approval meaningless, otherwise stage it for the user.
 * The write-side twin is {@link applyOrStageDiff}; both funnel through
 * {@link applyDiffEntry}, so hooks, the stale-content guard, and ownership
 * bookkeeping behave the same however the op got there.
 */
export async function applyOrStageFileOp(entry: FileOpRequest): Promise<string> {
  if (isAgentRunReadonly()) return READONLY_MODE_BLOCK_MESSAGE
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  const direct = await canApplyFileOpDirectly(state, entry.path)
  if (!direct.ok) {
    const staged = await stageFileOp(entry)
    return direct.reason ? `${staged}\nReason approval is required: ${direct.reason}.` : staged
  }

  const queued: QueueEntry = {
    path: entry.path,
    before: entry.before,
    after: entry.after,
    language: entry.language,
    op: entry.op,
    ...(entry.renameTo ? { renameTo: entry.renameTo } : {}),
  }
  const result = await applyDiffEntry(queued, executionRootFor(state), projectRootFor(state))
  if (result.status === 'written') {
    recordOwnershipAfterApply(state, queued)
    recordDecision(state, owner, { path: entry.path, status: 'applied_directly' })
    const root = projectRootFor(state)
    if (root) await buildIndex(root)
    const backup = getSessionBackup()
    const backupNote = backup
      ? ` The worktree had uncommitted changes, so those were backed up to ${backup.ref} first.`
      : ''
    return `${appliedFileOpVerb(entry)} directly. This thread runs in its own isolated worktree, so no approval was required.${backupNote} You can validate with run_shell/read_file/git now.`
  }
  if (result.status === 'conflict') {
    // A move carries whatever is on disk now, so a restaged rename follows the
    // current content on both sides rather than re-proposing the stale copy the
    // agent read. A delete's `after` is already empty, and mkdir never conflicts.
    const staged = await stageFileOp({
      ...entry,
      before: result.current,
      ...(entry.op === 'rename' ? { after: result.current } : {}),
    })
    recordDecision(state, owner, { path: entry.path, status: 'conflict' })
    return `${staged}\nDirect apply was skipped because ${entry.path} changed after it was read; review the staged change before approval.`
  }
  recordDecision(state, owner, { path: entry.path, status: 'error', error: result.error })
  return `Failed to apply ${entry.op} for ${entry.path}: ${result.error}`
}

/**
 * Stage a non-content file operation (delete, rename, mkdir) through the diff
 * approval queue (#122) so it inherits the same user-approval safety model as
 * writes. Coalesces by path like {@link stageDiff}. The operation is shown to
 * the user as a before/after diff (delete: full removal; rename: content moved;
 * mkdir: directory marker) and is not applied until approved.
 */
function stageFileOp(entry: FileOpRequest): Promise<string> {
  if (isAgentRunReadonly()) return Promise.resolve(READONLY_MODE_BLOCK_MESSAGE)
  const owner = requireThreadExecutionOwner()
  const state = stateFor(owner)
  const existingIdx = state.queue.findIndex((e) => e.path === entry.path)
  const queued: QueueEntry = {
    path: entry.path,
    before: entry.before,
    after: entry.after,
    language: entry.language,
    op: entry.op,
    ...(entry.renameTo ? { renameTo: entry.renameTo } : {}),
  }
  if (existingIdx !== -1) {
    state.queue[existingIdx] = queued
  } else {
    state.queue.push(queued)
  }
  mainWindow?.webContents.send(
    'agent:show_diff',
    owner.projectId,
    owner.threadId,
    entry.path,
    entry.before,
    entry.after,
    entry.language,
  )
  broadcastQueue(state, owner)
  if (activeStagedDiffResolver()) return resolveStagedEntry(entry.path)
  return Promise.resolve(
    `${stagedFileOpVerb(entry)} staged. Approve or reject in the diff panel — nothing changes on disk until accepted.`,
  )
}

/** @internal test helper — snapshot the current queue. */
export function getDiffQueueForTest(
  owner?: ThreadExecutionOwner,
): ReadonlyArray<Readonly<QueueEntry>> {
  return stateFor(owner).queue.map((e) => ({ ...e }))
}

/** @internal test helper — reset queue state between tests. */
export function clearDiffQueueForTest(): void {
  clearStagedDiffsForTest()
}

function removeEntry(state: DiffQueueState, owner: ThreadExecutionOwner, path: string): void {
  for (let i = state.queue.length - 1; i >= 0; i--) {
    if (state.queue[i]?.path === path) state.queue.splice(i, 1)
  }
  broadcastQueue(state, owner)
}

function broadcastQueue(state: DiffQueueState, owner: ThreadExecutionOwner): void {
  mainWindow?.webContents.send(
    'diff:queued',
    owner.projectId,
    owner.threadId,
    state.queue.map((e) => ({ path: e.path, language: e.language })),
  )
}
