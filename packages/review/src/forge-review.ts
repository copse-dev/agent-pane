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
import { z } from 'zod'
import { errorMessage } from '@copse/std/errors.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { memberOf } from '@copse/std/member-of.ts'
import type { Finding } from './finding.ts'
import {
  CLAIM_CONTAINMENT_THRESHOLD,
  CLAIM_SIMILARITY_THRESHOLD,
  claimContainment,
  claimSimilarity,
} from './cluster.ts'
import { reviewerLimitations, type ReviewReport } from './stage5.ts'

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
  /** Full, commit-pinned diffs. An absent path has no place for an inline comment. */
  readonly fileDiffs?: ReadonlyMap<string, string>
  /** Findings left out because another open pull request already carries them. */
  readonly repeatedElsewhere?: readonly { readonly pr: number; readonly url: string }[]
}

/** Choose a visible head-side line within the finding's own range, never a nearby line. */
function inlineLine(finding: Finding, options: ForgeReviewOptions): number | undefined {
  const start = finding.anchor.startLine
  if (options.headCommit === null || start === undefined) return undefined
  const end = finding.anchor.endLine ?? start
  if (options.fileDiffs === undefined) return end
  let next = 0
  let remaining = 0
  let chosen: number | undefined
  for (const line of (options.fileDiffs.get(finding.anchor.path) ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      remaining = Number(hunk[2] ?? 1)
    } else if (remaining > 0 && (line.startsWith('+') || line.startsWith(' '))) {
      if (next >= start && next <= end) chosen = next
      next++
      remaining--
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      remaining = 0
    }
  }
  return chosen
}

function where(finding: Finding): string {
  return finding.anchor.startLine === undefined
    ? finding.anchor.path
    : `${finding.anchor.path}:${String(finding.anchor.startLine)}`
}

/**
 * Model- or report-derived prose as inert markdown. Hostile diff content can
 * steer what a model writes, and the review posts under the App's identity:
 * outside code spans, `<` and `>` are escaped (no raw HTML, so an unterminated `<!--`
 * cannot hide the rest of the review) and an `@` that would mention a user or
 * team gets a zero-width space. Code spans are kept as written — neither
 * renders inside one.
 */
function inertMarkdown(text: string): string {
  const inert = (prose: string): string =>
    prose
      .replaceAll('\\', '\\\\')
      .replaceAll('`', '\\`')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replace(/@(?=[A-Za-z0-9])/g, '@\u200b')
  // Preserve only self-contained, single-line code spans. Blank paragraphs
  // and block syntax end CommonMark inline parsing; a regex spanning them can
  // mistake raw HTML for code. Escape every other backtick/backslash so an
  // unmatched delimiter cannot form a new span or fence with surrounding text.
  const span = /(?<![\\`])(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)/g
  let out = ''
  let last = 0
  for (const match of text.matchAll(span)) {
    out += inert(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return out + inert(text.slice(last))
}

/** `text` as one inline code span, whatever backticks or newlines it holds. */
function codeSpan(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ')
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

function evidenceLines(finding: Finding): string[] {
  return finding.evidence.map((evidence) => {
    switch (evidence.kind) {
      case 'command':
        return `- ${codeSpan(evidence.command)} on ${evidence.target}: exit ${evidence.exitCode === null ? 'killed' : String(evidence.exitCode)}`
      case 'reproducer':
        return `- reproducer ${codeSpan(evidence.testPath)}: ${evidence.failsOnHead ? 'fails' : 'passes'} on head, ${evidence.passesOnBase ? 'passes' : 'fails'} on base`
      case 'citation':
        return `- ${codeSpan(`${evidence.path}:${String(evidence.startLine)}–${String(evidence.endLine)}`)}`
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

/** Keep quoted content from closing the surrounding disclosure. */
function details(title: string, content: string): string {
  const safe = content.replace(/<\/?(?:details|summary)\b[^>]*>/gi, (tag) =>
    tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  )
  return `<details>\n<summary>${title}</summary>\n\n${safe}\n\n</details>`
}

/** One finding as a comment body, the same whether inline or in the review body. */
export function renderFindingComment(finding: Finding): string {
  const status =
    finding.verdict.status === 'confirmed'
      ? 'Confirmed by an automated check.'
      : finding.verdict.status === 'refuted'
        ? 'Dismissed after further checking.'
        : 'Possible issue — not confirmed by a test.'
  return [
    `**${inertMarkdown(finding.claim)}**`,
    '',
    `${finding.severity.charAt(0).toUpperCase()}${finding.severity.slice(1)} priority. ${status}`,
    '',
    details(
      'Why this was flagged',
      [
        inertMarkdown(finding.verdict.reason),
        '',
        ...evidenceLines(finding),
        '',
        `Category: ${finding.class}. Model confidence: ${finding.confidence}.`,
        `${provenance(finding)} · id \`${finding.id}\``,
      ].join('\n'),
    ),
  ].join('\n')
}

