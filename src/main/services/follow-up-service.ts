import type {
  FollowUpAction,
  FollowUpContext,
  FollowUpSuggestion,
  PrWorkspaceContext,
} from '@shared/follow-ups/types.ts'
import type {
  PluginFollowUpAction,
  PluginFollowUpCondition,
} from '@copse/agent/plugins/plugin-manifest.ts'
import {
  MODEL_FOLLOW_UP_PRESETS,
  buildChangesSuggestion,
  buildContinuePlanSuggestion,
  buildCreatePrSuggestion,
  buildDebugCiSuggestion,
  buildFixMergeConflictsSuggestion,
} from '@shared/follow-ups/presets.ts'
import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { getSetting } from './storage/settings.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { CI_INVESTIGATOR_PLUGIN_ID } from '@copse/agent/plugins/ci-investigator-plugin.ts'
import { MODEL_COMPARISON_FOLLOW_UP_ID } from '@copse/agent/plugins/model-comparison-plugin.ts'
import { getPrWorkspaceContext } from './github/pr-context-service.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'

const MAX_SUGGESTIONS = 3

/** Parse a JSON array of preset ids from model output. */
export function parseModelFollowUpIds(raw: string): string[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  const parsed = safeJsonParse(jsonMatch[0])
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean)
}

async function pickModelFollowUps(context: FollowUpContext): Promise<FollowUpSuggestion[]> {
  const provider = await resolveSmallTasksProvider()
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
    const model = resolveSmallTasksModelId()
    const { text: out, usage } = await completeTextWithUsage(provider, prompt, 15_000)
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'small-tasks',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
    }
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

/** Whether the workspace satisfies a plugin bubble's declared `when` condition. */
export function pluginFollowUpConditionMet(
  when: PluginFollowUpCondition,
  ctx: Pick<PrWorkspaceContext, 'changeStats'>,
): boolean {
  switch (when) {
    case 'always':
      return true
    case 'workspace-changes':
      return ctx.changeStats !== null
  }
}

/** The host action a plugin's declared action maps to on the rendered bubble. */
function pluginFollowUpAction(action: PluginFollowUpAction): FollowUpAction {
  return action === 'model-compare' ? 'model-compare' : 'prompt'
}

/**
 * Bubbles contributed by enabled plugins, filtered on each decl's `when`.
 * Plugins suggest rather than interrupt: a plugin that wants the user to do something
 * expensive puts a bubble above the composer instead of raising a modal, and the
 * click gets to open a picker rather than only stuffing the composer.
 *
 * A plugin bubble that fails validation here is skipped, not surfaced broken — the
 * registry already rejects a `prompt` decl with no prompt at registration, so
 * this is a belt-and-braces guard for a decl that arrived some other way.
 */
export function buildPluginFollowUps(
  ctx: Pick<PrWorkspaceContext, 'changeStats'>,
): FollowUpSuggestion[] {
  const out: FollowUpSuggestion[] = []
  for (const { followUp } of getDefaultPluginRegistry().activeFollowUps()) {
    if (!pluginFollowUpConditionMet(followUp.when ?? 'always', ctx)) continue
    const action = pluginFollowUpAction(followUp.action ?? 'prompt')
    const prompt = followUp.prompt?.trim() ?? ''
    if (action === 'prompt' && !prompt) continue
    out.push({
      id: followUp.id,
      label: followUp.label,
      action,
      ...(prompt ? { prompt } : {}),
    })
  }
  return out
}

