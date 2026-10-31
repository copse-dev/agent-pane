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

function rangeLabel(span: ExploredSpan): string {
  return span.startLine === span.endLine
    ? `line ${String(span.startLine)}`
    : `lines ${String(span.startLine)}–${String(span.endLine)}`
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
    for (const span of selection.kept) {
      const fence = fenceFor(span.text)
      parts.push('', `\`${span.path}\` ${rangeLabel(span)}:`, fence, span.text, fence)
    }
  }
  if (selection.dropped.length > 0) {
    const names = selection.dropped.map((s) => `\`${s.path}\` ${rangeLabel(s)}`).join(', ')
    parts.push(
      '',
      `Not quoted (over the excerpt budget for one explore result): ${names}. Explore again with paths set to the file and a narrower question to get those lines verbatim.`,
    )
  }
  return parts.join('\n')
}
