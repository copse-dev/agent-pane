/**
 * Pure parser and applier for the `apply_patch` envelope format.
 *
 * The format is the one Codex's `apply-patch` crate (openai/codex,
 * codex-rs/apply-patch) accepts:
 *
 *     *** Begin Patch
 *     *** Add File: path            (every following line is `+text`)
 *     *** Delete File: path
 *     *** Update File: path
 *     *** Move to: new/path         (optional, directly after the header)
 *     @@ optional context line      (locates the hunk; repeatable)
 *      context line                 (` ` prefix, kept)
 *     -removed line
 *     +added line
 *     *** End of File               (optional: the hunk applies at the end)
 *     *** End Patch
 *
 * Differences from Codex, all deliberate:
 * - `Add File` fails when the file already exists (Codex silently overwrites),
 *   so a mistaken re-add cannot destroy content; the error names `Update File`.
 * - Consecutive `@@` lines nest (each is located in turn) instead of erroring.
 * - A hunk that is out of order is reported as such, with the line it was
 *   actually found at, rather than as a plain "not found".
 * - The file's line-ending style and trailing-newline state are preserved.
 *
 * Nothing here touches the filesystem: {@link planPatch} takes a `readFile`
 * callback and returns the full set of changes, or the first error, so the
 * caller can validate everything before it writes anything.
 */

export interface PatchChunk {
  /** `@@` lines that must be located, in order, before the chunk's own lines. */
  contexts: string[]
  oldLines: string[]
  newLines: string[]
  /** `*** End of File`: the old lines must match at the end of the file. */
  isEndOfFile: boolean
}

export type PatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath: string | null; chunks: PatchChunk[] }

export type ParsePatchResult = { ok: true; hunks: PatchHunk[] } | { ok: false; error: string }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '
const EOF = '*** End of File'

const HEADER_HINT =
  "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"

function normalizePatchPath(raw: string): string {
  return raw.trim().replace(/^(?:\.\/)+/, '')
}

/**
 * Strip a `<<'EOF' ... EOF` heredoc wrapper. Models that learned the shell
 * form of the tool (`apply_patch <<'EOF'`) carry it over.
 */
