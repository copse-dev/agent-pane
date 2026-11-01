// Structured explore returns (#1433, Fix 0 in docs/plans/agent-loop-efficiency-guards.md).
//
// The explore subagent reads files with `read_file`, so the harness holds the
// exact bytes; its final message is only the model's retelling of them, with
// approximate line numbers. `str_replace` needs a byte-exact `old_string`, so
// an explore result carries two halves: the model's summary, and the spans the
// subagent read, copied verbatim by the harness. This module is the pure half —
// merging, budgeting and rendering spans — and stays storage- and Electron-free.

/** One contiguous run of whole lines a `read_file` call returned, in its LF view. */
export interface ExploredSpan {
  /** Path as the subagent passed it to `read_file` (workspace-relative). */
  path: string
  /** First line, 1-indexed. */
  startLine: number
  /** Last line, inclusive. */
  endLine: number
  /** The lines joined with `\n`, no trailing newline — exactly what read_file showed. */
  text: string
}

export interface ExploreExcerptSelection {
  kept: ExploredSpan[]
  /** Spans left out because the budget ran out; each was dropped whole. */
  dropped: ExploredSpan[]
}

function spanLines(span: ExploredSpan): string[] {
  return span.text.split('\n')
}

/**
 * Merges overlapping or adjacent spans of the same path into one span. Every
 * span comes from a read of the same file during one read-only subagent run,
 * so overlapping lines agree and the union is still verbatim. Paths keep the
 * order they were first read in; spans within a path are sorted by line.
 */
export function mergeExploredSpans(spans: readonly ExploredSpan[]): ExploredSpan[] {
  const byPath = new Map<string, ExploredSpan[]>()
  for (const span of spans) {
    if (span.endLine < span.startLine) continue
    const list = byPath.get(span.path)
    if (list) list.push(span)
    else byPath.set(span.path, [span])
  }
  const merged: ExploredSpan[] = []
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
    let current: { startLine: number; lines: string[] } | null = null
    for (const span of sorted) {
      const lines = spanLines(span)
      if (current === null) {
        current = { startLine: span.startLine, lines }
        continue
      }
      const currentEnd = current.startLine + current.lines.length - 1
      if (span.startLine > currentEnd + 1) {
        merged.push(toSpan(path, current))
        current = { startLine: span.startLine, lines }
        continue
      }
      if (span.endLine > currentEnd) {
        current.lines.push(...lines.slice(currentEnd + 1 - span.startLine))
      }
    }
    if (current !== null) merged.push(toSpan(path, current))
  }
  return merged
}

