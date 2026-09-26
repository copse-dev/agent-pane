// The pull request's summary block (docs/plans/copse-reviewer.md, §PR
// description summary): a risk level and a short overview of what the change
// does, kept at the bottom of the pull request's description between two
// markers and replaced in place on every run — the shape Cursor's Bugbot and
// similar reviewers use.
//
// A summary is not a finding and is not held to the findings' evidence bar,
// but it is still grounded where evidence exists: a surfaced high-severity
// finding raises the risk to High whatever the model said. The text comes from
// a model that read an untrusted diff and is written under the App's identity,
// so every model-written line goes through the same inert-markdown escaping as
// review comments; that also keeps a crafted diff from forging the end marker.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { HeadlessEvent } from '@copse/agent/headless-contract.ts'
import { EXTERNAL_CONTENT_BLOCK } from '@copse/agent/external-content.ts'
import type { LLMProvider, LLMTool } from '@copse/llm/wire-types.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { renderReviewContext, type ReviewContext } from './context.ts'
import {
  ERROR_EXCERPT_CHARS,
  ForgeReviewError,
  forgeHeaders,
  inertMarkdown,
  pullRequestUrl,
  type FetchLike,
  type ForgeTarget,
} from './forge-review.ts'
import type { ReviewReport } from './stage5.ts'
import { runTurn, type TurnResult } from './turn.ts'

export const SUMMARY_RISKS = ['low', 'medium', 'high'] as const
export type SummaryRisk = (typeof SUMMARY_RISKS)[number]

const MAX_OVERVIEW_ITEMS = 5

const summarySchema = z.object({
  risk: z.enum(SUMMARY_RISKS),
  riskReason: z.string().trim().min(8).max(300),
  overview: z.array(z.string().trim().min(8).max(400)).min(1).max(MAX_OVERVIEW_ITEMS),
})

export interface PrSummary {
  readonly risk: SummaryRisk
  readonly riskReason: string
  readonly overview: readonly string[]
  /** Why the evidence raised the model's risk level, when it did. */
  readonly raisedBecause?: string
}

const START_MARKER = '<!-- copse-review-summary -->'
const END_MARKER = '<!-- /copse-review-summary -->'

function writeSummaryTool(): LLMTool {
  return {
    name: 'write_summary',
    description:
      'Required, and the only tool. Record the summary of the change for the pull request description. Call exactly once.',
    parameters: {
      type: 'object',
      properties: {
        risk: {
          type: 'string',
          enum: [...SUMMARY_RISKS],
          description: 'How much could go wrong if this change is wrong',
        },
        riskReason: {
          type: 'string',
          minLength: 8,
          maxLength: 300,
          description: 'One sentence: why this risk level, naming the surfaces the change touches',
        },
        overview: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OVERVIEW_ITEMS,
          items: { type: 'string', minLength: 8, maxLength: 400 },
          description:
            'Two to four short points on what the change does, most important first; one sentence each',
        },
      },
      required: ['risk', 'riskReason', 'overview'],
    },
  }
}

export function summarySystemPrompt(): string {
  return [
    'You are Copse Reviewer, writing the summary that sits at the bottom of a pull request description.',
    'Describe what the change does and how risky it is. Do not review it: finding bugs is a separate step, so do not speculate about defects or suggest improvements.',
    '',
    'Risk levels:',
    '- low: documentation, tests, comments, configuration with no runtime effect, or a small, contained behaviour change.',
    '- medium: a runtime behaviour change in a bounded area, or a change to shared code with a limited set of callers.',
    '- high: security, permissions or sandboxing, authentication or secrets, persisted data or migrations, process or IPC boundaries, concurrency, dependency or build changes, or a broad cross-cutting change.',
    '',
    'Write for a reviewer who has not opened the diff. Name files, functions or settings only when that makes a point clearer. Say what changed and why it matters; do not narrate the diff line by line.',
    'Call write_summary exactly once and then stop. Do not reply in plain text instead.',
    EXTERNAL_CONTENT_BLOCK,
  ].join('\n')
}

export interface SummaryOptions {
  readonly provider: LLMProvider
  readonly model: string
  readonly context: ReviewContext
  readonly threadId: string
  readonly turnId: string
  readonly signal?: AbortSignal | undefined
  readonly onEvent?: ((event: HeadlessEvent) => void) | undefined
}

export interface SummaryResult {
  readonly summary: PrSummary | null
  readonly turn: TurnResult
}