function unwrapHeredoc(lines: string[]): string[] {
  const first = lines[0]?.trim() ?? ''
  const last = lines[lines.length - 1]?.trim() ?? ''
  const startsHeredoc = /^(?:apply_patch\s+)?<<-?\s*['"]?EOF['"]?$/.test(first)
  if (startsHeredoc && last.endsWith('EOF') && lines.length >= 4) return lines.slice(1, -1)
  return lines
}

export function parsePatch(patchText: string): ParsePatchResult {
  const all = unwrapHeredoc(patchText.trim().split(/\r?\n/))
  if ((all[0] ?? '').trim() !== BEGIN) {
    return { ok: false, error: `The first line of the patch must be '${BEGIN}'.` }
  }
  if ((all[all.length - 1] ?? '').trim() !== END || all.length < 2) {
    return { ok: false, error: `The last line of the patch must be '${END}'.` }
  }
  const body = all.slice(1, -1)

  const hunks: PatchHunk[] = []
  // Line numbers in errors are 1-based positions in the patch as sent.
  let index = 0
  const lineNumber = (): number => index + 2
  const fail = (message: string): ParsePatchResult => ({
    ok: false,
    error: `Invalid patch at line ${String(lineNumber())}: ${message}`,
  })

  while (index < body.length) {
    const line = body[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') {
      index += 1
      continue
    }

    if (trimmed.startsWith(ADD)) {
      const path = normalizePatchPath(trimmed.slice(ADD.length))
      if (path === '') return fail('Add File needs a path.')
      index += 1
      const added: string[] = []
      while (index < body.length && (body[index] ?? '').startsWith('+')) {
        added.push((body[index] ?? '').slice(1))
        index += 1
      }
      const next = (body[index] ?? '').trim()
      if (index < body.length && !isHunkHeader(next)) {
        return fail(
          `'${next}' is not valid inside Add File ${path}: every line of a new file must start with '+'.`,
        )
      }
      hunks.push({ kind: 'add', path, contents: added.length === 0 ? '' : `${added.join('\n')}\n` })
      continue
    }

    if (trimmed.startsWith(DELETE)) {
      const path = normalizePatchPath(trimmed.slice(DELETE.length))
      if (path === '') return fail('Delete File needs a path.')
      hunks.push({ kind: 'delete', path })
      index += 1
      continue
    }

    if (trimmed.startsWith(UPDATE)) {
      const path = normalizePatchPath(trimmed.slice(UPDATE.length))
      if (path === '') return fail('Update File needs a path.')
      const headerLine = lineNumber()
      index += 1
      let movePath: string | null = null
      const moveLine = body[index]?.trimEnd() ?? ''
      if (moveLine.startsWith(MOVE)) {
        movePath = normalizePatchPath(moveLine.slice(MOVE.length))
        if (movePath === '') return fail('Move to needs a path.')
        index += 1
      }
      const chunks: PatchChunk[] = []
      const state: { chunk: PatchChunk | null } = { chunk: null }
      const open = (): PatchChunk => {
        if (state.chunk === null) {
          state.chunk = { contexts: [], oldLines: [], newLines: [], isEndOfFile: false }
          chunks.push(state.chunk)
        }
        return state.chunk
      }
      const isEmptyChunk = (chunk: PatchChunk): boolean =>
        chunk.oldLines.length === 0 && chunk.newLines.length === 0

      let afterEof = false
      while (index < body.length) {
        const raw = body[index] ?? ''
        const marker = raw.trimEnd()
        if (isHunkHeader(marker.trim())) break
        if (afterEof && raw === '') {
          index += 1
          continue
        }
        afterEof = false

        if (marker === '@@' || marker.startsWith('@@ ')) {
          const context = marker === '@@' ? null : marker.slice(3)
          if (state.chunk !== null && !isEmptyChunk(state.chunk)) {
            state.chunk = null
          }
          if (context !== null) open().contexts.push(context)
          else open()
          index += 1
          continue
        }
        if (marker === EOF) {
          if (state.chunk === null || isEmptyChunk(state.chunk)) {
            return fail('End of File must follow the lines of a hunk.')
          }
          state.chunk.isEndOfFile = true
          // Whatever follows starts a new hunk, so it needs its own @@.
          state.chunk = null
          afterEof = true
          index += 1
          continue
        }
        if (raw === '') {
          // A bare empty line is an empty context line (editors strip the
          // trailing space of ` `).
          const chunk = open()
          chunk.oldLines.push('')
          chunk.newLines.push('')
        } else if (raw.startsWith(' ')) {
          const chunk = open()
          chunk.oldLines.push(raw.slice(1))
          chunk.newLines.push(raw.slice(1))
        } else if (raw.startsWith('+')) {
          open().newLines.push(raw.slice(1))
        } else if (raw.startsWith('-')) {
          open().oldLines.push(raw.slice(1))
        } else {
          return fail(
            `Unexpected line in Update File ${path}: '${raw}'. Every line of a hunk must start with ' ' (context), '+' (added), '-' (removed), or be an '@@' header.`,
          )
        }
        index += 1
      }
      if (chunks.length === 0 || chunks.every((chunk) => isEmptyChunk(chunk))) {
        return {
          ok: false,
          error: `Invalid patch at line ${String(headerLine)}: Update File ${path} contains no changes.`,
        }
      }
      hunks.push({ kind: 'update', path, movePath, chunks })
      continue
    }

    return fail(`'${trimmed}' is not a valid hunk header. ${HEADER_HINT}`)
  }

  if (hunks.length === 0) return { ok: false, error: 'The patch contains no file changes.' }
  return { ok: true, hunks }
}

function isHunkHeader(trimmed: string): boolean {
  return trimmed.startsWith(ADD) || trimmed.startsWith(DELETE) || trimmed.startsWith(UPDATE)
}

// ─── locating a hunk ─────────────────────────────────────────────────────

const UNICODE_PUNCTUATION: Readonly<Record<string, string>> = {
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '　': ' ',
}

function foldPunctuation(line: string): string {
  return line
    .trim()
    .replace(
      /[\u2010-\u2015\u2212\u2018-\u201F\u00A0\u2002-\u200A\u202F\u205F\u3000]/g,
      (ch) => UNICODE_PUNCTUATION[ch] ?? ch,
    )
}

/** Line comparators from strictest to loosest; the first that matches wins. */
const LINE_MATCHERS: readonly ((a: string, b: string) => boolean)[] = [
  (a, b): boolean => a === b,
  (a, b): boolean => a.trimEnd() === b.trimEnd(),
  (a, b): boolean => a.trim() === b.trim(),
  (a, b): boolean => foldPunctuation(a) === foldPunctuation(b),
]

/**
 * Index of the first place `pattern` occurs in `lines` at or after `start`,
 * trying each matcher in turn so an exact match anywhere beats a whitespace-
 * insensitive match earlier. With `eof`, the end of the file is tried first.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return null
  const last = lines.length - pattern.length
  for (const same of LINE_MATCHERS) {
    const matchesAt = (at: number): boolean =>
      pattern.every((line, offset) => same(lines[at + offset] ?? '', line))
    if (eof && last >= start && matchesAt(last)) return last
    for (let at = start; at <= last; at += 1) {
      if (matchesAt(at)) return at
    }
  }
  return null
}

/**
 * Locate an `@@` line. Whole-line matching first; then a line that merely
 * starts with it, because models write the signature without its tail
 * (`@@ export function greet` for `export function greet(): string {`).
 */
function seekContextLine(lines: readonly string[], context: string, start: number): number | null {
  const whole = seekSequence(lines, [context], start, false)
  if (whole !== null) return whole
  const wanted = context.trim()
  if (wanted === '') return null
  for (let at = start; at < lines.length; at += 1) {
    if ((lines[at] ?? '').trim().startsWith(wanted)) return at
  }
  return null
}

function preview(lines: readonly string[], limit = 6): string {
  const shown = lines.slice(0, limit).map((line) => `  ${line}`)
  if (lines.length > limit) shown.push(`  … (${String(lines.length - limit)} more lines)`)
  return shown.join('\n')
}

interface Replacement {
  start: number
  removed: number
  added: string[]
}

/** Split into logical lines plus the file's EOL style and trailing-newline state. */
function splitFile(content: string): {
  lines: string[]
  eol: '\n' | '\r\n'
  finalNewline: boolean
} {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? content.replace(/\r\n/g, '\n') : content
  const finalNewline = normalized.endsWith('\n')
  const lines = normalized === '' ? [] : normalized.split('\n')
  if (finalNewline) lines.pop()
  return { lines, eol, finalNewline }
}

export type ApplyChunksResult = { ok: true; content: string } | { ok: false; error: string }

/** Apply an Update File hunk's chunks to `original`. */
export function applyChunks(
  original: string,
  chunks: readonly PatchChunk[],
  path: string,
): ApplyChunksResult {
  const { lines, eol, finalNewline } = splitFile(original)
  const replacements: Replacement[] = []
  let cursor = 0

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const label = `Hunk ${String(chunkIndex + 1)} of ${String(chunks.length)} for ${path}`

    for (const context of chunk.contexts) {
      const found = seekContextLine(lines, context, cursor)
      if (found === null) {
        const earlier = seekContextLine(lines, context, 0)
        const hint =
          earlier === null
            ? 'It does not appear anywhere in the file; read_file the file and copy the line exactly.'
            : `It appears at line ${String(earlier + 1)}, before the previous hunk ended; hunks must be listed in file order.`
        return {
          ok: false,
          error: `${label} failed: could not find the @@ context line "${context}". ${hint}`,
        }
      }
      cursor = found + 1
    }

    if (chunk.oldLines.length === 0) {
      // Pure insertion: with a context it goes right after that line, otherwise
      // at the end of the file.
      const at = chunk.contexts.length > 0 ? cursor : lines.length
      replacements.push({ start: at, removed: 0, added: chunk.newLines })
      cursor = at
      continue
    }

    let pattern = chunk.oldLines
    let added = chunk.newLines
    let found = seekSequence(lines, pattern, cursor, chunk.isEndOfFile)
    if (found === null && pattern[pattern.length - 1] === '') {
      // A trailing blank line in the hunk stands for the file's final newline.
      pattern = pattern.slice(0, -1)
      if (added[added.length - 1] === '') added = added.slice(0, -1)
      found = seekSequence(lines, pattern, cursor, chunk.isEndOfFile)
    }
    if (found === null) {
      const earlier = seekSequence(lines, pattern, 0, false)
      const hint =
        earlier === null
          ? 'Call read_file on the file and copy the lines exactly (context lines must match the current file content).'
          : `These lines exist at line ${String(earlier + 1)}, before the previous hunk ended; hunks must be listed in file order.`
      return {
        ok: false,
        error: `${label} failed: could not find the expected lines${cursor > 0 ? ` after line ${String(cursor)}` : ''}:\n${preview(chunk.oldLines)}\n${hint}`,
      }
    }
    replacements.push({ start: found, removed: pattern.length, added })
    cursor = found + pattern.length
  }

  const result = [...lines]
  for (const { start, removed, added } of [...replacements].sort((a, b) => b.start - a.start)) {
    result.splice(start, removed, ...added)
  }
  // Keep the file's trailing-newline state, but never leave a non-empty file
  // unterminated because the edit appended to a file that lacked one.
  const endsWithNewline =
    finalNewline || lines.length === 0 || replacements.some((r) => r.start >= lines.length)
  const body = result.join('\n')
  const joined = result.length > 0 && endsWithNewline ? `${body}\n` : body
  return { ok: true, content: eol === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined }
}

