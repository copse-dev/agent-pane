/**
 * Streaming-markdown performance benchmark (#618).
 *
 * Replays representative documents token-by-token through both streaming
 * emitters — the incremental DOM path (`StreamingMarkdownRenderer.update`) and
 * the full-re-render string path (`renderStreamingMarkdown`) — and reports the
 * median wall-clock time to stream each fixture to completion.
 *
 * Run: `npm run bench:markdown` (optionally `-- --iters 9 --chunk 4`).
 *
 * The absolute numbers are machine-dependent; treat them as a relative baseline.
 * The incremental DOM path should stay at or below the string path, and neither
 * should scale super-linearly with input size — a large jump for a modest input
 * growth is the O(n²) regression this harness exists to catch.
 */
import '../tests/setup-dom-jsdom.ts'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from '../src/streaming.ts'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Cap replay steps per fixture so a large document can't explode the string
// path's O(n²) re-render (and jsdom sanitize memory) — the chunk size grows to
// keep every fixture at or below this many streamed updates.
const MAX_UPDATES = 160

interface Args {
  iters: number
  warmup: number
  chunk: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { iters: 5, warmup: 2, chunk: 8 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = Number(argv[i + 1])
    if (flag === '--iters' && Number.isFinite(value)) args.iters = value
    if (flag === '--warmup' && Number.isFinite(value)) args.warmup = value
    if (flag === '--chunk' && Number.isFinite(value)) args.chunk = Math.max(1, value)
  }
  return args
}

/** A representative CommonMark document: medium-length passing baseline examples joined. */
function commonMarkMixed(): string {
  return loadBaselinePassingExamples()
    .filter((e) => e.markdown.length >= 20 && e.markdown.length <= 400)
    .slice(0, 60)
    .map((e) => e.markdown.trimEnd())
    .join('\n\n')
}

/** Effective chunk size: at least the requested chunk, but coarse enough to stay ≤ MAX_UPDATES. */
function effectiveChunk(length: number, chunk: number): number {
  return Math.max(chunk, Math.ceil(length / MAX_UPDATES))
}

/** Synthetic worst-case: a wide table plus a long inline-rich list. */
function syntheticTableAndList(rows = 30, items = 45): string {
  const header = '| Name | Status | Owner | Notes |\n| --- | --- | --- | --- |'
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `| item-${String(i)} | ${i % 2 ? 'done' : 'pending'} | \`user_${String(i)}\` | see [#${String(i)}](https://example.com/${String(i)}) |`,
  ).join('\n')
  const list = Array.from(
    { length: items },
    (_, i) =>
      `- **item ${String(i)}**: some \`code_${String(i)}\` and *emphasis* and a [link](path/to/file_${String(i)}.ts)`,
  ).join('\n')
  return `## Report\n\n${header}\n${body}\n\n## Checklist\n\n${list}\n`
}

function termsOfService(): string {
  return readFileSync(resolve(pkgRoot, 'tests/fixtures/terms-of-service-streaming.md'), 'utf8')
}

function chunkBoundaries(length: number, chunk: number): number[] {
  const cuts: number[] = []
  for (let i = chunk; i < length; i += chunk) cuts.push(i)
  cuts.push(length)
  return cuts
}

function benchStringPath(text: string, chunk: number): number {
  const cuts = chunkBoundaries(text.length, chunk)
  const start = performance.now()
  for (const cut of cuts) renderStreamingMarkdown(text.slice(0, cut))
  return performance.now() - start
}

function benchDomPath(text: string, chunk: number): number {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  const cuts = chunkBoundaries(text.length, chunk)
  const start = performance.now()
  for (const cut of cuts) renderer.update(text.slice(0, cut))
  return performance.now() - start
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function measure(run: () => number, iters: number, warmup: number): number {
  for (let i = 0; i < warmup; i++) run()
  const times: number[] = []
  for (let i = 0; i < iters; i++) times.push(run())
  return median(times)
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

const args = parseArgs(process.argv.slice(2))
const fixtures: { name: string; text: string }[] = [
  { name: 'commonmark-mixed', text: commonMarkMixed() },
  { name: 'terms-of-service', text: termsOfService() },
  { name: 'synthetic-table+list', text: syntheticTableAndList() },
]

console.log(
  `streaming-markdown bench — iters=${String(args.iters)} warmup=${String(args.warmup)} chunk=${String(args.chunk)} (node ${process.version})\n`,
)
const cols = [
  pad('fixture', 22),
  padLeft('bytes', 8),
  padLeft('updates', 9),
  padLeft('string ms', 11),
  padLeft('dom ms', 9),
  padLeft('dom/str', 9),
]
console.log(cols.join('  '))
console.log('-'.repeat(cols.join('  ').length))

for (const { name, text } of fixtures) {
  const chunk = effectiveChunk(text.length, args.chunk)
  const updates = chunkBoundaries(text.length, chunk).length
  const stringMs = measure(() => benchStringPath(text, chunk), args.iters, args.warmup)
  const domMs = measure(() => benchDomPath(text, chunk), args.iters, args.warmup)
  const ratio = stringMs > 0 ? domMs / stringMs : 0
  console.log(
    [
      pad(name, 22),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(stringMs.toFixed(2), 11),
      padLeft(domMs.toFixed(2), 9),
      padLeft(ratio.toFixed(2) + '×', 9),
    ].join('  '),
  )
}
