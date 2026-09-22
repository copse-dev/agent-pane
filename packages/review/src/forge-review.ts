// The pull-request projection of a review (docs/plans/copse-reviewer.md,
// §Packaging, "Shell C — CI"): one review on the PR, each anchored finding an
// inline comment at its line on the head commit, everything else — the ground,
// what was not checked, findings with no line, the appendix count — in the
// review's body. Advisory, never a required check, never a request for
// changes: the event is always `COMMENT`.
//
// Two forges, one shape. GitHub anchors a comment by `line` + `side`; Forgejo
// (and Gitea) by `new_position`. Both refuse a line the pull request's diff
// does not contain, so an inline comment that is rejected is folded into the
// body rather than lost: a finding at a line the diff never touched (Stage 0's
// anchor at the script in `package.json`, say) still reaches the reader.
import { errorMessage } from '@copse/std/errors.ts'
import { memberOf } from '@copse/std/member-of.ts'
import type { Finding } from './finding.ts'
import type { ReviewReport } from './stage5.ts'

export const FORGES = ['github', 'forgejo'] as const
export type Forge = (typeof FORGES)[number]
export const isForge = memberOf(FORGES)

export interface ForgeReviewComment {
  readonly path: string
  readonly line: number
  readonly body: string
}

export interface ForgeReview {
  readonly body: string
  readonly comments: readonly ForgeReviewComment[]
}

export interface ForgeReviewOptions {
  /** The commit the comments anchor to; findings without one go in the body. */
  readonly headCommit: string | null
  readonly toolVersion: string
}

function where(finding: Finding): string {
  return finding.anchor.startLine === undefined
    ? finding.anchor.path
    : `${finding.anchor.path}:${String(finding.anchor.startLine)}`
}

function evidenceLines(finding: Finding): string[] {
  return finding.evidence.map((evidence) => {
    switch (evidence.kind) {
      case 'command':
        return `- \`${evidence.command}\` on ${evidence.target}: exit ${evidence.exitCode === null ? 'killed' : String(evidence.exitCode)}`
      case 'reproducer':
        return `- reproducer \`${evidence.testPath}\`: ${evidence.failsOnHead ? 'fails' : 'passes'} on head, ${evidence.passesOnBase ? 'passes' : 'fails'} on base`
      case 'citation':
        return `- \`${evidence.path}:${String(evidence.startLine)}–${String(evidence.endLine)}\``
    }
  })
}

function provenance(finding: Finding): string {
  const raised = finding.provenance.raisedBy
    .map((ref) =>
      ref.kind === 'stage0' ? 'stage 0' : `${ref.id}${ref.lens ? ` (${ref.lens})` : ''}`,
    )
    .join(', ')
  const parts = [`raised by ${raised}`]
  if (finding.provenance.corroboratedBy.length > 0) {
    parts.push(
      `corroborated by ${finding.provenance.corroboratedBy.map((ref) => ref.id).join(', ')}`,
    )
  }
  if (finding.provenance.challengedBy.length > 0) {
    parts.push(
      `survived challenge by ${finding.provenance.challengedBy.map((ref) => ref.id).join(', ')}`,
    )
  }
  return parts.join('; ')
}

/** One finding as a comment body, the same whether inline or in the review body. */
export function renderFindingComment(finding: Finding): string {
  const lines = [
    `**[${finding.class} · ${finding.severity} · ${finding.confidence}] ${finding.claim}**`,
    '',
    `${finding.verdict.status}: ${finding.verdict.reason}`,
  ]
  const evidence = evidenceLines(finding)
  if (evidence.length > 0) lines.push('', ...evidence)
  lines.push('', `<sub>${provenance(finding)} · id \`${finding.id}\`</sub>`)
  return lines.join('\n')
}

const MARK: Record<ReviewReport['stage0']['checks'][number]['verdict'], string> = {
  clean: '✓',
  fixed: '✓ (was failing on base)',
  regressed: '✗ regressed',
  'failing-on-base': '✗ (already failing on base)',
  undetermined: '?',
  'not-run': '–',
}

function bodyHeader(report: ReviewReport, options: ForgeReviewOptions): string[] {
  const { stage0 } = report
  const lines = [`### Copse Reviewer`]
  const executed = stage0.execution.decision.execute
  lines.push(
    executed
      ? `Executed in the \`${stage0.execution.backend}\` backend (${stage0.execution.strength}).`
      : `Read-only review — nothing was executed: ${stage0.execution.decision.reason}.`,
  )
  if (stage0.checks.length > 0) {
    lines.push(
      `Checks: ${stage0.checks.map((check) => `${check.kind} ${MARK[check.verdict]}`).join(', ')}.`,
    )
  }
  for (const note of stage0.coverage.notChecked) {
    lines.push(`Not checked: ${note.kind === 'all' ? '' : `${note.kind} — `}${note.reason}.`)
  }
  if (report.verification !== null) {
    const { counts } = report.verification
    lines.push(
      `Verification: ${String(counts.attempted)} attempted — ${String(counts.confirmed)} confirmed by reproducer, ${String(counts.refuted)} refuted, ${String(counts.survived)} survived challenge, ${String(counts.undetermined)} undetermined.`,
    )
  }
  const models = [...new Set(report.reviews.map((review) => review.model))]
  if (models.length > 0) lines.push(`Reviewers: ${models.join(', ')}.`)
  const incomplete = report.reviews.filter((review) => review.outcome !== 'completed')
  if (incomplete.length > 0) {
    lines.push(
      `Review incomplete: ${String(incomplete.length)} of ${String(report.reviews.length)} reviewer run(s) did not complete; this is not a clean result.`,
    )
    for (const review of incomplete) {
      const reason =
        review.error?.replace(/\s+/g, ' ') ?? `${review.outcome} (${review.stopReason})`
      lines.push(`Incomplete reviewer: ${review.model} (${review.lens}) — ${reason}.`)
    }
  }
  if (options.headCommit !== null) lines.push(`Head: \`${options.headCommit.slice(0, 12)}\`.`)
  return lines
}

