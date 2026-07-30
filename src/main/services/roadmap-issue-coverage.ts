import { parseIssueRef } from '@shared/git/issue-ref.ts'
import { parseCoverageMatches, type RoadmapIssueCoverageMatch } from '@shared/roadmap/coverage.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
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
 * path only covers the unpinned / semantic case. No heuristic fallback: when
 * no model is available or the reply is unparseable, the picker shows pin
 * status alone (same stance as fit-check / complexity).
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

/**
 * Ask the small-tasks model which open issues are already covered by existing
 * roadmap items. Issues already pinned on a candidate are skipped — the pane
 * already marks those. `complete` is injectable for tests.
 */
export async function matchOpenIssuesToRoadmapItems(
  issues: RoadmapImportIssue[],
  complete: (ask: string) => Promise<string> = askSmallTasks,
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
  const titleById = new Map(candidates.map((c) => [c.id, c.title] as const))
  // Drop any pin collisions the model invents — the pane already owns those.
  return parseCoverageMatches(text, knownIds)
    .filter((m) => !pinnedNumbers.has(m.issueNumber))
    .map((m) => ({
      ...m,
      itemTitle: titleById.get(m.itemId) ?? m.itemId,
    }))
}

async function askSmallTasks(ask: string): Promise<string> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) throw new Error('No small-tasks provider')
  const model = resolveSmallTasksModelId()
  const { text, usage } = await completeTextWithUsage(provider, ask, MATCH_TIMEOUT_MS)
  if (usage.inputTokens || usage.outputTokens) {
    recordUsageEvent({
      model,
      source: 'small-tasks',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  return text
}