const MARK: Record<ReviewReport['stage0']['checks'][number]['verdict'], string> = {
  clean: '✓',
  fixed: '✓ (was failing on base)',
  regressed: '✗ regressed',
  'failing-on-base': '✗ (already failing on base)',
  undetermined: '?',
  'not-run': '–',
}

function reviewDetails(report: ReviewReport, options: ForgeReviewOptions): string[] {
  const { stage0 } = report
  const lines: string[] = []
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
    lines.push(
      `Not checked: ${note.kind === 'all' ? '' : `${note.kind} — `}${inertMarkdown(note.reason)}.`,
    )
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
      lines.push(
        `Incomplete reviewer: ${review.model} (${review.lens}) — ${inertMarkdown(reason)}.`,
      )
    }
  }
  const limitations = reviewerLimitations(report.reviews)
  if (limitations.length > 0) {
    lines.push(
      `Review limits: ${String(limitations.length)} completed reviewer run(s) left material uncertainty.`,
    )
    for (const limitation of limitations) {
      lines.push(
        `Could not verify (${limitation.model}, ${limitation.lens}): ${inertMarkdown(limitation.detail)}`,
      )
    }
  }
  if (options.headCommit !== null) lines.push(`Head: \`${options.headCommit.slice(0, 12)}\`.`)
  const hosts = new Set([
    ...report.reviews.flatMap((review) => review.hostingProviders ?? []),
    ...(report.verification?.records ?? []).flatMap((record) => record.hostingProviders ?? []),
  ])
  lines.push(
    hosts.size
      ? `Hosting providers reported by responses: ${[...hosts].sort().join(', ')}.`
      : 'Hosting provider: not reported by the service.',
  )
  const timings = [
    ...report.reviews.map((review) => ({ label: 'Find issues', timing: review.timing })),
    ...(report.verification?.records ?? []).map((record) => ({
      label: record.strategy === 'reproducer' ? 'Try a test' : 'Check the claim',
      timing: record.timing,
    })),
  ].filter((entry) => entry.timing !== undefined)
  if (timings.length > 0) {
    const seconds = (ms: number): string => `${(ms / 1_000).toFixed(1)}s`
    lines.push('', '| Task | Total | Tools | Model and waiting |', '| --- | ---: | ---: | ---: |')
    for (const { label, timing } of timings) {
      if (timing)
        lines.push(
          `| ${label} | ${seconds(timing.durationMs)} | ${seconds(timing.toolMs)} | ${seconds(timing.modelAndOverheadMs)} |`,
        )
    }
    lines.push(
      '',
      'Passes may overlap; their totals should not be added. Tools includes waiting for the shared execution lane. Model and waiting includes API retries and orchestration, not just inference.',
    )
  }
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
  const inBody: { finding: Finding; number: number }[] = []
  report.findings.forEach((finding, index) => {
    const line = inlineLine(finding, options)
    if (line === undefined || fold.has(index)) {
      inBody.push({ finding, number: index + 1 })
      return
    }
    comments.push({
      path: finding.anchor.path,
      line,
      body: renderFindingComment(finding),
    })
  })
  const lines = ['### Copse Reviewer']
  const limitations = reviewerLimitations(report.reviews)
  const incomplete = report.reviews.some((review) => review.outcome !== 'completed')
  lines.push('')
  if (incomplete) lines.push('**Review stopped early. These results may be incomplete.**', '')
  if (limitations.length > 0 || report.stage0.coverage.notChecked.length > 0)
    lines.push('Some checks remain unverified. See review details below.', '')
  if (report.findings.length === 0) {
    lines.push(
      report.reviews.length === 0
        ? 'No issues found by the automated checks.'
        : incomplete
          ? 'No issues were reported before the review stopped.'
          : limitations.length > 0
            ? 'No issues were reported, but the review has gaps.'
            : 'No issues found.',
    )
  } else {
    lines.push(
      `${String(report.findings.length)} ${report.findings.length === 1 ? 'issue' : 'issues'} to review.${comments.length > 0 ? ` See ${comments.length === 1 ? 'the inline comment' : 'the inline comments'}.` : ''}`,
    )
    for (const { finding, number } of inBody) {
      lines.push(
        '',
        '---',
        '',
        `#### Issue ${String(number)}`,
        '',
        codeSpan(where(finding)),
        '',
        renderFindingComment(finding),
      )
    }
  }
  if (report.appendix.length > 0) {
    lines.push('', `${String(report.appendix.length)} more below the cap, in the review's JSON.`)
  }
  const repeated = options.repeatedElsewhere ?? []
  if (repeated.length > 0) {
    const links = [...new Map(repeated.map((ref) => [ref.pr, ref.url])).entries()]
      .map(([pr, link]) => `[#${String(pr)}](${link})`)
      .join(', ')
    lines.push(
      '',
      `${String(repeated.length)} more already raised on ${links}, which carries the same change; not repeated here.`,
    )
  }
  const supporting = reviewDetails(report, options)
  if (report.refuted.length > 0)
    supporting.push(
      `${String(report.refuted.length)} suspected issues were dismissed after checking.`,
    )
  if (inBody.length > 0) lines.push('', '---')
  lines.push('', details('Review details', supporting.join('\n')))
  lines.push(
    '',
    `<sub>Suggestions for the author; this review does not block merging. copse-review ${options.toolVersion}${options.headCommit === null ? '' : ` · <!-- copse-review:${options.headCommit} -->`}</sub>`,
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
  init: { method: string; headers: Record<string, string>; body?: string },
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
  /** Anchored findings kept in the body because their line could not be used. */
  readonly folded: number
  /** Earlier Copse reviews on the pull request marked superseded (GitHub only). */
  readonly superseded?: number
  /** Why superseding earlier reviews stopped; the new review is posted regardless. */
  readonly supersedeError?: string
  /** Nothing was posted: after de-duplication there were no findings to raise. */
  readonly notPosted?: 'no findings'
  /** Findings left out because another open pull request already carries them. */
  readonly repeatedElsewhere?: number
  /** Why the lookup of other open pull requests failed; every finding was kept. */
  readonly repeatLookupError?: string
}