function toSpan(path: string, run: { startLine: number; lines: string[] }): ExploredSpan {
  return {
    path,
    startLine: run.startLine,
    endLine: run.startLine + run.lines.length - 1,
    text: run.lines.join('\n'),
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.at(-1) ?? path
}

/** True when the summary names this span's file (by path or by file name). */
function summaryCitesPath(summary: string, path: string): boolean {
  const normalized = path.replace(/^\.\//, '')
  return summary.includes(normalized) || summary.includes(basename(normalized))
}

/**
 * Picks which merged spans fit in `budgetChars`. Spans whose file the summary
 * names go first (they are what the parent is about to act on); the rest keep
 * read order. A span that does not fit is dropped whole — never cut mid-span,
 * since a partial excerpt with a full-looking range header is exactly the kind
 * of approximate text this exists to replace — and smaller later spans may
 * still fit.
 */
export function selectExploreExcerpts(
  spans: readonly ExploredSpan[],
  summary: string,
  budgetChars: number,
): ExploreExcerptSelection {
  const merged = mergeExploredSpans(spans)
  const cited = merged.filter((s) => summaryCitesPath(summary, s.path))
  const uncited = merged.filter((s) => !summaryCitesPath(summary, s.path))
  const kept: ExploredSpan[] = []
  const dropped: ExploredSpan[] = []
  let used = 0
  for (const span of [...cited, ...uncited]) {
    if (used + span.text.length <= budgetChars) {
      kept.push(span)
      used += span.text.length
    } else {
      dropped.push(span)
    }
  }
  return { kept, dropped }
}

/** A backtick fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** `line n` or `lines a–b`, for an excerpt header or a list of ranges. */
export function formatLineRange(span: Pick<ExploredSpan, 'startLine' | 'endLine'>): string {
  return span.startLine === span.endLine
    ? `line ${String(span.startLine)}`
    : `lines ${String(span.startLine)}–${String(span.endLine)}`
}

/** One excerpt as the parent sees it: a path/range header and a fence holding exactly the span text. */
export function formatExcerptBlock(span: ExploredSpan): string {
  const fence = fenceFor(span.text)
  return [`\`${span.path}\` ${formatLineRange(span)}:`, fence, span.text, fence].join('\n')
}

export const EXPLORE_EXCERPTS_HEADING = 'Verbatim excerpts'

/**
 * Renders the explore tool result: the summary, then the kept spans as fenced
 * blocks whose content is exactly the span text, then a note naming every
 * dropped span. With nothing read, the summary is returned unchanged.
 */
export function renderExploreResult(summary: string, selection: ExploreExcerptSelection): string {
  if (selection.kept.length === 0 && selection.dropped.length === 0) return summary
  const parts: string[] = [summary.trimEnd(), '', '---', '']
  if (selection.kept.length > 0) {
    parts.push(
      `${EXPLORE_EXCERPTS_HEADING} — copied exactly from the files the explorer read, byte for byte. The summary above is prose with approximate line numbers; copy str_replace old_string from these blocks instead.`,
    )
    for (const span of selection.kept) parts.push('', formatExcerptBlock(span))
  }
  if (selection.dropped.length > 0) {
    const names = selection.dropped.map((s) => `\`${s.path}\` ${formatLineRange(s)}`).join(', ')
    parts.push(
      '',
      `Not quoted (over the excerpt budget for one explore result): ${names}. Call read_explored with the path and lines to quote them verbatim.`,
    )
  }
  return parts.join('\n')
}

/** Outcome of looking lines up in the spans exploration read (#1433, Fix 0b). */
export type ExploredLookup =
  | { kind: 'not-explored' }
  | { kind: 'outside'; available: ExploredSpan[] }
  | {
      kind: 'quoted'
      pieces: ExploredSpan[]
      /** Requested lines exploration never read, as `[start, end]` ranges. */
      unread: [number, number][]
      /** First line left out by `maxChars`, when the quote was cut short. */
      nextLine: number | null
      /**
       * A line longer than `maxChars` on its own, quoted only up to the limit:
       * still exact bytes, but a prefix, so no continuation can complete it.
       */
      cutLine: number | null
    }

function sliceSpan(span: ExploredSpan, start: number, end: number): ExploredSpan {
  const lines = spanLines(span).slice(start - span.startLine, end - span.startLine + 1)
  return { path: span.path, startLine: start, endLine: end, text: lines.join('\n') }
}

/**
 * Looks lines up in the spans explore subagents read this run — never on disk.
 * A path exploration never opened is `not-explored`; a range it never read is
 * `outside`, with the ranges that are available. Otherwise the requested lines
 * that were read come back verbatim, whole lines only, up to `maxChars`. A
 * first line that alone exceeds `maxChars` is cut to that many characters and
 * reported as `cutLine`, so the budget always holds. Without a range, every
 * explored span of the file is quoted.
 */
export function quoteExploredLines(
  spans: readonly ExploredSpan[],
  path: string,
  range: { startLine?: number | undefined; endLine?: number | undefined },
  maxChars: number,
): ExploredLookup {
  const own = mergeExploredSpans(spans.filter((s) => s.path === path))
  if (own.length === 0) return { kind: 'not-explored' }
  const start = range.startLine ?? 1
  const end = range.endLine ?? Number.MAX_SAFE_INTEGER
  const hits = own
    .filter((s) => s.endLine >= start && s.startLine <= end)
    .map((s) => sliceSpan(s, Math.max(start, s.startLine), Math.min(end, s.endLine)))
  if (hits.length === 0) return { kind: 'outside', available: own }

  const unread: [number, number][] = []
  if (range.startLine !== undefined || range.endLine !== undefined) {
    let cursor = start
    for (const hit of hits) {
      if (hit.startLine > cursor) unread.push([cursor, hit.startLine - 1])
      cursor = hit.endLine + 1
    }
    if (range.endLine !== undefined && cursor <= end) unread.push([cursor, end])
  }

  const pieces: ExploredSpan[] = []
  let used = 0
  let nextLine: number | null = null
  let cutLine: number | null = null
  for (const hit of hits) {
    const kept: string[] = []
    for (const line of spanLines(hit)) {
      const cost = line.length + 1
      if (used + cost > maxChars) {
        const lineNo = hit.startLine + kept.length
        if (pieces.length > 0 || kept.length > 0) {
          nextLine = lineNo
          break
        }
        if (line.length > maxChars) {
          // Never split a surrogate pair: the prefix must stay exact text.
          const high = /[\uD800-\uDBFF]/.test(line.charAt(maxChars - 1))
          kept.push(line.slice(0, high ? maxChars - 1 : maxChars))
          cutLine = lineNo
          if (lineNo < hit.endLine || hits.length > 1) nextLine = lineNo + 1
          break
        }
      }
      kept.push(line)
      used += cost
    }
    if (kept.length > 0) {
      pieces.push({
        path,
        startLine: hit.startLine,
        endLine: hit.startLine + kept.length - 1,
        text: kept.join('\n'),
      })
    }
    if (nextLine !== null || cutLine !== null) break
  }
  return { kind: 'quoted', pieces, unread, nextLine, cutLine }
}
