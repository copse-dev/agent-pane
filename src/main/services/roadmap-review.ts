import { randomUUID } from 'node:crypto'
import { resolveIssueRef } from '@shared/git/issue-ref.ts'
import { parseReviewVerdict, type RoadmapReviewVerdict } from '@shared/roadmap/review.ts'
import type { GhIssueSummary } from '@shared/types/git.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import {
  getKnowledgeNote,
  loadKnowledgeNotes,
  updateKnowledgeNote,
} from './storage/knowledge-store.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { resolveGitHubBackend } from './github/backend/backend.ts'
import { getGithubRepoSlug, getGitLogSinceText } from './github/git-service.ts'
import {
  acknowledgeBulkRun,
  clearPendingBulkRun,
  getRoadmapLastReviewAt,
  readRoadmapReviewCheckpoint,
  setPendingBulkRun,
  type RoadmapReviewCheckpoint,
} from './roadmap-review-state.ts'

/**
 * Roadmap review (issue #556 follow-up): on demand, judge whether each backlog
 * item has been resolved using GitHub issue state (pinned + cross-linked issues),
 * commits, and the small-tasks model. Advisory only — verdicts are stamped on
 * notes for display but never auto-change status.
 *
 * Bulk review (◎) scopes commits since the last *acknowledged* backlog review
 * (see completeRoadmapReview). Deep single-item review uses the item's full
 * lifetime commit window and a richer prompt.
 */

export type RoadmapReviewDepth = 'bulk' | 'deep'

const BULK_REVIEW_TIMEOUT_MS = 45_000
const DEEP_REVIEW_TIMEOUT_MS = 60_000
const BULK_COMMIT_MAX = 80
const DEEP_COMMIT_MAX = 200
const LINKED_ISSUE_LIMIT = 8

export interface RoadmapReviewPrepareResult {
  /** Id for this bulk pass — stamped on each item and returned on acknowledge. */
  runId: string
  /** ISO timestamp of the previous acknowledged backlog review, or null. */
  since: string | null
  /** Oneline git log since `since` (or the latest commits when first run). */
  commits: string
  items: { id: string; title: string }[]
}

export interface RoadmapReviewIssueEvidence {
  ref: string
  number: number
  title: string
  state: 'open' | 'closed' | 'unknown'
}

export interface RoadmapReviewItemResult {
  id: string
  verdict: RoadmapReviewVerdict
  detail: string
  depth: RoadmapReviewDepth
  pinnedIssue: RoadmapReviewIssueEvidence | null
  linkedIssues: RoadmapReviewIssueEvidence[]
}

function issueState(issue: GhIssueSummary): 'open' | 'closed' | 'unknown' {
  return issue.state ?? 'unknown'
}

function toEvidence(ref: string, issue: GhIssueSummary): RoadmapReviewIssueEvidence {
  return {
    ref,
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
  }
}

function formatIssueBlock(label: string, issues: RoadmapReviewIssueEvidence[]): string {
  if (issues.length === 0) return `${label}: (none)\n`
  const lines = issues.map((i) => `- #${String(i.number)} [${i.state}] ${i.title}`)
  return `${label}:\n${lines.join('\n')}\n`
}

function formatReviewDetail(text: string, depth: RoadmapReviewDepth): string {
  const maxLen = depth === 'deep' ? 1200 : 600
  const lines = text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return text.trim().split('\n').slice(1).join(' ').trim().slice(0, maxLen)
  }
  return lines.join(' · ').slice(0, maxLen)
}

