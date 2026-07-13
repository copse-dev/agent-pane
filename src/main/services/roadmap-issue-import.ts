import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { addKnowledgeNote, type KnowledgeNote } from './storage/knowledge-store.ts'
import { ROADMAP_TYPE, roadmapTitleFromPrompt } from '../tools/roadmap-tools.ts'

/**
 * Roadmap issue import (issue #556 follow-up): turn selected open GitHub
 * issues into roadmap items whose body is a runnable prompt, pinned to the
 * issue via the `issue` frontmatter field.
 *
 * Prompt drafting prefers the configured small-tasks model (the same local
 * default that titles/summaries use) and falls back to a deterministic
 * template when no provider is available or the call fails, so import always
 * succeeds.
 */

/** The slice of an issue the import flow needs; sizes bounded at the IPC edge. */
export interface RoadmapImportIssue {
  number: number
  title: string
  body: string
}

const DRAFT_TIMEOUT_MS = 20_000

/** Deterministic fallback prompt when no model is available. */
export function templateRoadmapPrompt(issue: RoadmapImportIssue): string {
  const body = issue.body.trim()
  return (
    `Resolve GitHub issue #${String(issue.number)}: ${issue.title}` +
    (body ? `\n\nIssue description:\n${body.slice(0, 1500)}` : '')
  )
}

/** Draft a runnable prompt for the issue via the small-tasks model. */
export async function draftRoadmapPrompt(issue: RoadmapImportIssue): Promise<string> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return templateRoadmapPrompt(issue)
  const model = resolveSmallTasksModelId()
  const ask =
    'Write a concise prompt (2-5 sentences) instructing a coding agent to resolve the ' +
    'GitHub issue below. State the goal and any key constraints from the issue; do not ' +
    'invent requirements that are not in it. Reply with ONLY the prompt text.\n\n' +
    `Issue #${String(issue.number)}: ${issue.title}\n\n` +
    issue.body.slice(0, 2000)
  try {
    const { text, usage } = await completeTextWithUsage(provider, ask, DRAFT_TIMEOUT_MS)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'small-tasks',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
    const drafted = text.trim()
    return drafted || templateRoadmapPrompt(issue)
  } catch {
    return templateRoadmapPrompt(issue)
  }
}

/**
 * Create one roadmap item per issue, pinned via `fields.issue`. Sequential on
 * purpose: local small-tasks models handle one completion at a time well, and
 * import is an explicit, occasional action. `draft` is injectable for tests.
 */
export async function importIssuesAsRoadmapItems(
  issues: RoadmapImportIssue[],
  draft: (issue: RoadmapImportIssue) => Promise<string> = draftRoadmapPrompt,
): Promise<KnowledgeNote[]> {
  const created: KnowledgeNote[] = []
  for (const issue of issues) {
    const prompt = await draft(issue)
    created.push(
      addKnowledgeNote({
        type: ROADMAP_TYPE,
        title: roadmapTitleFromPrompt(prompt),
        body: prompt,
        status: 'ready',
        fields: {
          issue: `#${String(issue.number)}`,
          notes: `Imported from issue #${String(issue.number)}: ${issue.title}`,
        },
      }),
    )
  }
  return created
}
