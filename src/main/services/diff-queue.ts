import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { assertWorkspaceWriteTarget, resolveWorkspacePath } from './workspace.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { buildIndex } from './file-index.ts'
import { getGitStatus } from './git-service.ts'
import { assertMainFrameSender } from '../ipc/ipc-guards.ts'
import { isAgentRunReadonly } from './agent-run-readonly.ts'
import { READONLY_MODE_BLOCK_MESSAGE } from '@shared/tools/readonly-tools.ts'

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
  if (idx === -1) {
    entries.push({ ...entry, op: entry.op ?? 'write' })
    return
  }
  entries[idx] = {
    path: entry.path,
    before: entries[idx]!.before,
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

const queue: QueueEntry[] = []
const recentDecisions: DiffDecision[] = []
/**
 * Content Copse last wrote directly (bypassing the approval queue) per path.
 * `canApplyDirectly` uses it to tell its own past edits apart from unowned
 * changes in `git status`. The on-disk content check there is the real safety
 * net — a stale or missing snapshot only makes the fast path more conservative
 * (it falls back to staging for approval), never less safe. Bounded by
 * insertion order so a long-running session can't grow it without limit.
 */
const directAppliedSnapshots = new Map<string, string>()
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

export function setStagedDiffResolver(resolver: StagedDiffResolver | null): void {
  stagedDiffResolver = resolver
}

/**
 * Decide a just-staged entry through {@link stagedDiffResolver} and apply or drop
 * it immediately, returning the message the calling tool should report. Used in
 * headless mode where there is no renderer to approve via IPC.
 */
async function resolveStagedEntry(path: string): Promise<string> {
  const entry = queue.find((e) => e.path === path)
  if (!entry) return `No staged change found for ${path}.`
  let approved: boolean
  try {
    approved = await stagedDiffResolver!(cloneEntry(entry))
  } catch {
    approved = false
  }
  if (!approved) {
    recordDecision({ path, status: 'rejected' })
    removeEntry(path)
    return `Change to ${path} was rejected; nothing was written to disk.`
  }
  const result = await applyDiffEntry(entry)
  if (result.status === 'conflict') {
    restage(entry, result.current)
    recordDecision({ path, status: 'conflict' })
    return `Could not write ${path}: it changed on disk since the edit was prepared. Re-read the file and try again.`
  }
  if (result.status === 'error') {
    recordDecision({ path, status: 'error', error: result.error })
    removeEntry(path)
    return `Failed to write ${path}: ${result.error}`
  }
  recordOwnershipAfterApply(entry)
  recordDecision({ path, status: 'approved' })
  removeEntry(path)
  const root = getWorkspaceRoot()
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

function recordDirectAppliedSnapshot(path: string, content: string): void {
  const key = ownedKey(path)
  // Re-insert so a refreshed path counts as most-recent for eviction.
  directAppliedSnapshots.delete(key)
  directAppliedSnapshots.set(key, content)
  while (directAppliedSnapshots.size > MAX_DIRECT_APPLIED_SNAPSHOTS) {
    const oldest = directAppliedSnapshots.keys().next().value
    if (oldest === undefined) break
    directAppliedSnapshots.delete(oldest)
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
function recordOwnershipAfterApply(entry: QueueEntry): void {
  const op = entry.op ?? 'write'
  if (op === 'write') {
    recordDirectAppliedSnapshot(entry.path, entry.after)
  } else if (op === 'delete') {
    recordDirectAppliedSnapshot(entry.path, '')
  } else if (op === 'rename' && entry.renameTo) {
    recordDirectAppliedSnapshot(entry.path, '')
    recordDirectAppliedSnapshot(entry.renameTo, entry.after)
  }
}

function cloneEntry(entry: QueueEntry): QueueEntry {
  return { ...entry }
}

export function listStagedDiffEntries(): QueueEntry[] {
  return queue.map(cloneEntry)
}

export function getStagedDiffEntry(path: string): QueueEntry | null {
  const entry = queue.find((e) => e.path === path)
  return entry ? cloneEntry(entry) : null
}

export function getPendingAfterContent(path: string): string | null {
  return queue.find((e) => e.path === path)?.after ?? null
}

async function readCurrentContent(path: string): Promise<string> {
  try {
    return await fsp.readFile(resolveWorkspacePath(path), 'utf-8')
  } catch {
    return ''
  }
}

async function canApplyDirectly(
  path: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (queue.length > 0) {
    return { ok: false, reason: 'there are pending staged diffs waiting for user approval' }
  }

  const status = await getGitStatus()
  if (!status) {
    return { ok: false, reason: 'git is unavailable or the workspace is not a git worktree' }
  }

  const changedPaths = [...status.staged, ...status.unstaged].map((change) => change.path)
  const unownedChanges = changedPaths.filter(
    (changedPath) => !directAppliedSnapshots.has(ownedKey(changedPath)),
  )
  if (unownedChanges.length > 0) {
    return {
      ok: false,
      reason: `git already has unowned changes: ${[...new Set(unownedChanges)].join(', ')}`,
    }
  }

  const lastDirectContent = directAppliedSnapshots.get(ownedKey(path))
  if (lastDirectContent !== undefined && (await readCurrentContent(path)) !== lastDirectContent) {
    return {
      ok: false,
      reason: 'the file changed on disk since Copse last applied a direct edit',
    }
  }

  return { ok: true }
}

/**
 * Snapshot the content of every file currently in `git status`, keyed the same
 * way ownership is (git's workspace-relative path). Used to bracket an
 * agent-triggered shell command: the post-command worktree is compared against
 * this baseline by {@link adoptWorktreeChangesSince} so only paths the command
 * actually changed are adopted.
 */
export async function captureWorktreeBaseline(): Promise<Map<string, string>> {
  const baseline = new Map<string, string>()
  const status = await getGitStatus()
  if (!status) return baseline
  const paths = new Set([...status.staged, ...status.unstaged].map((c) => c.path))
  for (const path of paths) baseline.set(ownedKey(path), await readCurrentContent(path))
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
  const status = await getGitStatus()
  if (!status) return []
  const paths = new Set([...status.staged, ...status.unstaged].map((c) => c.path))
  const adopted: string[] = []
  for (const path of paths) {
    const after = await readCurrentContent(path)
    const before = baseline.get(ownedKey(path))
    if (before === undefined || before !== after) {
      recordDirectAppliedSnapshot(path, after)
      adopted.push(path)
    }
  }
  return adopted
}

function recordDecision(decision: Omit<DiffDecision, 'at'>): void {
  recentDecisions.unshift({ ...decision, at: Date.now() })
  recentDecisions.splice(20)
}

export function listRecentStagedDiffDecisions(): DiffDecision[] {
  return recentDecisions.map((d) => ({ ...d }))
}

export function getRecentStagedDiffDecision(path: string): DiffDecision | null {
  const decision = recentDecisions.find((d) => d.path === path)
  return decision ? { ...decision } : null
}

/** @internal test helper */
export function clearStagedDiffsForTest(): void {
  queue.length = 0
  recentDecisions.length = 0
  directAppliedSnapshots.clear()
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
export async function applyDiffEntry(entry: QueueEntry): Promise<ApplyResult> {
  const op = entry.op ?? 'write'
  if (op === 'mkdir') return applyMkdir(entry)
  if (op === 'delete') return applyDelete(entry)
  if (op === 'rename') return applyRename(entry)
  return applyWrite(entry)
}

async function applyWrite(entry: QueueEntry): Promise<ApplyResult> {
  const absPath = resolveWorkspacePath(entry.path)
  let current = ''
  try {
    current = await fsp.readFile(absPath, 'utf-8')
  } catch {
    /* file absent on disk — treated as empty, matching staging snapshot for new files */
  }
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  try {
    assertWorkspaceWriteTarget(absPath)
    await fsp.mkdir(dirname(absPath), { recursive: true })
    await fsp.writeFile(absPath, entry.after, 'utf-8')
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

async function applyDelete(entry: QueueEntry): Promise<ApplyResult> {
  const absPath = resolveWorkspacePath(entry.path)
  let current: string
  try {
    current = await fsp.readFile(absPath, 'utf-8')
  } catch {
    return { status: 'error', error: `File not found: ${entry.path}` }
  }
  // Same stale-overwrite guard as writes: refuse if the file changed since staging.
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  try {
    await fsp.rm(absPath)
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

async function applyRename(entry: QueueEntry): Promise<ApplyResult> {
  if (!entry.renameTo) return { status: 'error', error: 'rename target missing' }
  const fromAbs = resolveWorkspacePath(entry.path)
  const toAbs = resolveWorkspacePath(entry.renameTo)
  let current: string
  try {
    current = await fsp.readFile(fromAbs, 'utf-8')
  } catch {
    return { status: 'error', error: `File not found: ${entry.path}` }
  }
  if (current !== entry.before) {
    return { status: 'conflict', current }
  }
  // Don't clobber an existing destination.
  try {
    await fsp.access(toAbs)
    return { status: 'error', error: `Destination already exists: ${entry.renameTo}` }
  } catch {
    /* destination is free */
  }
  try {
    assertWorkspaceWriteTarget(toAbs)
    await fsp.mkdir(dirname(toAbs), { recursive: true })
    await fsp.rename(fromAbs, toAbs)
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

async function applyMkdir(entry: QueueEntry): Promise<ApplyResult> {
  const absPath = resolveWorkspacePath(entry.path)
  try {
    assertWorkspaceWriteTarget(absPath)
    await fsp.mkdir(absPath, { recursive: true })
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (event, path: string) => {
    assertMainFrameSender(event, win)
    const entry = queue.find((e) => e.path === path)
    if (!entry) return
    const result = await applyDiffEntry(entry)
    if (result.status === 'conflict') {
      restage(entry, result.current)
      recordDecision({ path: entry.path, status: 'conflict' })
      mainWindow?.webContents.send('diff:conflict', [entry.path])
      return
    }
    if (result.status === 'error') {
      // Leave the entry queued so the user can retry; surface the failure.
      recordDecision({ path: entry.path, status: 'error', error: result.error })
      throw new Error(`Failed to write ${entry.path}: ${result.error}`)
    }
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    recordOwnershipAfterApply(entry)
    recordDecision({ path: entry.path, status: 'approved' })
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (event, path: string) => {
    assertMainFrameSender(event, win)
    if (queue.some((e) => e.path === path)) recordDecision({ path, status: 'rejected' })
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', (event) => {
    assertMainFrameSender(event, win)
    return approveAllStagedDiffs()
  })

  ipcMain.handle('diff:rejectAll', (event) => {
    assertMainFrameSender(event, win)
    for (const entry of queue) recordDecision({ path: entry.path, status: 'rejected' })
    queue.length = 0
    broadcastQueue()
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
export async function approveAllStagedDiffs(): Promise<void> {
  const conflicts: string[] = []
  const failures: { path: string; error: string }[] = []
  const toApply = [...queue]
  const appliedEntries = new Set<QueueEntry>()
  for (const entry of toApply) {
    const result = await applyDiffEntry(entry)
    if (result.status === 'conflict') {
      restage(entry, result.current)
      recordDecision({ path: entry.path, status: 'conflict' })
      conflicts.push(entry.path)
    } else if (result.status === 'error') {
      recordDecision({ path: entry.path, status: 'error', error: result.error })
      failures.push({ path: entry.path, error: result.error })
    } else {
      recordOwnershipAfterApply(entry)
      recordDecision({ path: entry.path, status: 'approved' })
      appliedEntries.add(entry)
    }
  }
  if (appliedEntries.size > 0) {
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    for (let i = queue.length - 1; i >= 0; i--) {
      if (appliedEntries.has(queue[i]!)) queue.splice(i, 1)
    }
  }
  if (conflicts.length) mainWindow?.webContents.send('diff:conflict', conflicts)
  broadcastQueue()
  if (failures.length > 0) {
    throw new Error(
      `Failed to write ${failures.length} file(s):\n${failures
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
function restage(entry: QueueEntry, current: string): void {
  entry.before = current
  mainWindow?.webContents.send(
    'agent:show_diff',
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
  const hadPending = queue.some((e) => e.path === path)
  upsertStagedDiffEntry(queue, { path, before, after, language, op: 'write' })
  const entry = queue.find((e) => e.path === path)!
  // Payload before queue broadcast so the renderer can populate activeDiff first.
  mainWindow?.webContents.send('agent:show_diff', path, entry.before, entry.after, entry.language)
  broadcastQueue()
  // Headless host (e.g. ACP): resolve the staged entry inline instead of waiting
  // for a renderer that will never answer.
  if (stagedDiffResolver) return resolveStagedEntry(path)
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
  const direct = await canApplyDirectly(path)
  if (!direct.ok) {
    const staged = await stageDiff(path, before, after, language)
    return `${staged}\nReason approval is required: ${direct.reason}.`
  }

  const result = await applyDiffEntry({ path, before, after, language })
  if (result.status === 'written') {
    recordDirectAppliedSnapshot(path, after)
    recordDecision({ path, status: 'applied_directly' })
    const root = getWorkspaceRoot()
    if (root) await buildIndex(root)
    return `Applied edit directly to ${path}. Git was clean except for Copse-applied edits in this session, so no approval was required. You can validate with run_shell/read_file/git now.`
  }
  if (result.status === 'conflict') {
    const staged = await stageDiff(path, result.current, after, language)
    recordDecision({ path, status: 'conflict' })
    return `${staged}\nDirect apply was skipped because the file changed after it was read; review the staged diff before approval.`
  }
  recordDecision({ path, status: 'error', error: result.error })
  return `Failed to write ${path}: ${result.error}`
}

/**
 * Stage a non-content file operation (delete, rename, mkdir) through the diff
 * approval queue (#122) so it inherits the same user-approval safety model as
 * writes. Coalesces by path like {@link stageDiff}. The operation is shown to
 * the user as a before/after diff (delete: full removal; rename: content moved;
 * mkdir: directory marker) and is not applied until approved.
 */
export function stageFileOp(entry: {
  op: DiffOp
  path: string
  before: string
  after: string
  language: string
  renameTo?: string
}): Promise<string> {
  if (isAgentRunReadonly()) return Promise.resolve(READONLY_MODE_BLOCK_MESSAGE)
  const existingIdx = queue.findIndex((e) => e.path === entry.path)
  const queued: QueueEntry = {
    path: entry.path,
    before: entry.before,
    after: entry.after,
    language: entry.language,
    op: entry.op,
    ...(entry.renameTo ? { renameTo: entry.renameTo } : {}),
  }
  if (existingIdx !== -1) {
    queue[existingIdx] = queued
  } else {
    queue.push(queued)
  }
  mainWindow?.webContents.send(
    'agent:show_diff',
    entry.path,
    entry.before,
    entry.after,
    entry.language,
  )
  broadcastQueue()
  if (stagedDiffResolver) return resolveStagedEntry(entry.path)
  const verb =
    entry.op === 'delete'
      ? `Deletion of ${entry.path}`
      : entry.op === 'rename'
        ? `Rename of ${entry.path} → ${entry.renameTo}`
        : `Creation of directory ${entry.path}`
  return Promise.resolve(
    `${verb} staged. Approve or reject in the diff panel — nothing changes on disk until accepted.`,
  )
}

/** @internal test helper — snapshot the current queue. */
export function getDiffQueueForTest(): ReadonlyArray<Readonly<QueueEntry>> {
  return queue.map((e) => ({ ...e }))
}

/** @internal test helper — reset queue state between tests. */
export function clearDiffQueueForTest(): void {
  clearStagedDiffsForTest()
}

function removeEntry(path: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.path === path) queue.splice(i, 1)
  }
  broadcastQueue()
}

function broadcastQueue(): void {
  mainWindow?.webContents.send(
    'diff:queued',
    queue.map((e) => ({ path: e.path, language: e.language })),
  )
}
