import { randomUUID } from 'node:crypto'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { isLocalModel } from '@copse/llm/estimate-cost.ts'
import { contextOverflowAdvice, isContextOverflowMessage } from '@shared/context-window-advice.ts'
import { errorMessage } from '@shared/errors.ts'
import { resolveIssueRef } from '@shared/git/issue-ref.ts'
import { parseReviewVerdict, type RoadmapReviewVerdict } from '@shared/roadmap/review.ts'
import type { GhIssueSummary } from '@shared/types/git.ts'
import type { LLMProvider, ModelUsage } from '@shared/types'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { resolveContextWindow } from './providers/resolve-context-window.ts'
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

/** Characters of each evidence section the prompt carries, before any trimming. */
export interface ReviewSectionChars {
  prompt: number
  notes: number
  issue: number
  commits: number
}

/** What each section is worth when the model has room for the whole prompt. */
const SECTION_CEILINGS: Readonly<Record<RoadmapReviewDepth, ReviewSectionChars>> = {
  bulk: { prompt: 4000, notes: 1000, issue: 2000, commits: 6000 },
  deep: { prompt: 4000, notes: 1000, issue: 2000, commits: 12_000 },
}

/**
 * Share of the model's context window the evidence may fill. The rest covers the
 * verdict the model writes back, the fixed instructions, and the slack the
 * ~4 chars/token estimate needs on hash-heavy commit lines.
 */
const REVIEW_PROMPT_CONTEXT_RATIO = 0.7

/** Commit history below this is not worth sending; other sections shrink instead. */
const MIN_COMMIT_CHARS = 800

/**
 * The context size to retry at when the model rejects the prompt anyway. LM
 * Studio's OpenAI `/models` reports a model's catalog maximum, which can be far
 * larger than the length it was actually loaded with — 4K is its usual default.
 */
const FALLBACK_CONTEXT_WINDOW = 4096

/** Where the model used for reviews is chosen, named in the failure advice. */
const SMALL_TASKS_SETTINGS_PATH = 'Settings → General → Models → Small tasks'

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

type IssueEvidenceBundle = {
  pinned: GhIssueSummary | null
  pinnedEvidence: RoadmapReviewIssueEvidence | null
  linked: RoadmapReviewIssueEvidence[]
}

/** Dedupes pinned-issue + linked-issue GitHub reads within one bulk review pass. */
type IssueEvidenceCache = Map<string, IssueEvidenceBundle | Promise<IssueEvidenceBundle>>

const bulkRunIssueCaches = new Map<string, IssueEvidenceCache>()

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

/**
 * Trim each evidence section to what the reviewing model can actually read.
 *
 * The full deep prompt is ~19K characters — comfortably over a local model
 * loaded with 4K tokens of context, which is LM Studio's default and the size
 * the small-tasks model usually runs at. Sending it anyway is not a slow path
 * but a hard failure: the engine rejects the request outright ("context size has
 * been exceeded") and the item gets no verdict at all.
 *
 * The commit log shrinks first — it is the largest section and the most
 * repetitive — and only once it is down to {@link MIN_COMMIT_CHARS} does the
 * item's own prompt start giving up characters, since that is what the verdict
 * is about.
 */
export function reviewSectionChars(
  contextWindow: number,
  depth: RoadmapReviewDepth,
): ReviewSectionChars {
  const ceilings = SECTION_CEILINGS[depth]
  const total = ceilings.prompt + ceilings.notes + ceilings.issue + ceilings.commits
  const budget = Math.max(
    MIN_COMMIT_CHARS,
    Math.floor(contextWindow * REVIEW_PROMPT_CONTEXT_RATIO * CHARS_PER_TOKEN),
  )
  if (budget >= total) return ceilings
  const fixed = ceilings.prompt + ceilings.notes + ceilings.issue
  if (budget - fixed >= MIN_COMMIT_CHARS) return { ...ceilings, commits: budget - fixed }
  // Too small even for the item alone: keep every section's share of what fits
  // so the model still sees a prompt, an issue, and some history.
  const scale = budget / total
  return {
    prompt: Math.floor(ceilings.prompt * scale),
    notes: Math.floor(ceilings.notes * scale),
    issue: Math.floor(ceilings.issue * scale),
    commits: Math.floor(ceilings.commits * scale),
  }
}

