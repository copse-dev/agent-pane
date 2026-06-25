import type { LLMProvider } from '@shared/llm/types.ts'
import type { LLMMessage } from '@shared/types'
import type { FollowUpContext, FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import {
  MODEL_FOLLOW_UP_PRESETS,
  buildChangesSuggestion,
  buildDebugCiSuggestion,
  buildFixMergeConflictsSuggestion,
} from '@shared/follow-ups/presets.ts'
import { resolveSmallTasksProvider } from './small-tasks-provider.ts'
import { getSetting } from './settings.ts'
import { getPrWorkspaceContext } from './pr-context-service.ts'
import { safeJsonParse } from '@shared/safe-json.ts'

const MAX_SUGGESTIONS = 3

async function completeText(provider: LLMProvider, prompt: string): Promise<string> {
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  let out = ''
  // Bound the stream with a self-cleaning timeout signal instead of a manual
  // AbortController + setTimeout + clearTimeout. On timeout the stream throws,
  // which the caller already treats as "no suggestions".
  for await (const chunk of provider.stream(messages, [], AbortSignal.timeout(15_000))) {
    if (chunk.type === 'text') out += chunk.text
  }
  return out
}

/** Parse a JSON array of preset ids from model output. */
export function parseModelFollowUpIds(raw: string): string[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  const parsed = safeJsonParse(jsonMatch[0])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean)
}

async function pickModelFollowUps(context: FollowUpContext): Promise<FollowUpSuggestion[]> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return []

  const presetLines = MODEL_FOLLOW_UP_PRESETS.map((p) => `- ${p.id}: ${p.label}`).join('\n')
  const toolSummary =
    (context.toolNames ?? []).length > 0
      ? `\nTools used: ${(context.toolNames ?? []).join(', ')}`
      : ''

  const prompt =
    'You suggest follow-up actions after an AI coding assistant finishes a turn.\n' +
    'Pick 0-2 preset ids that are obviously relevant to this exchange. ' +
    'Return ONLY a JSON array of id strings, e.g. ["run-tests"]. ' +
    'Return [] if nothing is clearly useful.\n\n' +
    'Presets:\n' +
    presetLines +
    '\n\nUser:\n' +
    context.userMessage.slice(0, 800) +
    '\n\nAssistant:\n' +
    context.assistantMessage.slice(0, 1200) +
    toolSummary

  try {
    const out = await completeText(provider, prompt)
    const ids = parseModelFollowUpIds(out)
    const seen = new Set<string>()
    const suggestions: FollowUpSuggestion[] = []
    for (const id of ids) {
      if (seen.has(id)) continue
      const preset = MODEL_FOLLOW_UP_PRESETS.find((p) => p.id === id)
      if (!preset) continue
      seen.add(id)
      suggestions.push({ id: preset.id, label: preset.label, prompt: preset.prompt })
      if (suggestions.length >= 2) break
    }
    return suggestions
  } catch {
    return []
  }
}

function buildDeterministicFollowUps(
  ctx: Awaited<ReturnType<typeof getPrWorkspaceContext>>,
): FollowUpSuggestion[] {
  const out: FollowUpSuggestion[] = []

  if (ctx.changeStats) {
    const changes = buildChangesSuggestion(ctx.changeStats)
    out.push({
      id: changes.id,
      label: changes.label,
      prompt: changes.prompt,
      variant: 'changes',
      additions: changes.additions,
      deletions: changes.deletions,
    })
  }

  if (ctx.hasOpenPr && ctx.hasCiFailures) {
    const ci = buildDebugCiSuggestion()
    out.push({ id: ci.id, label: ci.label, prompt: ci.prompt })
  }

  if (ctx.hasOpenPr && ctx.hasMergeConflicts) {
    const conflicts = buildFixMergeConflictsSuggestion()
    out.push({ id: conflicts.id, label: conflicts.label, prompt: conflicts.prompt })
  }

  return out
}

/** Fixed suggestions for e2e / headless screenshot validation (no LM Studio or gh required). */
export function mockFollowUpSuggestions(): FollowUpSuggestion[] {
  const changes = buildChangesSuggestion({ additions: 1, deletions: 1 })
  const ci = buildDebugCiSuggestion()
  return [
    {
      id: changes.id,
      label: changes.label,
      prompt: changes.prompt,
      variant: 'changes',
      additions: changes.additions,
      deletions: changes.deletions,
    },
    { id: ci.id, label: ci.label, prompt: ci.prompt },
  ]
}

/** Build follow-up bubbles: deterministic PR/git signals first, then model picks. */
export async function suggestFollowUps(context: FollowUpContext): Promise<FollowUpSuggestion[]> {
  if (
    process.env.COPSE_PANEL_MOCK_FOLLOW_UPS === '1' ||
    getSetting<boolean>('mockFollowUps', false)
  ) {
    return mockFollowUpSuggestions()
  }
  const workspaceCtx = await getPrWorkspaceContext()
  const deterministic = buildDeterministicFollowUps(workspaceCtx)
  const modelPicks = await pickModelFollowUps(context)

  const seen = new Set(deterministic.map((s) => s.id))
  const merged = [...deterministic]
  for (const suggestion of modelPicks) {
    if (seen.has(suggestion.id)) continue
    seen.add(suggestion.id)
    merged.push(suggestion)
    if (merged.length >= MAX_SUGGESTIONS) break
  }

  return merged.slice(0, MAX_SUGGESTIONS)
}
