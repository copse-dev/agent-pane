import * as fsp from 'node:fs/promises'
import { resolveWorkspacePath } from './workspace.ts'
import type { DiffApplyResult } from '@shared/types/diff.ts'

/** Re-read disk and write only if content still matches the staged `before` snapshot. */
export async function applyStagedWrite(
  relativePath: string,
  before: string,
  after: string,
): Promise<DiffApplyResult> {
  const absPath = resolveWorkspacePath(relativePath)
  let current = ''
  try {
    current = await fsp.readFile(absPath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (before === '' && code === 'ENOENT') {
      await fsp.writeFile(absPath, after, 'utf-8')
      return { ok: true }
    }
    if (before === '') {
      return {
        ok: false,
        reason: 'disk_changed',
        message: `Cannot create ${relativePath}: file appeared on disk since the diff was staged.`,
      }
    }
    return {
      ok: false,
      reason: 'disk_changed',
      message: `Cannot apply diff for ${relativePath}: file was removed or is unreadable.`,
    }
  }

  if (current !== before) {
    return {
      ok: false,
      reason: 'disk_changed',
      message: `Cannot apply diff for ${relativePath}: file changed on disk since the diff was staged. Re-read the file and propose a new edit.`,
    }
  }

  await fsp.writeFile(absPath, after, 'utf-8')
  return { ok: true }
}