// ─── planning a whole patch ──────────────────────────────────────────────

/** The net effect of a patch on one path. `null` means the file does not exist. */
export interface PatchFileChange {
  path: string
  before: string | null
  after: string | null
}

export type PlanPatchResult =
  | { ok: true; changes: PatchFileChange[] }
  | { ok: false; error: string }

/**
 * Work out every file's final content without touching disk.
 *
 * `readFile` returns a file's current content, or `null` when it does not
 * exist. Hunks see the result of earlier hunks in the same patch, so a patch
 * may add a file and then update it, or move a file and edit the destination.
 * The first failing hunk aborts the plan: nothing is half-applied.
 */
export async function planPatch(
  hunks: readonly PatchHunk[],
  readFile: (path: string) => Promise<string | null>,
): Promise<PlanPatchResult> {
  const original = new Map<string, string | null>()
  const current = new Map<string, string | null>()

  const read = async (path: string): Promise<string | null> => {
    if (current.has(path)) return current.get(path) ?? null
    const content = await readFile(path)
    original.set(path, content)
    current.set(path, content)
    return content
  }
  const write = async (path: string, content: string | null): Promise<void> => {
    if (!original.has(path)) original.set(path, await readFile(path))
    current.set(path, content)
  }

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const step = `Patch entry ${String(hunkIndex + 1)} (${hunk.kind} ${hunk.path})`
    if (hunk.kind === 'add') {
      if ((await read(hunk.path)) !== null) {
        return {
          ok: false,
          error: `${step} failed: ${hunk.path} already exists. Use '*** Update File: ${hunk.path}' to change it.`,
        }
      }
      await write(hunk.path, hunk.contents)
    } else if (hunk.kind === 'delete') {
      if ((await read(hunk.path)) === null) {
        return { ok: false, error: `${step} failed: ${hunk.path} does not exist.` }
      }
      await write(hunk.path, null)
    } else {
      const content = await read(hunk.path)
      if (content === null) {
        return { ok: false, error: `${step} failed: ${hunk.path} does not exist.` }
      }
      const applied = applyChunks(content, hunk.chunks, hunk.path)
      if (!applied.ok) return { ok: false, error: applied.error }
      const destination = hunk.movePath ?? hunk.path
      if (destination !== hunk.path) {
        if ((await read(destination)) !== null) {
          return {
            ok: false,
            error: `${step} failed: cannot move to ${destination}, which already exists.`,
          }
        }
        await write(hunk.path, null)
      }
      await write(destination, applied.content)
    }
  }

  const changes: PatchFileChange[] = []
  for (const [path, after] of current) {
    const before = original.get(path) ?? null
    if (before === after) continue
    changes.push({ path, before, after })
  }
  if (changes.length === 0)
    return { ok: false, error: 'No change: the patch leaves every file as it was.' }
  return { ok: true, changes }
}