function reviewPrompt(
  note: { body: string; status: string | null; fields: Record<string, string> },
  pinned: GhIssueSummary | null,
  linked: RoadmapReviewIssueEvidence[],
  commits: string,
  depth: RoadmapReviewDepth,
): string {
  const notesField = note.fields['notes'] ?? ''
  const commitLabel =
    depth === 'deep' ? 'COMMITS (since item was created)' : 'RECENT COMMITS (since last review)'
  const intro =
    depth === 'deep'
      ? 'This is a DEEP single-item resolution review with a longer commit history than ' +
        'the periodic backlog scan. Consider the full evidence carefully. '
      : ''
  return (
    intro +
    'Review whether the ROADMAP ITEM below has been resolved in this codebase. ' +
    'Use the pinned GitHub issue (if any), other linked issues, the commit ' +
    'history, and the item prompt/notes. First line: exactly one word — resolved, ' +
    'likely, partial, or open. Then up to six short bullet points explaining your ' +
    'reasoning and what to verify. Judge only from the evidence given.\n\n' +
    `ROADMAP STATUS: ${note.status ?? 'ready'}\n` +
    `PROMPT:\n${note.body.slice(0, 4000)}\n` +
    (notesField ? `\nNOTES:\n${notesField.slice(0, 1000)}\n` : '') +
    (pinned
      ? `\nPINNED ISSUE #${String(pinned.number)} [${issueState(pinned)}]: ${pinned.title}\n${pinned.body.slice(0, 2000)}\n`
      : '\nPINNED ISSUE: (none)\n') +
    formatIssueBlock('LINKED ISSUES', linked) +
    `\n${commitLabel}:\n${commits.slice(0, depth === 'deep' ? 12_000 : 6000)}\n`
  )
}

/** Load review scope: items to judge and commits since the last acknowledged run. */
export async function prepareRoadmapReview(): Promise<RoadmapReviewPrepareResult> {
  const since = getRoadmapLastReviewAt()
  const runId = randomUUID()
  setPendingBulkRun(runId)
  const commits = await getGitLogSinceText(since, BULK_COMMIT_MAX)
  const notes = loadKnowledgeNotes(ROADMAP_TYPE).filter((n) => n.status !== 'archived')
  return {
    runId,
    since,
    commits,
    items: notes.map((n) => ({ id: n.id, title: n.title || '(untitled)' })),
  }
}

/** Read the bulk-review checkpoint for staleness checks in the renderer. */
export function readRoadmapReviewCheckpointForRenderer(): RoadmapReviewCheckpoint {
  return readRoadmapReviewCheckpoint()
}

/**
 * Advance the bulk-review checkpoint. Called when the user closes the backlog
 * review panel after a finished run — not when deep single-item checks run.
 */
export function completeRoadmapReview(runId: string): void {
  acknowledgeBulkRun(runId)
}

/** Clear an in-progress bulk run without advancing the commit checkpoint. */
export function abortRoadmapReview(): void {
  clearPendingBulkRun()
}

async function gatherIssueEvidence(
  ref: string,
  slug: string | null,
): Promise<{
  pinned: GhIssueSummary | null
  pinnedEvidence: RoadmapReviewIssueEvidence | null
  linked: RoadmapReviewIssueEvidence[]
}> {
  const coords = resolveIssueRef(ref, slug)
  if (!coords) {
    return { pinned: null, pinnedEvidence: null, linked: [] }
  }
  const backend = resolveGitHubBackend()
  const pinned = await backend.getIssue(coords)
  if (!pinned) {
    return { pinned: null, pinnedEvidence: null, linked: [] }
  }
  const pinnedEvidence = toEvidence(ref, pinned)
  const searchNeedle = `"#${String(pinned.number)}"`
  const linkedRaw = slug
    ? await backend.searchWorkspaceIssues(searchNeedle, LINKED_ISSUE_LIMIT)
    : []
  const linked = linkedRaw
    .filter((issue) => issue.number !== pinned.number)
    .map((issue) => toEvidence(`#${String(issue.number)}`, issue))
  return { pinned, pinnedEvidence, linked }
}