/** One tool-free turn over the Stage 1 context that ends in `write_summary`. */
export async function writeSummary(options: SummaryOptions): Promise<SummaryResult> {
  let recorded: PrSummary | null = null
  let rejection: string | null = null
  const tools = [writeSummaryTool()]
  const turn = await runTurn({
    provider: options.provider,
    model: options.model,
    systemPrompt: summarySystemPrompt(),
    userPrompt: renderReviewContext(options.context),
    tools,
    execute: (name, args) => {
      if (name !== 'write_summary') return Promise.reject(new Error(`Unknown tool ${name}`))
      if (recorded !== null) {
        return Promise.reject(new Error('The summary is already recorded; stop now'))
      }
      const parsed = summarySchema.safeParse(args)
      if (!parsed.success) {
        rejection = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ')
        return Promise.reject(new Error(`write_summary is invalid: ${rejection}`))
      }
      recorded = parsed.data
      return Promise.resolve('Recorded.')
    },
    threadId: options.threadId,
    turnId: options.turnId,
    maxSteps: 3,
    completionError: () =>
      recorded === null
        ? `the summary ended without a valid write_summary call${rejection === null ? '' : ` (last rejection: ${rejection})`}`
        : undefined,
    completionRepair: {
      tools,
      toolChoice: { name: 'write_summary' },
      maxSteps: 2,
      prompt: (_summary, error) =>
        `Protocol correction: ${error}. Call write_summary exactly once now and emit no plain text.`,
    },
    signal: options.signal,
    onEvent: options.onEvent,
  })
  return { summary: recorded, turn }
}

/**
 * Raise the model's risk level to what the review's evidence shows. A
 * surfaced high or critical finding makes it High; any surfaced finding makes
 * a Low at least Medium. The evidence never lowers it.
 */
export function applyEvidenceFloor(summary: PrSummary, report: ReviewReport | null): PrSummary {
  if (report === null || report.findings.length === 0) return summary
  const severe = report.findings.filter(
    (finding) => finding.severity === 'high' || finding.severity === 'critical',
  ).length
  if (severe > 0 && summary.risk !== 'high') {
    return {
      ...summary,
      risk: 'high',
      raisedBecause: `the review surfaced ${String(severe)} high-severity ${severe === 1 ? 'issue' : 'issues'}`,
    }
  }
  if (summary.risk === 'low') {
    const count = report.findings.length
    return {
      ...summary,
      risk: 'medium',
      raisedBecause: `the review surfaced ${String(count)} ${count === 1 ? 'issue' : 'issues'}`,
    }
  }
  return summary
}

/** One line of model prose, inert, inside a blockquote. */
function quotedLine(text: string): string {
  return inertMarkdown(text.replace(/\s+/g, ' ').trim())
}

const RISK_LABEL: Record<SummaryRisk, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
}

export interface SummaryBlockOptions {
  readonly headCommit: string | null
  readonly toolVersion: string
  /** The review this summary accompanies; null when only the summary ran. */
  readonly report: ReviewReport | null
}

/** The marked block, ready to append to a pull request description. */
export function renderSummaryBlock(summary: PrSummary, options: SummaryBlockOptions): string {
  const lines = [START_MARKER, '---', '', '> [!NOTE]', `> **${RISK_LABEL[summary.risk]}**`]
  lines.push(`> ${quotedLine(summary.riskReason)}`)
  if (summary.raisedBecause !== undefined) {
    lines.push('>', `> Raised to ${RISK_LABEL[summary.risk]} because ${summary.raisedBecause}.`)
  }
  lines.push('>', '> **Overview**')
  for (const point of summary.overview) {
    lines.push(`> - ${quotedLine(point.replace(/^\s*[-*•]\s+/, ''))}`)
  }
  const footer = [
    `Summary by Copse Reviewer${options.headCommit === null ? '' : ` for commit ${options.headCommit.slice(0, 12)}`}.`,
  ]
  if (options.report !== null) {
    const count = options.report.findings.length
    footer.push(
      count === 0
        ? 'The review reported no issues.'
        : `The review reported ${String(count)} ${count === 1 ? 'issue' : 'issues'}.`,
    )
  }
  footer.push(`copse-review ${options.toolVersion}`)
  lines.push('>', `> <sup>${footer.join(' ')}</sup>`)
  lines.push(digestLine(lines.slice(1).map(bareLine)), END_MARKER)
  return lines.join('\n')
}