function reviewPrompt(
  note: { body: string; status: string | null; fields: Record<string, string> },
  pinned: GhIssueSummary | null,
  linked: RoadmapReviewIssueEvidence[],
  commits: string,
  depth: RoadmapReviewDepth,
  sections: ReviewSectionChars,
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
    `PROMPT:\n${note.body.slice(0, sections.prompt)}\n` +
    (notesField ? `\nNOTES:\n${notesField.slice(0, sections.notes)}\n` : '') +
    (pinned
      ? `\nPINNED ISSUE #${String(pinned.number)} [${issueState(pinned)}]: ${pinned.title}\n${pinned.body.slice(0, sections.issue)}\n`
      : '\nPINNED ISSUE: (none)\n') +
    formatIssueBlock('LINKED ISSUES', linked) +
    `\n${commitLabel}:\n${commits.slice(0, sections.commits)}\n`
  )
}

interface ReviewPromptInput {
  note: { body: string; status: string | null; fields: Record<string, string> }
  pinned: GhIssueSummary | null
  linked: RoadmapReviewIssueEvidence[]
  commits: string
  depth: RoadmapReviewDepth
}

/**
 * Ask the model for a verdict, shrinking the prompt once if it is refused for
 * context. The reported window can overstate the loaded one (see
 * {@link FALLBACK_CONTEXT_WINDOW}), so a rejection is worth one cheap retry at
 * the size local models are usually loaded with before giving up. What comes
 * back then is advice the user can act on, not the engine's raw 500.
 */
