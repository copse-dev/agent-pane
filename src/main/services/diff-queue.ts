import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { resolveWorkspacePath } from './workspace.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { buildIndex } from './file-index.ts'
import { getGitStatus } from './git-service.ts'

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

function recordDirectAppliedSnapshot(path: string, content: string): void {
  // Re-insert so a refreshed path counts as most-recent for eviction.
  directAppliedSnapshots.delete(path)
  directAppliedSnapshots.set(path, content)
  while (directAppliedSnapshots.size > MAX_DIRECT_APPLIED_SNAPSHOTS) {
    const oldest = directAppliedSnapshots.keys().next().value
    if (oldest === undefined) break
    directAppliedSnapshots.delete(oldest)
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
    (changedPath) => !directAppliedSnapshots.has(changedPath),
  )
  if (unownedChanges.length > 0) {
    return {
      ok: false,
      reason: `git already has unowned changes: ${[...new Set(unownedChanges)].join(', ')}`,
    }
  }

  const lastDirectContent = directAppliedSnapshots.get(path)
  if (lastDirectContent !== undefined && (await readCurrentContent(path)) !== lastDirectContent) {
    return {
      ok: false,
      reason: 'the file changed on disk since Copse last applied a direct edit',
    }
  }

  return { ok: true }
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
    await fsp.mkdir(absPath, { recursive: true })
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  return { status: 'written' }
}

export function initDiffQueue(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('diff:approve', async (_e, path: string) => {
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
    recordDecision({ path: entry.path, status: 'approved' })
    removeEntry(path)
  })

  ipcMain.handle('diff:reject', (_e, path: string) => {
    if (queue.some((e) => e.path === path)) recordDecision({ path, status: 'rejected' })
    removeEntry(path)
  })

  ipcMain.handle('diff:approveAll', async () => {
    const conflicts: string[] = []
    const failures: { path: string; error: string }[] = []
    const remaining: QueueEntry[] = []
    let wroteAny = false
    for (const entry of queue) {
      const result = await applyDiffEntry(entry)
      if (result.status === 'conflict') {
        restage(entry, result.current)
        recordDecision({ path: entry.path, status: 'conflict' })
        conflicts.push(entry.path)
        remaining.push(entry)
      } else if (result.status === 'error') {
        // Per-entry failure isolation (#118): keep the failed entry queued for
        // retry and continue applying the rest.
        recordDecision({ path: entry.path, status: 'error', error: result.error })
        failures.push({ path: entry.path, error: result.error })
        remaining.push(entry)
      } else {
        recordDecision({ path: entry.path, status: 'approved' })
        wroteAny = true
      }
    }
    if (wroteAny) {
      const root = getWorkspaceRoot()
      if (root) await buildIndex(root)
    }
    queue.length = 0
    queue.push(...remaining)
    if (conflicts.length) mainWindow?.webContents.send('diff:conflict', conflicts)
    broadcastQueue()
    if (failures.length > 0) {
      throw new Error(
        `Failed to write ${failures.length} file(s):\n${failures
          .map((f) => `  ${f.path}: ${f.error}`)
          .join('\n')}`,
      )
    }
  })

  ipcMain.handle('diff:rejectAll', () => {
    for (const entry of queue) recordDecision({ path: entry.path, status: 'rejected' })
    queue.length = 0
    broadcastQueue()
  })
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
  const hadPending = queue.some((e) => e.path === path)
  upsertStagedDiffEntry(queue, { path, before, after, language, op: 'write' })
  const entry = queue.find((e) => e.path === path)!
  // Payload before queue broadcast so the renderer can populate activeDiff first.
  mainWindow?.webContents.send('agent:show_diff', path, entry.before, entry.after, entry.language)
  broadcastQueue()
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
