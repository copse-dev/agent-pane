import type { LLMProvider } from '@shared/llm/types.ts'
import type { LLMMessage } from '@shared/types'
import type { FollowUpContext, FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import {
  MODEL_FOLLOW_UP_PRESETS,
  buildChangesSuggestion,
  buildDebugCiSuggestion,
  buildFixMergeConflictsSuggestion,
} from '@shared/follow-ups/presets.ts'
import { createProvider, createLMStudioProvider } from '@shared/llm/create-provider.ts'
import { getSetting, getApiKey } from './settings.ts'
import { fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { getPrWorkspaceContext } from './pr-context-service.ts'

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'

async function fetchFirstLocalModel(baseURL: string): Promise<string | null> {
  const result = await fetchLmStudioModelsCached(baseURL, lmStudioKey())
  return result.models[0]?.id ?? null
}

function lmStudioKey(): string {
  return getApiKey('lmstudio') ?? 'lm-studio'
}

async function buildCloudProvider(model: string): Promise<LLMProvider> {
  if (process.env.AGENT_WINDOW_MOCK_LLM === '1') return createProvider(model)
  const anthropic = getApiKey('anthropic') ?? process.env.ANTHROPIC_API_KEY
  const openai = getApiKey('openai') ?? process.env.OPENAI_API_KEY
  if (model.startsWith('claude') && anthropic)
    return createProvider(model, { anthropicApiKey: anthropic })
  if (model.startsWith('gpt') && openai) return createProvider(model, { openAiApiKey: openai })
  if (anthropic) return createProvider(model, { anthropicApiKey: anthropic })
  if (openai) return createProvider(model, { openAiApiKey: openai })
  return createProvider(model)
}

const MAX_SUGGESTIONS = 3

async function completeText(provider: LLMProvider, prompt: string): Promise<string> {
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  let out = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    for await (const chunk of provider.stream(messages, [], controller.signal)) {
      if (chunk.type === 'text') out += chunk.text
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

async function resolveSmallTaskProvider(): Promise<LLMProvider | null> {
  const useLmStudio = getSetting<boolean>('lmStudioForSmallTasks', true)
  const lmUrl = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)

  if (useLmStudio && lmUrl) {
    const configured =
      getSetting<string>('lmStudioSmallTasksModel', '').trim() ||
      getSetting<string>('lmStudioModel', '').trim()
    const model = configured || (await fetchFirstLocalModel(lmUrl))
    if (model) return createLMStudioProvider(lmUrl, model, lmStudioKey())
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    return buildCloudProvider(getSetting<string>('model', 'claude-sonnet-4-6'))
  }
  return null
}

/** Parse a JSON array of preset ids from model output. */
export function parseModelFollowUpIds(raw: string): string[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function pickModelFollowUps(context: FollowUpContext): Promise<FollowUpSuggestion[]> {
  const provider = await resolveSmallTaskProvider()
  if (!provider) return []

  const presetLines = MODEL_FOLLOW_UP_PRESETS.map((p) => `- ${p.id}: ${p.label}`).join('\n')
  const toolSummary =
    context.toolNames.length > 0 ? `\nTools used: ${context.toolNames.join(', ')}` : ''

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

/** Build follow-up bubbles: deterministic PR/git signals first, then model picks. */
export async function suggestFollowUps(context: FollowUpContext): Promise<FollowUpSuggestion[]> {
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