export async function completeReviewPrompt(
  provider: LLMProvider,
  input: ReviewPromptInput,
  model: string,
  contextWindow: number,
  timeoutMs: number,
): Promise<{ text: string; usage: ModelUsage }> {
  const windows =
    contextWindow > FALLBACK_CONTEXT_WINDOW
      ? [contextWindow, FALLBACK_CONTEXT_WINDOW]
      : [contextWindow]
  const { note, pinned, linked, commits, depth } = input
  for (const [index, window] of windows.entries()) {
    const sections = reviewSectionChars(window, depth)
    try {
      return await completeTextWithUsage(
        provider,
        reviewPrompt(note, pinned, linked, commits, depth, sections),
        timeoutMs,
      )
    } catch (err) {
      if (!isContextOverflowMessage(errorMessage(err))) throw err
      if (index === windows.length - 1) {
        throw new Error(
          contextOverflowAdvice({
            task: depth === 'deep' ? 'The resolution check' : 'The roadmap review',
            modelLabel: model,
            contextWindow: window,
            settingsPath: SMALL_TASKS_SETTINGS_PATH,
            lmStudioModel: isLocalModel(model),
          }),
          { cause: err },
        )
      }
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new Error('The roadmap review made no model call.')
}

/**
 * Bulk-review order: non-done items keep store order so active work is judged
 * first; done items trail for a cheap double-check, oldest `createdAt` first.
 */
export function orderRoadmapNotesForReview<
  T extends { id: string; status: string | null; createdAt: string },
>(notes: readonly T[]): T[] {
  const active: T[] = []
  const done: T[] = []
  for (const note of notes) {
    if (note.status === 'done') done.push(note)
    else active.push(note)
  }
  done.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return [...active, ...done]
}

/** Load review scope: items to judge and commits since the last acknowledged run. */
export async function prepareRoadmapReview(): Promise<RoadmapReviewPrepareResult> {
  const since = getRoadmapLastReviewAt()
  // Re-prepare (e.g. double-click ◎) overwrites pendingBulkRun; drop the previous
  // run's issue cache so complete/abort of the orphaned id cannot leave it stranded.
  const previousPending = readRoadmapReviewCheckpoint().pendingBulkRun
  if (previousPending) dropBulkRunIssueCache(previousPending)
  const runId = randomUUID()
  setPendingBulkRun(runId)
  const commits = await getGitLogSinceText(since, BULK_COMMIT_MAX)
  const notes = orderRoadmapNotesForReview(
    loadKnowledgeNotes(ROADMAP_TYPE).filter((n) => n.status !== 'archived'),
  )
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
export function completeRoadmapReview(runId: string): boolean {
  const acknowledged = acknowledgeBulkRun(runId)
  if (acknowledged) dropBulkRunIssueCache(runId)
  return acknowledged
}

/** Clear an in-progress bulk run without advancing the commit checkpoint. */
export function abortRoadmapReview(runId: string): boolean {
  const aborted = clearPendingBulkRun(runId)
  if (aborted) dropBulkRunIssueCache(runId)
  return aborted
}

function issueEvidenceCacheKey(coords: { owner: string; repo: string; number: number }): string {
  return `${coords.owner}/${coords.repo}#${String(coords.number)}`
}

function cacheForBulkRun(runId: string): IssueEvidenceCache {
  let cache = bulkRunIssueCaches.get(runId)
  if (!cache) {
    cache = new Map()
    bulkRunIssueCaches.set(runId, cache)
  }
  return cache
}

function dropBulkRunIssueCache(runId: string): void {
  bulkRunIssueCaches.delete(runId)
}

/** @internal test helper — reset in-memory bulk-run GitHub caches. */
export function clearBulkRunIssueCacheForTest(runId?: string): void {
  if (runId) dropBulkRunIssueCache(runId)
  else bulkRunIssueCaches.clear()
}

/** @internal test helper — exercise bulk-run GitHub dedup without an LLM. */
export async function gatherIssueEvidenceWithBulkCache(
  ref: string,
  slug: string | null,
  bulkRunId: string,
): Promise<IssueEvidenceBundle> {
  return gatherIssueEvidence(ref, slug, cacheForBulkRun(bulkRunId))
}

async function gatherIssueEvidence(
  ref: string,
  slug: string | null,
  cache?: IssueEvidenceCache,
): Promise<IssueEvidenceBundle> {
  const coords = resolveIssueRef(ref, slug)
  if (!coords) {
    return { pinned: null, pinnedEvidence: null, linked: [] }
  }

  const key = issueEvidenceCacheKey(coords)
  if (cache) {
    const hit = cache.get(key)
    if (hit) return hit
  }

  const backend = resolveGitHubBackend()
  const load = (async (): Promise<IssueEvidenceBundle> => {
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
  })()

  if (cache) {
    cache.set(key, load)
  }

  try {
    const result = await load
    if (cache) {
      cache.set(key, result)
    }
    return result
  } catch (err) {
    cache?.delete(key)
    throw err
  }
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

  if (note.status === 'done') {
    const detail = 'Item is already marked done on the roadmap.'
    stampReview(id, note, 'resolved', detail, depth, bulkRunId)
    return {
      id,
      verdict: 'resolved',
      detail,
      depth,
      pinnedIssue: null,
      linkedIssues: [],
    }
  }

  const slug = await getGithubRepoSlug()
  const issueRef = note.fields['issue'] ?? ''
  const cache = depth === 'bulk' && bulkRunId ? cacheForBulkRun(bulkRunId) : undefined
  const { pinned, pinnedEvidence, linked } = issueRef
    ? await gatherIssueEvidence(issueRef, slug, cache)
    : {
        pinned: null as GhIssueSummary | null,
        pinnedEvidence: null,
        linked: [] as RoadmapReviewIssueEvidence[],
      }

  // A closed GitHub issue is evidence, not proof of implementation: issues can
  // be closed as duplicates, not planned, or invalid. Keep the state in the
  // model prompt instead of enabling bulk mark/archive from that signal alone.
  const provider = await resolveSmallTasksProvider()
  if (!provider) {
    throw new Error('No model available for the roadmap review — configure a small-tasks model.')
  }

  const model = resolveSmallTasksModelId()
  // The configured small-tasks model, which is what the provider above resolves
  // to unless it could not be built and fell back to the chat model. A window
  // read from the wrong model of the two is what the retry inside
  // completeReviewPrompt exists to absorb.
  const contextWindow = await resolveContextWindow(model)
  const timeout = depth === 'deep' ? DEEP_REVIEW_TIMEOUT_MS : BULK_REVIEW_TIMEOUT_MS
  const { text, usage } = await completeReviewPrompt(
    provider,
    { note, pinned, linked, commits, depth },
    model,
    contextWindow,
    timeout,
  )
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