/**
 * The review for a report: inline comments for the surfaced findings that
 * have a line, the rest in the body. `fold` moves named inline comments into
 * the body instead — the retry after a forge refused them.
 */
export function buildForgeReview(
  report: ReviewReport,
  options: ForgeReviewOptions,
  fold: ReadonlySet<number> = new Set(),
): ForgeReview {
  const comments: ForgeReviewComment[] = []
  const inBody: Finding[] = []
  report.findings.forEach((finding, index) => {
    if (finding.anchor.startLine === undefined || fold.has(index)) {
      inBody.push(finding)
      return
    }
    comments.push({
      path: finding.anchor.path,
      line: finding.anchor.endLine ?? finding.anchor.startLine,
      body: renderFindingComment(finding),
    })
  })
  const lines = bodyHeader(report, options)
  lines.push('')
  if (report.findings.length === 0) {
    const incomplete = report.reviews.some((review) => review.outcome !== 'completed')
    lines.push(
      report.reviews.length === 0
        ? 'No findings from Stage 0.'
        : incomplete
          ? 'No findings were produced before the incomplete review stopped.'
          : 'No findings.',
    )
  } else {
    lines.push(
      `${String(report.findings.length)} finding(s)${comments.length > 0 ? `, ${String(comments.length)} as inline comments` : ''}.`,
    )
    for (const finding of inBody) {
      lines.push('', `#### ${where(finding)}`, '', renderFindingComment(finding))
    }
  }
  if (report.appendix.length > 0) {
    lines.push('', `${String(report.appendix.length)} more below the cap, in the review's JSON.`)
  }
  if (report.refuted.length > 0) {
    lines.push(`${String(report.refuted.length)} refuted by verification and dropped.`)
  }
  lines.push(
    '',
    `<sub>Advisory, not a gate. copse-review ${options.toolVersion}${options.headCommit === null ? '' : ` · <!-- copse-review:${options.headCommit} -->`}</sub>`,
  )
  return { body: lines.join('\n'), comments }
}

export interface ForgeTarget {
  readonly forge: Forge
  /** `https://api.github.com`, or a Forgejo instance's origin (`https://code.example.org`). */
  readonly apiBase: string
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly token: string
  /** The commit the review is on. */
  readonly headCommit: string | null
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>

function reviewsUrl(target: ForgeTarget): string {
  const base = target.apiBase.replace(/\/+$/, '')
  const path = `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${String(target.number)}/reviews`
  return target.forge === 'github' ? `${base}/${path}` : `${base}/api/v1/${path}`
}

function reviewPayload(target: ForgeTarget, review: ForgeReview): Record<string, unknown> {
  const common = {
    event: 'COMMENT',
    body: review.body,
    ...(target.headCommit === null ? {} : { commit_id: target.headCommit }),
  }
  if (target.forge === 'github') {
    return {
      ...common,
      comments: review.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: 'RIGHT',
        body: comment.body,
      })),
    }
  }
  return {
    ...common,
    comments: review.comments.map((comment) => ({
      path: comment.path,
      new_position: comment.line,
      body: comment.body,
    })),
  }
}

function headers(target: ForgeTarget): Record<string, string> {
  return target.forge === 'github'
    ? {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${target.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      }
    : {
        Accept: 'application/json',
        Authorization: `token ${target.token}`,
        'Content-Type': 'application/json',
      }
}

export interface PostedReview {
  readonly inline: number
  /** Findings folded into the body because the forge refused their line. */
  readonly folded: number
}

const ERROR_EXCERPT_CHARS = 512

/**
 * Post the review. A 422 — the forge could not place one of the inline
 * comments — is retried once with every inline comment folded into the body;
 * any other failure is an error carrying the status and the response's head.
 */
export async function postForgeReview(
  target: ForgeTarget,
  report: ReviewReport,
  options: { readonly toolVersion: string; readonly fetch?: FetchLike },
): Promise<PostedReview> {
  const fetchImpl: FetchLike = options.fetch ?? fetch
  const url = reviewsUrl(target)
  const attempt = async (review: ForgeReview): Promise<number> => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: headers(target),
        body: JSON.stringify(reviewPayload(target, review)),
      })
      if (response.status >= 200 && response.status < 300) return response.status
      const text = (await response.text()).slice(0, ERROR_EXCERPT_CHARS)
      throw new ForgeReviewError(
        response.status,
        `${target.forge} returned ${String(response.status)} for ${url}: ${text}`,
      )
    } catch (err) {
      if (err instanceof ForgeReviewError) throw err
      throw new ForgeReviewError(0, `could not reach ${url}: ${errorMessage(err)}`)
    }
  }
  const reviewOptions = { headCommit: target.headCommit, toolVersion: options.toolVersion }
  const inline = buildForgeReview(report, reviewOptions)
  try {
    await attempt(inline)
    return { inline: inline.comments.length, folded: 0 }
  } catch (err) {
    if (!(err instanceof ForgeReviewError) || err.status !== 422 || inline.comments.length === 0) {
      throw err
    }
  }
  const everything = new Set(report.findings.map((_finding, index) => index))
  await attempt(buildForgeReview(report, reviewOptions, everything))
  return { inline: 0, folded: inline.comments.length }
}

export class ForgeReviewError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ForgeReviewError'
    this.status = status
  }
}