// ─── display summary (tolerant; used by the renderer) ─────────────────────

export interface PatchFileSummary {
  path: string
  op: 'add' | 'update' | 'delete' | 'move'
  movePath?: string
  additions: number
  deletions: number
}

/**
 * Per-file summary of patch text for a tool card. Never throws and accepts an
 * incomplete patch (a call still streaming, or a rejected one), unlike
 * {@link parsePatch}.
 */
export function summarizePatch(patchText: string): PatchFileSummary[] {
  const summaries: PatchFileSummary[] = []
  let current: PatchFileSummary | null = null
  for (const raw of patchText.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed.startsWith(ADD)) {
      current = {
        path: normalizePatchPath(trimmed.slice(ADD.length)),
        op: 'add',
        additions: 0,
        deletions: 0,
      }
      summaries.push(current)
    } else if (trimmed.startsWith(DELETE)) {
      current = {
        path: normalizePatchPath(trimmed.slice(DELETE.length)),
        op: 'delete',
        additions: 0,
        deletions: 0,
      }
      summaries.push(current)
    } else if (trimmed.startsWith(UPDATE)) {
      current = {
        path: normalizePatchPath(trimmed.slice(UPDATE.length)),
        op: 'update',
        additions: 0,
        deletions: 0,
      }
      summaries.push(current)
    } else if (current !== null && raw.trimEnd().startsWith(MOVE)) {
      current.op = 'move'
      current.movePath = normalizePatchPath(raw.trimEnd().slice(MOVE.length))
    } else if (current !== null && raw.startsWith('+')) {
      current.additions += 1
    } else if (current !== null && raw.startsWith('-') && current.op !== 'add') {
      current.deletions += 1
    }
  }
  return summaries.filter((summary) => summary.path !== '')
}

/** Every workspace path a patch names, move destinations included (deduplicated). */
export function patchTouchedPaths(patchText: unknown): string[] {
  if (typeof patchText !== 'string') return []
  const paths = summarizePatch(patchText).flatMap((summary) =>
    summary.movePath === undefined ? [summary.path] : [summary.path, summary.movePath],
  )
  return [...new Set(paths)]
}