/** Every posted review carries it; a superseded one no longer does. */
const REVIEW_MARKER = /<!-- copse-review:[0-9a-f]{40} -->/
const postedReviewSchema = z.object({
  id: z.number(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(),
})
const listedReviewSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string().nullable(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
  }),
)
const repoReviewCommentsSchema = z.array(
  z.object({
    path: z.string(),
    body: z.string(),
    html_url: z.string(),
    pull_request_url: z.string(),
    user: z.object({ type: z.string() }).nullable(),
  }),
)
const openPullsSchema = z.array(z.object({ number: z.number() }))
const reviewCommentsSchema = z.array(z.object({ node_id: z.string() }))

function graphqlUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  // GitHub Enterprise serves REST at /api/v3 and GraphQL at /api/graphql.
  return base.endsWith('/api/v3') ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`
}

type GithubRequest = (method: string, requestUrl: string, body?: unknown) => Promise<string>

function githubRequest(target: ForgeTarget, fetchImpl: FetchLike): GithubRequest {
  return async (method, requestUrl, body) => {
    const response = await fetchImpl(requestUrl, {
      method,
      headers: headers(target),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      throw new ForgeReviewError(
        response.status,
        `github returned ${String(response.status)} for ${method} ${requestUrl}: ${text.slice(0, ERROR_EXCERPT_CHARS)}`,
      )
    }
    return text
  }
}

interface Supersession {
  /** The review just posted, never superseded itself. */
  readonly exceptId?: number
  /**
   * Whose reviews count as earlier Copse reviews: the poster's login when a
   * review was just posted, otherwise any bot account carrying the marker.
   */
  readonly login?: string
  readonly body: string
}

/**
 * Mark earlier Copse reviews on the pull request superseded. A submitted
 * review cannot be deleted, so its body is replaced and its inline comments
 * are hidden as outdated — reversible, and replies to them are kept.
 */
async function supersedeEarlierReviews(
  target: ForgeTarget,
  supersession: Supersession,
  request: GithubRequest,
): Promise<number> {
  const url = reviewsUrl(target)
  const earlier: number[] = []
  for (let page = 1; ; page++) {
    const listed = safeJsonParse(
      await request('GET', `${url}?per_page=100&page=${String(page)}`),
      decodeWithSchema(listedReviewSchema),
    )
    if (listed === null) throw new Error('github returned an unreadable review list')
    for (const review of listed) {
      const ours =
        supersession.login === undefined
          ? review.user?.type === 'Bot'
          : review.user?.login === supersession.login
      if (review.id !== supersession.exceptId && ours && REVIEW_MARKER.test(review.body ?? '')) {
        earlier.push(review.id)
      }
    }
    if (listed.length < 100) break
  }
  for (const id of earlier) {
    await request('PUT', `${url}/${String(id)}`, { body: supersession.body })
    const comments = safeJsonParse(
      await request('GET', `${url}/${String(id)}/comments?per_page=100`),
      decodeWithSchema(reviewCommentsSchema),
    )
    for (const comment of comments ?? []) {
      await request('POST', graphqlUrl(target.apiBase), {
        query:
          'mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }',
        variables: { id: comment.node_id },
      })
    }
  }
  return earlier.length
}

interface RaisedElsewhere {
  readonly pr: number
  readonly url: string
  readonly path: string
  readonly findingClass: string
  readonly claim: string
}

/** A Copse finding comment: the bold claim, then the category and id in its details. */
const FINDING_COMMENT = /^\*\*(.+?)\*\*\n[\s\S]*Category: ([a-z-]+)\.[\s\S]*· id `[0-9a-f]{16}`/
const REPEAT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Copse inline findings already posted on other open pull requests of the
 * repository. Stacked or cherry-picked branches carry the same commits, and
 * without this the same finding was posted once per branch — seven times
 * for one change in a live batch.
 */
async function findingsRaisedElsewhere(
  target: ForgeTarget,
  request: GithubRequest,
  now: number,
): Promise<RaisedElsewhere[]> {
  const repo = `${target.apiBase.replace(/\/+$/, '')}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  const open = new Set<number>()
  for (let page = 1; page <= 5; page++) {
    const pulls = safeJsonParse(
      await request('GET', `${repo}/pulls?state=open&per_page=100&page=${String(page)}`),
      decodeWithSchema(openPullsSchema),
    )
    if (pulls === null) throw new Error('github returned an unreadable pull request list')
    for (const pull of pulls) open.add(pull.number)
    if (pulls.length < 100) break
  }
  open.delete(target.number)
  const since = new Date(now - REPEAT_LOOKBACK_MS).toISOString()
  const raised: RaisedElsewhere[] = []
  for (let page = 1; page <= 10; page++) {
    const comments = safeJsonParse(
      await request(
        'GET',
        `${repo}/pulls/comments?sort=created&direction=desc&since=${since}&per_page=100&page=${String(page)}`,
      ),
      decodeWithSchema(repoReviewCommentsSchema),
    )
    if (comments === null) throw new Error('github returned an unreadable review comment list')
    for (const comment of comments) {
      const pr = Number(comment.pull_request_url.split('/').pop())
      const match = FINDING_COMMENT.exec(comment.body)
      if (comment.user?.type !== 'Bot' || !open.has(pr) || match === null) continue
      raised.push({
        pr,
        url: comment.html_url,
        path: comment.path,
        claim: match[1] ?? '',
        findingClass: match[2] ?? '',
      })
    }
    if (comments.length < 100) break
  }
  return raised
}

