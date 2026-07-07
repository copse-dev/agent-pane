/**
 * Pure, DOM-free detection of file-path references in free text. Shared by the
 * chat markdown linker (`renderer/markdown/file-links.ts`) and the terminal link
 * provider (`renderer/views/terminal-file-links.ts`) so both agree on exactly
 * what looks like a workspace file.
 *
 * A reference is the path itself plus an optional `:line` or `:line:col` suffix
 * (as printed by compilers, grep, stack traces, etc.). The path is exposed as
 * `candidate` for resolution against the file index; the full matched span,
 * including any line/col, is exposed as `text` for display and range mapping.
 */

const FILE_REFERENCE_RE =
  /(^|[^A-Za-z0-9_./-])((?:\.\/)?(?:[A-Za-z0-9_@+$.-]+\/)+[A-Za-z0-9_@+$.-]*|\.[A-Za-z0-9_@+$-][A-Za-z0-9_@+$.-]{0,30}|[A-Za-z0-9_@+$-]+\.[A-Za-z0-9][A-Za-z0-9.-]{0,15}|Dockerfile|Makefile)(?::(\d+)(?::(\d+))?)?(?=$|[^A-Za-z0-9_./-])/g

const TRAILING_PROSE_PUNCTUATION_RE = /[.,;:!?]+$/

export interface FileReferenceMatch {
  /** Path portion only, used to resolve against the workspace file index. */
  candidate: string
  /** Full matched text including any `:line:col`, used for display and ranges. */
  text: string
  /** Offset of `text` within the scanned string. */
  start: number
  /** Offset just past `text` within the scanned string. */
  end: number
  /** 1-based line number when the reference carried a `:line` suffix. */
  line?: number
  /** 1-based column number when the reference carried a `:line:col` suffix. */
  column?: number
}

/**
 * The filename regex runs over prose, so it can consume punctuation from text
 * like `renderer.ts.`. Keep that punctuation outside the link by shortening the
 * matched range. A `:line:col` suffix already bounds the path, so trimming only
 * applies to bare paths.
 */
export function fileReferenceMatches(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = []
  FILE_REFERENCE_RE.lastIndex = 0
  for (let match = FILE_REFERENCE_RE.exec(text); match; match = FILE_REFERENCE_RE.exec(text)) {
    const prefix = match[1] ?? ''
    const path = match[2]
    if (!path) continue
    const start = match.index + prefix.length

    if (match[3] != null) {
      const lineStr = match[3]
      const colStr = match[4]
      const display = colStr != null ? `${path}:${lineStr}:${colStr}` : `${path}:${lineStr}`
      matches.push({
        candidate: path,
        text: display,
        start,
        end: start + display.length,
        line: Number(lineStr),
        ...(colStr != null ? { column: Number(colStr) } : {}),
      })
      continue
    }

    const trimmed = path.replace(TRAILING_PROSE_PUNCTUATION_RE, '')
    if (trimmed === '') continue
    // Directories print with a trailing slash (`git status` untracked dirs,
    // `ls -F`, tab completion). Keep the slash in the displayed text but strip
    // it from the candidate — the resolver rejects empty path segments (#506).
    const candidate = trimmed.replace(/\/+$/, '')
    if (candidate === '') continue
    matches.push({ candidate, text: trimmed, start, end: start + trimmed.length })
  }
  return matches
}

/**
 * The main-process IPC guard for `index:resolveFileReferences` rejects calls
 * carrying more than this many candidates. A single message or terminal viewport
 * can legitimately reference more (e.g. a long directory/skill listing), so
 * callers resolve in batches of this size rather than overflowing the cap.
 */
export const FILE_REFERENCE_RESOLVE_BATCH_SIZE = 200

/**
 * Resolve candidates against the workspace index in batches that stay within the
 * IPC cap, concatenating every batch's resolutions. `resolve` performs the IPC
 * call for one batch.
 */
export async function resolveFileReferencesInBatches<T>(
  candidates: string[],
  resolve: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < candidates.length; i += FILE_REFERENCE_RESOLVE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + FILE_REFERENCE_RESOLVE_BATCH_SIZE)
    // IPC boundary: declared non-null, but the value crosses the preload bridge
    // and could be malformed at runtime, so guard defensively.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    out.push(...((await resolve(batch)) ?? []))
  }
  return out
}
