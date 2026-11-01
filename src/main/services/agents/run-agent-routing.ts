import type { AgentRoleId } from '@copse/llm/agent-roles.ts'
import { intellectBand, modelIntellect, type IntellectBand } from '@copse/llm/model-intellect.ts'
import type { FrontierPoint } from '@copse/llm/pareto-frontier.ts'
import { hostRoutedNamespace } from '@copse/llm/model-selection.ts'
import type { RunAgentRequest } from '../../tools/run-agent-tool.ts'
import { classifyModelForTask, suggestRoleForTask } from '../providers/model-classifier.ts'
import { routableFrontierPoints, toRoutableModelId } from '../providers/best-value-model.ts'
import { resolveDynamicModelId } from '../providers/dynamic-model.ts'
import { getRoleModels, routedModelSetting } from '../providers/role-models.ts'
import { getSettingTrimmed } from '../storage/settings.ts'
import { assertWorkflowRouteAvailable } from '../providers/workflow-route-availability.ts'

const BAND_ORDER: Record<IntellectBand, number> = { low: 0, mid: 1, top: 2 }

/** Choose the cheapest callable candidate meeting the requested capability floor. */
export function pickAgentRoute(pool: readonly FrontierPoint[], band: IntellectBand): string {
  const candidates = pool.filter(
    (point) =>
      !point.discovery &&
      hostRoutedNamespace(toRoutableModelId(point)) === null &&
      !point.id.endsWith(':batch') &&
      BAND_ORDER[intellectBand(point.intellect)] >= BAND_ORDER[band],
  )
  candidates.sort(
    (a, b) =>
      a.costPerMTok - b.costPerMTok || b.intellect - a.intellect || a.id.localeCompare(b.id),
  )
  const candidate = candidates[0]
  if (!candidate)
    throw new Error(
      `No available callable model meets the ${band} intelligence requirement. Configure a task-role model or another provider in Settings.`,
    )
  return toRoutableModelId(candidate)
}

export interface RunAgentRoute {
  role: AgentRoleId
  requestedIntelligence: RunAgentRequest['intelligence']
  intelligence: IntellectBand
  model: string
  actualIntelligence: IntellectBand | null
  source: 'settings' | 'matched'
  warning?: string
}

export async function resolveRunAgentRoute(request: RunAgentRequest): Promise<RunAgentRoute> {
  const role =
    request.task_type === 'match' ? suggestRoleForTask(request.task).role : request.task_type
  const band =
    request.intelligence === 'match'
      ? classifyModelForTask({
          task: request.task,
          contextTokensEstimate: Math.ceil(request.context.length / 4),
          agentic: request.tools.length > 0,
        }).band
      : request.intelligence
  // Protected review/safety settings retain their existing ownership.
  const assigned =
    role === 'reviewer'
      ? getSettingTrimmed('reviewModel')
      : role === 'safety'
        ? getSettingTrimmed('safetyModel')
        : role === 'small-tasks'
          ? routedModelSetting('smallTasksModel')
          : role === 'research'
            ? routedModelSetting('subagentModel')
            : role === 'advisor'
              ? routedModelSetting('advisorModel')
              : role === 'coder'
                ? routedModelSetting('localDefaultModel')
                : (getRoleModels()[role]?.trim() ?? '')
  const model = assigned
    ? await resolveDynamicModelId(assigned, { callableOnly: true })
    : pickAgentRoute(await routableFrontierPoints({ callableOnly: true }), band)
  await assertWorkflowRouteAvailable(model)
  const score = modelIntellect(model)
  const actualBand = score === null ? null : intellectBand(score)
  const warning =
    actualBand === null
      ? 'The selected model has no measured intellect band.'
      : BAND_ORDER[actualBand] < BAND_ORDER[band]
        ? `The configured model is in the ${actualBand} band, below the requested ${band} band; the Settings assignment takes precedence.`
        : undefined
  return {
    role,
    requestedIntelligence: request.intelligence,
    intelligence: band,
    model,
    actualIntelligence: actualBand,
    source: assigned ? 'settings' : 'matched',
    ...(warning ? { warning } : {}),
  }
}