/** The same defect, worded differently, on the same file: Stage 3's claim test. */
function raisedAs(
  finding: Finding,
  raised: readonly RaisedElsewhere[],
): RaisedElsewhere | undefined {
  return raised.find(
    (ref) =>
      ref.path === finding.anchor.path &&
      ref.findingClass === finding.class &&
      (claimSimilarity(ref.claim, finding.claim) >= CLAIM_SIMILARITY_THRESHOLD ||
        claimContainment(ref.claim, finding.claim) >= CLAIM_CONTAINMENT_THRESHOLD),
  )
}

const ERROR_EXCERPT_CHARS = 512

/**
 * Check anchors against full diffs before posting so one invalid location does
 * not displace the valid comments. A 422 — the forge could not place an inline
 * comment — is retried once with every inline comment folded into the body;
 * any other failure is an error carrying the status and the response's head.
 */
export async function postForgeReview(
  target: ForgeTarget,
  report: ReviewReport,
  options: {
    readonly toolVersion: string
    readonly fetch?: FetchLike
    readonly diffForPath?: (path: string) => Promise<string>
    /**
     * Post nothing when there is no finding to raise. A completed review then
     * still marks earlier Copse reviews resolved; an incomplete one leaves
     * them, since it cannot vouch that their findings are gone.
     */
    readonly skipWhenEmpty?: boolean
    /** GitHub: leave out findings another open pull request already carries. */
    readonly skipRaisedElsewhere?: boolean
    readonly now?: () => number
  },
): Promise<PostedReview> {
  const fetchImpl: FetchLike = options.fetch ?? fetch
  const url = reviewsUrl(target)
  const request = githubRequest(target, fetchImpl)
  const sha = target.headCommit === null ? '' : ` of \`${target.headCommit.slice(0, 12)}\``
  let repeated: { finding: Finding; ref: RaisedElsewhere }[] = []
  let repeatLookup: Partial<PostedReview> = {}
  if (
    options.skipRaisedElsewhere === true &&
    target.forge === 'github' &&
    report.findings.length > 0
  ) {
    try {
      const raised = await findingsRaisedElsewhere(target, request, (options.now ?? Date.now)())
      const kept: Finding[] = []
      for (const finding of report.findings) {
        const ref = raisedAs(finding, raised)
        if (ref === undefined) kept.push(finding)
        else repeated.push({ finding, ref })
      }
      report = { ...report, findings: kept }
    } catch (err) {
      repeated = []
      repeatLookup = { repeatLookupError: errorMessage(err) }
    }
  }
  if (repeated.length > 0) repeatLookup = { repeatedElsewhere: repeated.length }
  if (options.skipWhenEmpty === true && report.findings.length === 0) {
    const complete = report.reviews.every((review) => review.outcome === 'completed')
    let resolved: Partial<PostedReview> = {}
    if (complete && target.forge === 'github') {
      try {
        resolved = {
          superseded: await supersedeEarlierReviews(
            target,
            { body: `### Copse Reviewer\n\nResolved: a newer review${sha} raised no new issues.` },
            request,
          ),
        }
      } catch (err) {
        resolved = { supersedeError: errorMessage(err) }
      }
    }
    return { inline: 0, folded: 0, notPosted: 'no findings', ...repeatLookup, ...resolved }
  }
  const attempt = async (review: ForgeReview): Promise<string> => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: headers(target),
        body: JSON.stringify(reviewPayload(target, review)),
      })
      if (response.status >= 200 && response.status < 300) return await response.text()
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
  let fileDiffs: Map<string, string> | undefined
  if (options.diffForPath !== undefined && target.headCommit !== null) {
    const readDiff = options.diffForPath
    const paths = new Set(
      report.findings
        .filter((finding) => finding.anchor.startLine !== undefined)
        .map((finding) => finding.anchor.path),
    )
    fileDiffs = new Map(
      await Promise.all(
        [...paths].map(async (path): Promise<[string, string]> => [path, await readDiff(path)]),
      ),
    )
  }
  const reviewOptions = {
    headCommit: target.headCommit,
    toolVersion: options.toolVersion,
    ...(fileDiffs === undefined ? {} : { fileDiffs }),
    ...(repeated.length === 0
      ? {}
      : { repeatedElsewhere: repeated.map(({ ref }) => ({ pr: ref.pr, url: ref.url })) }),
  }
  const inline = buildForgeReview(report, reviewOptions)
  const anchored = report.findings.filter(
    (finding) => finding.anchor.startLine !== undefined,
  ).length
  // A re-run replaces the earlier review rather than stacking another beside it.
  const supersede = async (responseText: string): Promise<Partial<PostedReview>> => {
    if (target.forge !== 'github') return {}
    const posted = safeJsonParse(responseText, decodeWithSchema(postedReviewSchema))
    if (posted === null) return {}
    try {
      return {
        superseded: await supersedeEarlierReviews(
          target,
          {
            exceptId: posted.id,
            ...(posted.user === null ? {} : { login: posted.user.login }),
            body: `### Copse Reviewer\n\nSuperseded by [a newer review](${posted.html_url})${sha}.`,
          },
          request,
        ),
      }
    } catch (err) {
      return { supersedeError: errorMessage(err) }
    }
  }
  try {
    const response = await attempt(inline)
    return {
      inline: inline.comments.length,
      folded: anchored - inline.comments.length,
      ...repeatLookup,
      ...(await supersede(response)),
    }
  } catch (err) {
    if (!(err instanceof ForgeReviewError) || err.status !== 422 || inline.comments.length === 0) {
      throw err
    }
  }
  const everything = new Set(report.findings.map((_finding, index) => index))
  const response = await attempt(buildForgeReview(report, reviewOptions, everything))
  return { inline: 0, folded: anchored, ...repeatLookup, ...(await supersede(response)) }
}

export class ForgeReviewError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ForgeReviewError'
    this.status = status
  }
}
