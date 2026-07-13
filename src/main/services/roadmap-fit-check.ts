import { resolveIssueRef } from '@shared/git/issue-ref.ts'
import { parseFitVerdict, type RoadmapFit } from '@shared/roadmap/fit.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { resolveGitHubBackend } from './github/backend/backend.ts'
import { getGithubRepoSlug } from './github/git-service.ts'

/**
 * On-demand fit check (issue #556 follow-up): would executing a roadmap
 * item's prompt plausibly resolve its pinned GitHub issue? Judged by the
 * small-tasks model — advisory only, triggered by an explicit pane action,
 * never on save. Unlike complexity there is no heuristic fallback: a keyword
 * match cannot judge fit, so without a model the check reports why instead.
 *
 * The verdict is stamped into the note's `fit` frontmatter field; the
 * reasoning is returned for display but not persisted (frontmatter scalars
 * stay short).
 */

const FIT_TIMEOUT_MS = 30_000

export interface RoadmapFitResult {
  verdict: RoadmapFit
  /** Free-form model reasoning (what the prompt misses / should verify). */
  detail: string
}

export async function checkRoadmapFit(id: string): Promise<RoadmapFitResult> {
  const note = getKnowledgeNote(id)
  if (!note || note.type !== ROADMAP_TYPE) throw new Error(`No roadmap item with id "${id}".`)
  const ref = note.fields['issue']
  if (!ref) throw new Error('This item has no pinned issue — set one, then check fit.')
  const coords = resolveIssueRef(ref, await getGithubRepoSlug())
  if (!coords) {
    throw new Error(`Could not resolve "${ref}" — is this workspace a GitHub repo?`)
  }
  const issue = await resolveGitHubBackend().getIssue(coords)
  if (!issue) throw new Error(`Issue ${ref} was not found on GitHub.`)

  const provider = await resolveSmallTasksProvider()
  if (!provider) {
    throw new Error('No model available for the fit check — configure a small-tasks model.')
  }
  const model = resolveSmallTasksModelId()
  const ask =
    'A coding agent will be given the PROMPT below. Judge whether executing it would ' +
    'plausibly resolve the GitHub ISSUE below. First line: exactly one word — ' +
    'likely, partial, or unlikely. Then up to three short bullet points naming what ' +
    'the prompt misses or should double-check. Judge only from the text given.\n\n' +
    `ISSUE #${String(issue.number)}: ${issue.title}\n${issue.body.slice(0, 4000)}\n\n` +
    `PROMPT:\n${note.body.slice(0, 4000)}`
  const { text, usage } = await completeTextWithUsage(provider, ask, FIT_TIMEOUT_MS)
  if (usage.inputTokens || usage.outputTokens) {
    recordUsageEvent({
      model,
      source: 'small-tasks',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  const verdict = parseFitVerdict(text)
  if (!verdict) throw new Error('The model returned no verdict — try again.')
  updateKnowledgeNote(id, { fields: { ...note.fields, fit: verdict } })
  const detail = text.trim().split('\n').slice(1).join('\n').trim()
  return { verdict, detail }
}
