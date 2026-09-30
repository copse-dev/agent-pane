import { parseIssueRef } from '@shared/git/issue-ref.ts'
import type { ClassifierQuestion, ClassifierRequest } from '@copse/llm/classifiers/types.ts'
import {
  parseCoverageMatches,
  type RoadmapCoverageVerdict,
  type RoadmapIssueCoverageMatch,
} from '@shared/roadmap/coverage.ts'
import { askClassifierBatch, likeliestChoice } from './classifiers/background-classification.ts'
import { resolveSmallTasksRoute } from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { loadKnowledgeNotes } from './storage/knowledge-store.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import type { RoadmapImportIssue } from './roadmap-issue-import.ts'

/** Issue number from a stored pin (`#52` / `owner/repo#52`), or null. */
function pinnedIssueNumber(issueField: string): number | null {
  const ref = parseIssueRef(issueField)
  if (!ref) return null
  const hash = ref.lastIndexOf('#')
  if (hash < 0) return null
  const n = Number.parseInt(ref.slice(hash + 1), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Import-picker coverage check: which open GitHub issues are already addressed
 * by an existing roadmap prompt, even when that item is not pinned to the
 * issue? Judged by the small-tasks model — advisory only, never blocks import
 * by itself (the pane disables `likely` matches; `partial` stays selectable).
 *
 * Pin matches stay deterministic in the renderer (`issueAlreadyPinned`). This
 * path only covers the unpinned / semantic case. The classifier connection
 * chosen for background questions answers first, one request per issue with
 * one question per item; when none is chosen or it fails, the small-tasks
 * model is asked about every pair in one prompt, as before. No heuristic
 * fallback: when neither answers, or the reply is unparseable, the picker shows
 * pin status alone (same stance as fit-check / complexity).
 */

const MATCH_TIMEOUT_MS = 30_000

export type { RoadmapIssueCoverageMatch }

/** Candidate roadmap items for coverage matching (excludes archived). */
export function coverageCandidateItems(): {
  id: string
  title: string
  body: string
  issue: string
}[] {
  return loadKnowledgeNotes(ROADMAP_TYPE)
    .filter((n) => n.status !== 'archived')
    .map((n) => ({
      id: n.id,
      title: n.title || n.body.slice(0, 80),
      body: n.body,
      issue: n.fields['issue'] ?? '',
    }))
}

type CoverageCandidate = ReturnType<typeof coverageCandidateItems>[number]

/**
 * The classifier's answers, weakest first: a tie goes to the earlier one. A
 * `likely` match disables importing the issue, so a tie must not reach it.
 */
const COVERAGE_CHOICES = ['none', 'partial', 'likely'] as const

const COVERAGE_OPTIONS = {
  none: 'the prompt does not address the goal of the issue',
  partial: 'the prompt overlaps with the issue but would leave meaningful work undone',
  likely: 'carrying out the prompt would largely resolve the issue, even if worded differently',
} satisfies Record<(typeof COVERAGE_CHOICES)[number], string>

/** The classifier's per-request question limit. */
const MAX_QUESTIONS = 256

function coverageQuestion(item: CoverageCandidate): ClassifierQuestion {
  return {
    type: 'choice',
    instructions:
      'Does this existing roadmap item already address the GitHub issue? ' +
      `Roadmap item ${JSON.stringify(item.title.slice(0, 120))}: ${item.body.slice(0, 400)}`,
    options: COVERAGE_OPTIONS,
  }
}

/**
 * Ask the chosen classifier connection about every issue × item pair: one
 * request per issue (split when the items exceed one request's questions),
 * with the issue as the state and one question per item. Each issue keeps its
 * strongest match, the likelier one on a tie. Null when no connection is
 * chosen or any answer is unusable, so the model can answer instead.
 */
export async function classifyCoverage(
  open: readonly RoadmapImportIssue[],
  candidates: readonly CoverageCandidate[],
  ask: typeof askClassifierBatch = askClassifierBatch,
): Promise<Omit<RoadmapIssueCoverageMatch, 'itemTitle'>[] | null> {
  const requests: ClassifierRequest[] = []
  const pairs: { issueNumber: number; items: CoverageCandidate[] }[] = []
  for (const issue of open) {
    const state = `Issue #${String(issue.number)}: ${issue.title.slice(0, 160)}\n\n${issue.body.slice(0, 600)}`
    for (let start = 0; start < candidates.length; start += MAX_QUESTIONS) {
      const items = candidates.slice(start, start + MAX_QUESTIONS)
      requests.push({
        state,
        questions: Object.fromEntries(
          items.map((item, index) => [`item-${String(index)}`, coverageQuestion(item)]),
        ),
      })
      pairs.push({ issueNumber: issue.number, items })
    }
  }
  const results = await ask(requests, {
    timeoutMs: MATCH_TIMEOUT_MS,
    signal: AbortSignal.timeout(MATCH_TIMEOUT_MS),
  })
  if (!results) return null

  const best = new Map<
    number,
    { itemId: string; verdict: RoadmapCoverageVerdict; probability: number }
  >()
  for (const [index, { issueNumber, items }] of pairs.entries()) {
    const answers = results[index]?.answers
    if (!answers) return null
    for (const [itemIndex, item] of items.entries()) {
      const answer = likeliestChoice(COVERAGE_CHOICES, answers[`item-${String(itemIndex)}`])
      if (!answer) return null
      if (answer.choice === 'none') continue
      const current = best.get(issueNumber)
      const stronger =
        !current ||
        (answer.choice === 'likely' && current.verdict === 'partial') ||
        (answer.choice === current.verdict && answer.probability > current.probability)
      if (stronger) {
        best.set(issueNumber, {
          itemId: item.id,
          verdict: answer.choice,
          probability: answer.probability,
        })
      }
    }
  }
  return [...best.entries()].map(([issueNumber, { itemId, verdict }]) => ({
    issueNumber,
    itemId,
    verdict,
  }))
}

/**
 * Judge which open issues are already covered by existing roadmap items: the
 * classifier connection first, then the small-tasks model. Issues already
 * pinned on a candidate are skipped — the pane already marks those.
 * `complete` and `classify` are injectable for tests.
 */
export async function matchOpenIssuesToRoadmapItems(
  issues: RoadmapImportIssue[],
  complete: (ask: string) => Promise<string> = askSmallTasks,
  classify: typeof classifyCoverage = classifyCoverage,
): Promise<RoadmapIssueCoverageMatch[]> {
  if (issues.length === 0) return []
  const candidates = coverageCandidateItems()
  if (candidates.length === 0) return []

  // Skip issues that already have a deterministic pin match — no model call
  // needed for those, and we must not invent a second match that fights the
  // pin badge.
  const pinnedNumbers = new Set<number>()
  for (const item of candidates) {
    const n = pinnedIssueNumber(item.issue)
    if (n !== null) pinnedNumbers.add(n)
  }
  const open = issues.filter((i) => !pinnedNumbers.has(i.number))
  if (open.length === 0) return []
  const titleById = new Map(candidates.map((c) => [c.id, c.title] as const))

  const classified = await classify(open, candidates)
  if (classified) {
    return classified.map((m) => ({ ...m, itemTitle: titleById.get(m.itemId) ?? m.itemId }))
  }

  const itemBlock = candidates
    .map(
      (c) =>
        `- id=${c.id}` +
        (c.issue ? ` pin=${c.issue}` : '') +
        ` title=${JSON.stringify(c.title.slice(0, 120))}\n` +
        `  prompt=${JSON.stringify(c.body.slice(0, 400))}`,
    )
    .join('\n')
  const issueBlock = open
    .map(
      (i) =>
        `- #${String(i.number)} ${JSON.stringify(i.title.slice(0, 160))}\n` +
        `  body=${JSON.stringify(i.body.slice(0, 600))}`,
    )
    .join('\n')

  const ask =
    'You are matching open GitHub issues to existing roadmap prompts.\n' +
    'For each ISSUE that an ITEM already addresses (same goal, even if wording differs ' +
    'or the item is not pinned), output one line:\n' +
    '  #<issueNumber> <itemId> likely\n' +
    'or\n' +
    '  #<issueNumber> <itemId> partial\n' +
    'Use likely when the prompt would largely resolve the issue; partial when it overlaps ' +
    'but would leave meaningful work undone. Use only item ids from the list. ' +
    'Output ONLY matching lines (or nothing). Do not invent issues or items.\n\n' +
    `ITEMS:\n${itemBlock}\n\nISSUES:\n${issueBlock}`

  let text: string
  try {
    text = await complete(ask)
  } catch {
    return []
  }

  const knownIds = new Set(candidates.map((c) => c.id))
  // Drop any pin collisions the model invents — the pane already owns those.
  return parseCoverageMatches(text, knownIds)
    .filter((m) => !pinnedNumbers.has(m.issueNumber))
    .map((m) => ({
      ...m,
      itemTitle: titleById.get(m.itemId) ?? m.itemId,
    }))
}

async function askSmallTasks(ask: string): Promise<string> {
  const route = await resolveSmallTasksRoute()
  if (!route) throw new Error('No small-tasks provider')
  const { text, usage } = await completeTextWithUsage(route.provider, ask, MATCH_TIMEOUT_MS)
  if (usage.inputTokens || usage.outputTokens) {
    recordUsageEvent({
      model: route.model,
      source: 'small-tasks',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  return text
}