/**
 * A hidden line stamping the rendered text between the start marker and itself.
 * An author's edit to any of that text, even one that keeps the layout, changes
 * the digest, so the block becomes theirs.
 */
function digestLine(body: readonly string[]): string {
  const digest = createHash('sha256').update(body.join('\n')).digest('hex').slice(0, 16)
  return `<!-- copse-review-summary-digest:${digest} -->`
}

/** A line without the carriage return and trailing blanks a web editor leaves. */
function bareLine(line: string): string {
  return line.replace(/[ \t\r]+$/, '')
}

/** An opening code fence: its character, its length and the line it starts on. */
interface OpenFence {
  readonly char: string
  readonly length: number
  readonly from: number
}

/**
 * The lines inside closed fenced code blocks, and the fence still open at the
 * end of the description, if any.
 */
function scanFences(lines: readonly string[]): {
  readonly fenced: ReadonlySet<number>
  readonly open: OpenFence | null
} {
  const fenced = new Set<number>()
  let open: OpenFence | null = null
  for (const [index, line] of lines.entries()) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(bareLine(line))
    if (open === null) {
      if (fence === null) continue
      const [, run = '', info = ''] = fence
      if (run.startsWith('`') && info.includes('`')) continue
      open = { char: run.charAt(0), length: run.length, from: index }
      continue
    }
    const run = fence?.[1] ?? ''
    if (fence?.[2]?.trim() === '' && run.charAt(0) === open.char && run.length >= open.length) {
      for (let inside = open.from; inside <= index; inside += 1) fenced.add(inside)
      open = null
    }
  }
  return { fenced, open }
}

/**
 * Indices of the lines inside a closed fenced code block. An unclosed fence
 * runs to the end of the description in rendered Markdown, but it is ignored
 * here: `upsertSummaryBlock` closes it before appending, so the block it writes
 * is always outside.
 */
function fencedLines(lines: readonly string[]): ReadonlySet<number> {
  return scanFences(lines).fenced
}

/**
 * Whether lines `start`..`end` are, line for line, the shape
 * `renderSummaryBlock` writes, with the text its digest line stamped. Anything
 * else between the markers, such as a note the author added or a sentence they
 * reworded, makes the block theirs.
 */
function isBotBlock(lines: readonly string[], start: number, end: number): boolean {
  const inner = lines.slice(start + 1, end).map(bareLine)
  const stamp = inner.pop()
  if (stamp !== digestLine(inner)) return false
  const expect = (at: number, line: RegExp): boolean => line.test(inner[at] ?? '')
  if (!expect(0, /^---$/) || !expect(1, /^$/) || !expect(2, /^> \[!NOTE\]$/)) return false
  if (!expect(3, /^> \*\*(Low|Medium|High) risk\*\*$/) || !expect(4, /^> \S/)) return false
  let at = 5
  if (expect(at, /^>$/) && expect(at + 1, /^> Raised to /)) at += 2
  if (!expect(at, /^>$/) || !expect(at + 1, /^> \*\*Overview\*\*$/)) return false
  at += 2
  const firstPoint = at
  while (expect(at, /^> - \S/)) at += 1
  return (
    at > firstPoint &&
    expect(at, /^>$/) &&
    expect(at + 1, /^> <sup>Summary by Copse Reviewer\b.*<\/sup>$/) &&
    at + 2 === inner.length
  )
}

/**
 * The line range of the summary block this tool wrote, or null. Markers count
 * only as whole lines outside fenced code, so a marker quoted in prose or in
 * an example is text. The block is the last start marker whose next marker is
 * an end marker and whose lines between are still exactly the rendered shape.
 * A marker pair the author wrote, or a block the author edited, is their text
 * and is kept; a new block is appended after it.
 */
function findBotBlock(
  lines: readonly string[],
): { readonly start: number; readonly end: number } | null {
  const fenced = fencedLines(lines)
  const markers: { readonly index: number; readonly start: boolean }[] = []
  for (const [index, line] of lines.entries()) {
    if (fenced.has(index)) continue
    const bare = bareLine(line)
    if (bare === START_MARKER) markers.push({ index, start: true })
    else if (bare === END_MARKER) markers.push({ index, start: false })
  }
  for (let at = markers.length - 1; at > 0; at -= 1) {
    const open = markers[at - 1]
    const close = markers[at]
    if (open === undefined || close === undefined || !open.start || close.start) continue
    if (isBotBlock(lines, open.index, close.index)) return { start: open.index, end: close.index }
  }
  return null
}

