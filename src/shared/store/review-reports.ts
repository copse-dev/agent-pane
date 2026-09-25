// Copse Reviewer runs the user started, handed to the model (#2519).
//
// Reports sit in the transcript on the assistant message of the turn they
// reviewed (or, before any assistant turn, in the thread-level slot). A review
// the *user* ran (the Review button or the "Review changes" bubble) is also
// handed to the model with the next prompt, as a compact summary and findings
// list, so the model can act on what the user just saw. The model's own
// `review_changes` call needs none of this: it already reads the report as that
// tool's result.
import type { ReviewFindingRecord, Thread, ThreadReviewReport, UserContent } from '@shared/types'

/** Reports summarised for the model in one prompt; older ones are only counted. */
const MAX_CONTEXT_REPORTS = 3
/** Findings listed per report in the model's summary; the rest are counted. */
const MAX_CONTEXT_FINDINGS = 12
/** A finding's claim is one sentence; cap a runaway one in the model's summary. */
const MAX_CONTEXT_CLAIM_CHARS = 400
/**
 * Delimits the summary inside the prompt it rides on. Deliberately not a
 * `<system-reminder>`: this is a record of the user's own action, carried in
 * their message and kept in history, not a turn-local operator instruction
 * (hooks-and-feature-packs decision 22).
 */
const REVIEW_CONTEXT_TAG = 'copse_review_report'

/** `src/math.ts:12` / `src/math.ts:12–15` / `src/math.ts`. */
function findingLocation(finding: ReviewFindingRecord): string {
  if (finding.startLine === undefined) return finding.path
  const end = finding.endLine !== undefined && finding.endLine !== finding.startLine
  return `${finding.path}:${String(finding.startLine)}${end ? `–${String(finding.endLine)}` : ''}`
}

/** A completed run the user started: the only kind handed to the model. */
function userRunDone(report: ThreadReviewReport | undefined): ThreadReviewReport | null {
  return report?.initiator === 'user' && report.status === 'done' ? report : null
}

/**
 * Completed reviews the user ran that the model has not replied after, oldest
 * first. Only the latest assistant message's report can qualify — any earlier
 * one already has a reply after it — and a thread-level report (a run started
 * before any assistant turn) qualifies while no assistant message is newer than
 * its run. Each is handed over once, with the next prompt, because that
 * prompt's reply lands after it. Reports from before `initiator` was recorded
 * are never handed over.
 */
export function reviewReportsAwaitingModel(
  thread: Pick<Thread, 'messages' | 'reviewReport'>,
): ThreadReviewReport[] {
  const awaiting: ThreadReviewReport[] = []
  const legacy = userRunDone(thread.reviewReport)
  if (
    legacy &&
    !thread.messages.some(
      (message) => message.role === 'assistant' && message.createdAt > legacy.startedAt,
    )
  ) {
    awaiting.push(legacy)
  }
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i]
    if (message?.role !== 'assistant') continue
    const anchored = userRunDone(message.reviewReport)
    if (anchored) awaiting.push(anchored)
    break
  }
  return awaiting
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function reviewedLine(report: ThreadReviewReport): string {
  const parts = ['Copse Reviewer']
  if (report.baseRef !== '') {
    const head = report.dirtyWorkingTree
      ? 'the working tree'
      : `HEAD${report.headCommit !== null ? ` (${report.headCommit.slice(0, 10)})` : ''}`
    parts.push(`reviewed ${head} against ${report.baseRef}`)
  }
  if (report.models.reviewer !== '') parts.push(`with ${report.models.reviewer}`)
  return `${parts.join(' ')}.`
}

function groundLine(report: ThreadReviewReport): string | null {
  if (!report.execution.executed) {
    return report.execution.reason === ''
      ? 'Read-only review: nothing was executed.'
      : `Read-only review: nothing was executed (${report.execution.reason}).`
  }
  const checks = report.checks.map((check) => `${check.kind} ${check.verdict}`)
  const notChecked = report.notChecked.map((note) => `not checked: ${note}`)
  const all = [...checks, ...notChecked]
  return all.length === 0 ? null : `Checks: ${all.join('; ')}.`
}

function findingLine(finding: ReviewFindingRecord, index: number): string {
  return (
    `${String(index + 1)}. [${finding.severity} · ${finding.class} · ${finding.verdict.status}] ` +
    `${findingLocation(finding)} — ${clip(finding.claim, MAX_CONTEXT_CLAIM_CHARS)}`
  )
}

/** One report as the model reads it: what was reviewed, the ground, the live findings. */
function reportContextText(report: ThreadReviewReport): string {
  const lines = [reviewedLine(report)]
  const ground = groundLine(report)
  if (ground !== null) lines.push(ground)
  if (report.note !== undefined) lines.push(report.note)
  const live = report.findings.filter((finding) => finding.dismissed !== true)
  const dismissed = report.findings.length - live.length
  const dismissedNote =
    dismissed > 0 ? ` (${String(dismissed)} more dismissed by the user and left out)` : ''
  if (live.length === 0) {
    lines.push(report.findings.length === 0 ? 'No findings.' : `No open findings${dismissedNote}.`)
  } else {
    lines.push(`${String(live.length)} finding(s)${dismissedNote}:`)
    live.slice(0, MAX_CONTEXT_FINDINGS).forEach((finding, index) => {
      lines.push(findingLine(finding, index))
    })
    if (live.length > MAX_CONTEXT_FINDINGS) {
      lines.push(`…and ${String(live.length - MAX_CONTEXT_FINDINGS)} more on the card.`)
    }
  }
  if (report.appendix > 0) {
    lines.push(`${String(report.appendix)} lower-ranked finding(s) fell below the report's cut.`)
  }
  return lines.join('\n')
}

/**
 * The compact, model-facing summary of reviews the user ran since the model's
 * last reply, or `undefined` when there are none. Summary and findings only —
 * never the raw report — so it stays small in the thread's history.
 */
export function reviewReportModelContext(
  reports: readonly ThreadReviewReport[],
): string | undefined {
  if (reports.length === 0) return undefined
  const shown = reports.slice(-MAX_CONTEXT_REPORTS)
  const omitted = reports.length - shown.length
  const intro =
    reports.length === 1
      ? 'Since your last reply the user ran Copse Reviewer on this thread’s changes. ' +
        'You did not start this review; the user sees its report as a card in the conversation.'
      : `Since your last reply the user ran Copse Reviewer ${String(reports.length)} times on ` +
        'this thread’s changes, oldest first. You did not start these reviews; the user sees ' +
        'each report as a card in the conversation.' +
        (omitted > 0 ? ` Only the latest ${String(shown.length)} are summarised here.` : '')
  const body = [intro, ...shown.map(reportContextText)].join('\n\n')
  return `<${REVIEW_CONTEXT_TAG}>\n${body}\n</${REVIEW_CONTEXT_TAG}>`
}

/**
 * Lead a prompt with the review summary it carries (main, as the turn is
 * composed). Image prompts keep their images; the summary becomes their first
 * text part.
 */
export function withReviewContext(
  prompt: UserContent,
  reviewContext: string | undefined,
): UserContent {
  if (reviewContext === undefined) return prompt
  if (typeof prompt === 'string') return `${reviewContext}\n\n${prompt}`
  return [{ type: 'text', text: reviewContext }, ...prompt]
}
