import type { ClassifierQuestion } from '@copse/llm/classifiers/types.ts'
import { resolveIssueRef } from '@shared/git/issue-ref.ts'
import { parseFitVerdict, type RoadmapFit } from '@shared/roadmap/fit.ts'
import { resolveSmallTasksRoute } from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { getKnowledgeNote, updateKnowledgeNote } from './storage/knowledge-store.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { resolveGitHubBackend } from './github/backend/backend.ts'
import { getGithubRepoSlug } from './github/git-service.ts'
import {
  askClassifierBatch,
  judgeWithReasoning,
  likeliestChoice,
} from './classifiers/background-classification.ts'

/**
 * On-demand fit check (issue #556 follow-up): would executing a roadmap
 * item's prompt plausibly resolve its pinned GitHub issue? Advisory only,
 * triggered by an explicit pane action, never on save. The classifier chosen
 * for background questions gives the verdict when it answers; the small-tasks
 * model, asked at the same time, gives the reasoning (and the verdict when no
 * classifier answers). No heuristic fallback (same as complexity): a keyword
 * match cannot judge fit, so without either the check reports why instead.
 *
 * The verdict is stamped into the note's `fit` frontmatter field and the
 * reasoning into `fitDetail` (bullets flattened to one bounded line —
 * frontmatter scalars stay short), so both survive closing the pane.
 */

const FIT_TIMEOUT_MS = 30_000

/** The fit verdicts, least hopeful first: a classifier tie goes to the earlier one. */
const FIT_BY_CAUTION = ['unlikely', 'partial', 'likely'] as const satisfies readonly RoadmapFit[]

const FIT_QUESTION: ClassifierQuestion = {
  type: 'choice',
  instructions:
    'A coding agent will be given the PROMPT in this text. Would carrying it out plausibly ' +
    'resolve the GitHub ISSUE? Judge only from the text given.',
  options: {
    unlikely: 'carrying out the prompt would not resolve the issue',
    partial: 'it would address part of the issue but leave meaningful work undone',
    likely: 'carrying out the prompt would plausibly resolve the issue',
  },
}

/** The fit verdict from the chosen classifier connection, or null when none answers. */
export async function classifyRoadmapFit(
  evidence: string,
  ask: typeof askClassifierBatch = askClassifierBatch,
): Promise<RoadmapFit | null> {
  const results = await ask([{ state: evidence, questions: { fit: FIT_QUESTION } }], {
    timeoutMs: FIT_TIMEOUT_MS,
  })
  return likeliestChoice(FIT_BY_CAUTION, results?.[0]?.answers['fit'])?.choice ?? null
}

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

  const evidence =
    `ISSUE #${String(issue.number)}: ${issue.title}\n${issue.body.slice(0, 4000)}\n\n` +
    `PROMPT:\n${note.body.slice(0, 4000)}`
  const ask =
    'A coding agent will be given the PROMPT below. Judge whether executing it would ' +
    'plausibly resolve the GitHub ISSUE below. First line: exactly one word — ' +
    'likely, partial, or unlikely. Then up to three short bullet points naming what ' +
    'the prompt misses or should double-check. Judge only from the text given.\n\n' +
    evidence
  const { verdict, detail } = await judgeWithReasoning(
    () => classifyRoadmapFit(evidence),
    async () => {
      const route = await resolveSmallTasksRoute()
      if (!route) {
        throw new Error('No model available for the fit check — configure a small-tasks model.')
      }
      const { text, usage } = await completeTextWithUsage(route.provider, ask, FIT_TIMEOUT_MS)
      if (usage.inputTokens || usage.outputTokens) {
        recordUsageEvent({
          model: route.model,
          source: 'small-tasks',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        })
      }
      return text
    },
    parseFitVerdict,
    (text) => text.trim().split('\n').slice(1).join('\n').trim(),
  )
  const flatDetail = detail
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .join(' • ')
    .slice(0, 600)
  // Re-read after the model calls: spreading the entry snapshot would undo any
  // field written while the check ran (e.g. a background complexity stamp,
  // stampRoadmapComplexity), and the verdict judged the entry prompt/issue —
  // if either changed mid-flight the newer save owns the fit fields, so the
  // stale verdict is dropped (still returned for the transient pane text).
  const fresh = getKnowledgeNote(id)
  if (fresh && fresh.body === note.body && fresh.fields['issue'] === ref) {
    // A verdict without reasoning (only the classifier answered, or the model gave
    // just the verdict line) must not keep an earlier run's reasoning beside it.
    const fields = Object.fromEntries(
      Object.entries(fresh.fields).filter(([key]) => key !== 'fitDetail'),
    )
    updateKnowledgeNote(id, {
      fields: {
        ...fields,
        fit: verdict,
        ...(flatDetail ? { fitDetail: flatDetail } : {}),
      },
    })
  }
  return { verdict, detail }
}