/** Judge one roadmap item and stamp the advisory verdict on its note. */
export async function reviewRoadmapItem(
  id: string,
  commits: string,
  depth: RoadmapReviewDepth = 'bulk',
  bulkRunId?: string,
): Promise<RoadmapReviewItemResult> {
  const note = getKnowledgeNote(id)
  if (!note || note.type !== ROADMAP_TYPE) {
    throw new Error(`No roadmap item with id "${id}".`)
  }

  const slug = await getGithubRepoSlug()
  const issueRef = note.fields['issue'] ?? ''
  const { pinned, pinnedEvidence, linked } = issueRef
    ? await gatherIssueEvidence(issueRef, slug)
    : {
        pinned: null as GhIssueSummary | null,
        pinnedEvidence: null,
        linked: [] as RoadmapReviewIssueEvidence[],
      }

  if (note.status === 'done') {
    const detail = 'Item is already marked done on the roadmap.'
    stampReview(id, note, 'resolved', detail, depth, bulkRunId)
    return {
      id,
      verdict: 'resolved',
      detail,
      depth,
      pinnedIssue: pinnedEvidence,
      linkedIssues: linked,
    }
  }

  if (pinned?.state === 'closed') {
    const detail = `Pinned issue ${issueRef} is closed on GitHub.`
    stampReview(id, note, 'resolved', detail, depth, bulkRunId)
    return {
      id,
      verdict: 'resolved',
      detail,
      depth,
      pinnedIssue: pinnedEvidence,
      linkedIssues: linked,
    }
  }

  const provider = await resolveSmallTasksProvider()
  if (!provider) {
    throw new Error('No model available for the roadmap review — configure a small-tasks model.')
  }

  const model = resolveSmallTasksModelId()
  const ask = reviewPrompt(note, pinned, linked, commits, depth)
  const timeout = depth === 'deep' ? DEEP_REVIEW_TIMEOUT_MS : BULK_REVIEW_TIMEOUT_MS
  const { text, usage } = await completeTextWithUsage(provider, ask, timeout)
  if (usage.inputTokens || usage.outputTokens) {
    recordUsageEvent({
      model,
      source: 'small-tasks',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  const verdict = parseReviewVerdict(text)
  if (!verdict) throw new Error('The model returned no verdict — try again.')
  const detail =
    formatReviewDetail(text, depth) || text.trim().slice(0, depth === 'deep' ? 1200 : 600)

  const fresh = getKnowledgeNote(id)
  if (fresh && fresh.body === note.body && fresh.fields['issue'] === issueRef) {
    stampReview(id, fresh, verdict, detail, depth, bulkRunId)
  }

  return {
    id,
    verdict,
    detail,
    depth,
    pinnedIssue: pinnedEvidence,
    linkedIssues: linked,
  }
}

/** Deep resolution review for one item — full commit history since the item was created. */
export async function reviewRoadmapItemDeep(id: string): Promise<RoadmapReviewItemResult> {
  const note = getKnowledgeNote(id)
  if (!note || note.type !== ROADMAP_TYPE) {
    throw new Error(`No roadmap item with id "${id}".`)
  }
  const since = note.createdAt || null
  const commits = await getGitLogSinceText(since, DEEP_COMMIT_MAX)
  const checkpoint = readRoadmapReviewCheckpoint()
  const bulkRunId = checkpoint.lastAcknowledgedBulkRun ?? checkpoint.pendingBulkRun ?? undefined
  return reviewRoadmapItem(id, commits, 'deep', bulkRunId)
}

function stampReview(
  id: string,
  note: { body: string; fields: Record<string, string> },
  verdict: RoadmapReviewVerdict,
  detail: string,
  depth: RoadmapReviewDepth,
  bulkRunId?: string,
): void {
  const fields: Record<string, string> = {
    ...note.fields,
    reviewVerdict: verdict,
    reviewDetail: detail,
    reviewAt: new Date().toISOString(),
    reviewDepth: depth,
  }
  if (depth === 'bulk' && bulkRunId) {
    fields['reviewBulkRun'] = bulkRunId
  } else if (depth === 'deep' && bulkRunId) {
    fields['reviewBulkRun'] = bulkRunId
  }
  updateKnowledgeNote(id, { fields })
}