/** Deterministic bubbles: open-plan first, then git/PR facts. Exported for tests. */
export function buildDeterministicFollowUps(
  ctx: Awaited<ReturnType<typeof getPrWorkspaceContext>>,
  context: FollowUpContext,
): FollowUpSuggestion[] {
  const out: FollowUpSuggestion[] = []

  // A plan the turn left unfinished is a fact about the run itself, so it
  // outranks even git/PR state — the user's most likely next move is resuming
  // that item, and the pre-review continuation gate has already had its chance
  // to reconcile by the time bubbles render.
  if (context.openTodos && context.openTodos.length > 0) {
    const plan = buildContinuePlanSuggestion(context.openTodos)
    out.push({ id: plan.id, label: plan.label, prompt: plan.prompt })
  }

  if (ctx.changeStats) {
    const changes = buildChangesSuggestion(ctx.changeStats)
    out.push({
      id: changes.id,
      label: changes.label,
      prompt: changes.prompt,
      action: 'open-changes',
      variant: 'changes',
      additions: changes.additions,
      deletions: changes.deletions,
    })
  }

  // Directly after the changeset chip: "here is what changed" → "put it up for
  // review" is the order the work actually happens in.
  if (ctx.canOpenPr) {
    const createPr = buildCreatePrSuggestion()
    out.push({ id: createPr.id, label: createPr.label, action: 'create-pr' })
  }

  if (ctx.hasOpenPr && ctx.hasCiFailures) {
    // Point the follow-up at the investigate_ci subagent tool only when the
    // `copse.ci-investigator` plugin is enabled (the same gate that registers the
    // tool); otherwise fall back to the generic "Debug CI Failure" prompt.
    const ci = buildDebugCiSuggestion(
      getDefaultPluginRegistry().isEnabled(CI_INVESTIGATOR_PLUGIN_ID),
    )
    out.push({ id: ci.id, label: ci.label, prompt: ci.prompt })
  }

  if (ctx.hasOpenPr && ctx.hasMergeConflicts) {
    const conflicts = buildFixMergeConflictsSuggestion()
    out.push({ id: conflicts.id, label: conflicts.label, prompt: conflicts.prompt })
  }

  return out
}

/**
 * Fixed suggestions for e2e / headless screenshot validation (no LM Studio or gh
 * required). Includes the model-comparison bubble unconditionally — the fixture
 * exists so a spec can drive each bubble kind without standing up the plugin
 * registry and a dirty worktree, which is exactly what the real gates need.
 */
export function mockFollowUpSuggestions(): FollowUpSuggestion[] {
  const changes = buildChangesSuggestion({ additions: 1, deletions: 1 })
  const ci = buildDebugCiSuggestion()
  const plan = buildContinuePlanSuggestion(['Run the test suite'])
  const createPr = buildCreatePrSuggestion()
  return [
    {
      id: changes.id,
      label: changes.label,
      prompt: changes.prompt,
      action: 'open-changes',
      variant: 'changes',
      additions: changes.additions,
      deletions: changes.deletions,
    },
    { id: createPr.id, label: createPr.label, action: 'create-pr' },
    { id: ci.id, label: ci.label, prompt: ci.prompt },
    { id: MODEL_COMPARISON_FOLLOW_UP_ID, label: 'Compare models', action: 'model-compare' },
    // Present so the continue-plan bubble kind is drivable headlessly; the real
    // gate needs a thread whose persisted plan has open items.
    { id: plan.id, label: plan.label, prompt: plan.prompt },
  ]
}

/** Build follow-up bubbles: deterministic PR/git signals first, then model picks. */
export async function suggestFollowUps(
  context: FollowUpContext,
  root: string | null = getWorkspaceRoot(),
): Promise<FollowUpSuggestion[]> {
  if (
    process.env['COPSE_PANEL_MOCK_FOLLOW_UPS'] === '1' ||
    getSetting<boolean>('mockFollowUps', false)
  ) {
    return mockFollowUpSuggestions()
  }
  const workspaceCtx = await getPrWorkspaceContext(root)
  const prioritized = [
    ...buildDeterministicFollowUps(workspaceCtx, context),
    ...buildPluginFollowUps(workspaceCtx),
  ]
  return fillFollowUpSuggestions(prioritized, () => pickModelFollowUps(context))
}

/** Only ask the model when its suggestions can occupy a visible slot. */
export async function fillFollowUpSuggestions(
  prioritized: readonly FollowUpSuggestion[],
  pickModel: () => Promise<FollowUpSuggestion[]>,
): Promise<FollowUpSuggestion[]> {
  // Facts outrank plugin offers, which outrank model picks. Deduplicate before
  // deciding whether there is room, so repeated ids do not consume a slot.
  const seen = new Set<string>()
  const merged: FollowUpSuggestion[] = []
  const append = (suggestions: readonly FollowUpSuggestion[]): void => {
    for (const suggestion of suggestions) {
      if (merged.length >= MAX_SUGGESTIONS) break
      if (seen.has(suggestion.id)) continue
      seen.add(suggestion.id)
      merged.push(suggestion)
    }
  }
  append(prioritized)
  if (merged.length < MAX_SUGGESTIONS) append(await pickModel())
  return merged
}
