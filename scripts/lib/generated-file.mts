/**
 * Shared write path for the `scripts/sync-*.mts` generators.
 *
 * Each generator renders a whole file, stamps a `// Last synced: <date>` header
 * on it, and wants to leave the file alone when that date is the only thing
 * that would change — so a quiet re-run is a true no-op for the sync workflows'
 * `git diff --quiet` step, and an unrelated PR that happens to re-run a sync
 * doesn't carry a one-line date diff on a reviewed generated file.
 *
 * Every generator had its own copy of that check, and every copy was dead code,
 * because they compared the *raw render* against a file that the previous run
 * had written **and then reformatted with prettier**. The render emits one-line
 * object literals; prettier explodes them past `printWidth`. The two strings
 * therefore never matched, the no-op branch was unreachable, and each run
 * rewrote the file with today's date — which prettier then normalised back into
 * the previous content, leaving exactly a one-line `Last synced:` diff.
 *
 * Formatting first is what makes the comparison mean anything, so that is what
 * this module owns: format, compare modulo the date line, write only if it
 * differs.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { format, resolveConfig } from 'prettier'

/** The header line every generator stamps — the one line allowed to differ. */
const SYNC_DATE_LINE = /\/\/ Last synced: \d{4}-\d{2}-\d{2}\n/

/** A file's content minus its `Last synced:` header: the comparison key. */
export function stripSyncDate(source: string): string {
  return source.replace(SYNC_DATE_LINE, '')
}

/**
 * Render `content` the way it will actually sit on disk, using the repo's
 * prettier config resolved from `path` — the same config `npx prettier --write`
 * would read, so the result is byte-comparable with the existing file.
 */
export async function formatGenerated(path: string, content: string): Promise<string> {
  const config = await resolveConfig(path)
  return await format(content, { ...config, filepath: path })
}

/**
 * Write `content` to `path` unless the only difference from what is already
 * there is the `Last synced:` date. Returns whether the file was written, so
 * the caller can log either the no-op or the summary of what it emitted.
 */
export async function writeGeneratedFile(path: string, content: string): Promise<boolean> {
  const formatted = await formatGenerated(path, content)
  const existing = await readFile(path, 'utf8').catch(() => '')
  if (existing !== '' && stripSyncDate(existing) === stripSyncDate(formatted)) return false
  await writeFile(path, formatted, 'utf8')
  return true
}
