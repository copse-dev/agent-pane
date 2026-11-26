/**
 * The filesystem steps that undo a contained command's change to host-run
 * configuration (`workspace-integrity.ts`).
 *
 * In the app these steps run in the sandbox fs worker under the same write
 * policy as the command that made the change, so a revert can never touch a
 * path the command itself could not have written. This module also runs them
 * in-process where no sandbox exists (tests), and it is written so that even
 * then it does not act through a planted symlink:
 *
 * - every directory between the step's anchor and the path is checked with
 *   `lstat` right before the operation, and must be a real directory;
 * - a step whose path is below a step that failed is skipped;
 * - a restored file is written to a temp file with an unpredictable name,
 *   created exclusively, then renamed over the path (rename replaces a symlink
 *   itself, never what it points at);
 * - removal never follows a symlink.
 *
 * A contained process that is still running can still race the in-process
 * variant, which is why the app runs it sandboxed.
 *
 * Must stay free of electron imports: the sandbox fs worker bundles it.
 */
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, rm, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isRecord } from '@shared/unknown-value.ts'

export type RestoreStep =
  /** Remove whatever is at `path`, without following a symlink. */
  | { readonly op: 'remove'; readonly anchor: string; readonly path: string }
  /** Make `path` a real directory, replacing anything else there. */
  | { readonly op: 'mkdir'; readonly anchor: string; readonly path: string }
  /** Make `path` a symlink to `target`, replacing anything there. */
  | {
      readonly op: 'symlink'
      readonly anchor: string
      readonly path: string
      readonly target: string
    }
  /** Make `path` a regular file with these bytes (base64) and mode. */
  | {
      readonly op: 'write'
      readonly anchor: string
      readonly path: string
      readonly data: string
      readonly mode: number
    }

/** Parse steps sent to the sandbox fs worker. `null` when any step is malformed. */
export function parseRestoreSteps(value: unknown): RestoreStep[] | null {
  if (!Array.isArray(value)) return null
  const steps: RestoreStep[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const { op, anchor, path } = item
    if (typeof anchor !== 'string' || typeof path !== 'string') return null
    if (!isAbsolute(anchor) || !isAbsolute(path) || !isStrictlyWithin(anchor, path)) return null
    if (op === 'remove' || op === 'mkdir') {
      steps.push({ op, anchor, path })
    } else if (op === 'symlink' && typeof item['target'] === 'string') {
      steps.push({ op, anchor, path, target: item['target'] })
    } else if (
      op === 'write' &&
      typeof item['data'] === 'string' &&
      typeof item['mode'] === 'number' &&
      Number.isInteger(item['mode'])
    ) {
      steps.push({ op, anchor, path, data: item['data'], mode: item['mode'] & 0o7777 })
    } else {
      return null
    }
  }
  return steps
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

/**
 * Check that every directory from `anchor` down to `dirname(path)` is a real
 * directory. With `create`, missing directories are made one level at a time.
 * `false` when a component is a symlink or not a directory, or (without
 * `create`) missing.
 */
async function verifiedParent(anchor: string, path: string, create: boolean): Promise<boolean> {
  const anchorStats = await lstatOrNull(anchor)
  if (!anchorStats?.isDirectory()) return false
  const parts = relative(anchor, dirname(path))
    .split(sep)
    .filter((part) => part !== '')
  let cursor = anchor
  for (const part of parts) {
    cursor = join(cursor, part)
    let stats = await lstatOrNull(cursor)
    if (!stats && create) {
      try {
        await mkdir(cursor)
      } catch {
        // Lost a race to another writer; the lstat below decides.
      }
      stats = await lstatOrNull(cursor)
    }
    if (!stats?.isDirectory()) return false
  }
  return true
}

/** Remove `path` itself: a symlink is unlinked, never followed. */
async function removeEntry(path: string): Promise<void> {
  const stats = await lstatOrNull(path)
  if (!stats) return
  if (stats.isDirectory()) {
    // Node's recursive rm lstat()s each entry and unlinks symlinks.
    await rm(path, { recursive: true, force: true })
  } else {
    await unlink(path)
  }
}

async function writeReplacing(step: Extract<RestoreStep, { op: 'write' }>): Promise<boolean> {
  const temp = join(
    dirname(step.path),
    `.${basename(step.path)}.copse-restore-${randomBytes(12).toString('hex')}`,
  )
  // `wx` is O_CREAT|O_EXCL: it never opens an existing file or follows a symlink.
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(Buffer.from(step.data, 'base64'))
    await handle.chmod(step.mode)
  } finally {
    await handle.close()
  }
  try {
    if (!(await verifiedParent(step.anchor, step.path, false))) return false
    const existing = await lstatOrNull(step.path)
    if (existing?.isDirectory()) await removeEntry(step.path)
    await rename(temp, step.path)
    return true
  } finally {
    await rm(temp, { force: true })
  }
}

async function applyStep(step: RestoreStep): Promise<boolean> {
  const create = step.op !== 'remove'
  if (!(await verifiedParent(step.anchor, step.path, create))) {
    // Nothing to remove under a parent that is not there.
    return step.op === 'remove' && (await lstatOrNull(dirname(step.path))) === null
  }
  switch (step.op) {
    case 'remove':
      await removeEntry(step.path)
      return true
    case 'mkdir': {
      const existing = await lstatOrNull(step.path)
      if (existing?.isDirectory()) return true
      if (existing) await removeEntry(step.path)
      await mkdir(step.path)
      return true
    }
    case 'symlink':
      await removeEntry(step.path)
      await symlink(step.target, step.path)
      return true
    case 'write':
      return writeReplacing(step)
  }
}

/** Apply `steps` in order. One result per step; `false` when it was skipped or failed. */
export async function applyRestoreSteps(steps: readonly RestoreStep[]): Promise<boolean[]> {
  const failed: string[] = []
  const results: boolean[] = []
  for (const step of steps) {
    if (failed.some((path) => isStrictlyWithin(path, step.path))) {
      failed.push(step.path)
      results.push(false)
      continue
    }
    const ok = await applyStep(step).catch(() => false)
    if (!ok) failed.push(step.path)
    results.push(ok)
  }
  return results
}