/**
 * `body` with its summary block replaced by `block`, or `block` appended when
 * there was none. Only a block this tool wrote is removed (see `findBotBlock`);
 * every other character of the description is kept, and the new block always
 * goes at the bottom. A fence left open at the end is closed first, or the
 * block would render as code.
 */
export function upsertSummaryBlock(body: string | null, block: string): string {
  const lines = (body ?? '').split('\n')
  const found = findBotBlock(lines)
  let kept = (body ?? '').trimEnd()
  if (found !== null) {
    const before = lines.slice(0, found.start).join('\n').trimEnd()
    const after = lines
      .slice(found.end + 1)
      .join('\n')
      .replace(/^\s*\n/, '')
      .trimEnd()
    kept = before.length === 0 || after.length === 0 ? before + after : `${before}\n\n${after}`
  }
  if (kept.length === 0) return block
  // A description that ends inside an open fence would swallow the block as
  // code, so close the fence first. The closing line then belongs to the
  // author's text and the fence stays closed on later runs.
  const { open } = scanFences(kept.split('\n'))
  const close = open === null ? '' : `\n${open.char.repeat(open.length)}`
  return `${kept}${close}\n\n${block}`
}

/** The lines of the summary block this tool wrote into `body`, or none. */
function botBlockLines(body: string | null): readonly string[] {
  const lines = (body ?? '').split('\n')
  const found = findBotBlock(lines)
  return found === null ? [] : lines.slice(found.start, found.end + 1)
}

/**
 * The 12-character commit a block's footer names when a full review wrote it,
 * or null for a summary-only block. Model prose is inert, so no line it wrote
 * can pass for the footer.
 */
function reviewedCommit(block: readonly string[]): string | null {
  for (const line of block) {
    const footer =
      /^> <sup>Summary by Copse Reviewer for commit ([0-9a-f]{12})\. The review reported /.exec(
        bareLine(line),
      )
    if (footer !== null) return footer[1] ?? null
  }
  return null
}

const pullSchema = z.object({
  body: z.string().nullable(),
  head: z.object({ sha: z.string() }),
})

export type PostedSummary =
  | { readonly updated: true }
  | { readonly updated: false; readonly reason: string }

/**
 * Read the description, replace the block, write it back. A pull request that
 * has moved past `target.headCommit` is left alone: a newer push has its own
 * summary on the way, and an older one must not overwrite it. The forge has
 * no conditional update for a description, so an author's edit landing
 * between the read and the write is lost; the window is one round trip.
 *
 * A summary-only block never replaces one a full review wrote for the same
 * commit: the push-time summary can finish after the review, and must not
 * throw its evidence away. Two runs writing within the same round trip can
 * still race; the later write wins.
 */
export async function postSummary(
  target: ForgeTarget,
  block: string,
  options: { readonly fetch?: FetchLike } = {},
): Promise<PostedSummary> {
  const fetchImpl: FetchLike = options.fetch ?? fetch
  const url = pullRequestUrl(target)
  const request = async (method: string, body?: unknown): Promise<string> => {
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: forgeHeaders(target),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (err) {
      throw new ForgeReviewError(0, `could not reach ${url}: ${errorMessage(err)}`)
    }
    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      throw new ForgeReviewError(
        response.status,
        `${target.forge} returned ${String(response.status)} for ${method} ${url}: ${text.slice(0, ERROR_EXCERPT_CHARS)}`,
      )
    }
    return text
  }
  const pull = safeJsonParse(await request('GET'), decodeWithSchema(pullSchema))
  if (pull === null) throw new Error(`${target.forge} returned an unreadable pull request`)
  if (target.headCommit !== null && pull.head.sha !== target.headCommit) {
    return {
      updated: false,
      reason: `the pull request has moved on to ${pull.head.sha.slice(0, 12)}`,
    }
  }
  if (
    target.headCommit !== null &&
    !reviewedCommit(block.split('\n')) &&
    reviewedCommit(botBlockLines(pull.body)) === target.headCommit.slice(0, 12)
  ) {
    return { updated: false, reason: 'a full review has already summarised this commit' }
  }
  const next = upsertSummaryBlock(pull.body, block)
  if (next === pull.body) return { updated: false, reason: 'the summary is unchanged' }
  await request('PATCH', { body: next })
  return { updated: true }
}
