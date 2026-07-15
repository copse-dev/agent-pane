import {
  parseComplexityWord,
  bandToComplexity,
  type RoadmapComplexity,
} from '@shared/roadmap/complexity.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { classifyModelForTask } from './providers/model-classifier.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'

/**
 * One-shot complexity classification for a roadmap prompt, run when the prompt
 * is saved (create/update and issue import — explicit actions only, never
 * ambient). Prefers the configured small-tasks model (the local default used
 * for titles/summaries); a short timeout plus the pure heuristic classifier
 * (#557) as fallback bound how long a save can wait, so persistence never
 * hinges on a model being up.
 */

const CLASSIFY_TIMEOUT_MS = 10_000

function heuristicComplexity(prompt: string): RoadmapComplexity {
  return bandToComplexity(classifyModelForTask({ task: prompt }).band)
}

export async function classifyRoadmapComplexity(prompt: string): Promise<RoadmapComplexity> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return heuristicComplexity(prompt)
  const model = resolveSmallTasksModelId()
  const ask =
    'Classify the complexity of the following coding task as exactly one word — ' +
    'low (small mechanical change, one file, clear steps), ' +
    'medium (a feature or fix touching a few files), or ' +
    'high (cross-cutting refactor, new subsystem, or open-ended design work). ' +
    'Reply with ONLY the word.\n\nTask:\n' +
    prompt.slice(0, 2000)
  try {
    const { text, usage } = await completeTextWithUsage(provider, ask, CLASSIFY_TIMEOUT_MS)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'small-tasks',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
    return parseComplexityWord(text) ?? heuristicComplexity(prompt)
  } catch {
    return heuristicComplexity(prompt)
  }
}
