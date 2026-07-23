import { getSetting, getSettingTrimmed } from '../storage/settings.ts'
import { LM_STUDIO_MODEL_IDS } from '@shared/lm-studio-defaults.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { buildProvider, normalizeRoleModelSelection } from '../providers/provider-selection.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { recordUsageEvent } from '../storage/usage-ledger.ts'
import { parseClassification, type ClassificationResult } from './safety-classification-parse.ts'
import { completeMessagesWithUsage } from '../providers/llm-complete-text.ts'

export type { ClassificationResult } from './safety-classification-parse.ts'
export { parseClassification } from './safety-classification-parse.ts'

const SYSTEM_PROMPT = `You are a sandbox scope classifier for a coding assistant.
Given a shell command and sandbox rules, decide whether the command can run entirely within the project sandbox.

Sandbox rules:
- Filesystem read/write: workspace directory only
- Network: denied
- No access outside the workspace unless explicitly indicated

Reply with JSON only (no markdown):
{"scope":"sandbox"|"external","confidence":0.0-1.0,"reason":"brief explanation"}

Mark as "external" if the command might: use the network, read/write outside the workspace, exfiltrate secrets, modify system config, spawn services reachable from outside, or use MCP/external APIs.
Mark as "sandbox" only when you are confident the command stays within the workspace with no network.
When uncertain, use "external" with lower confidence.`

function resolveSafetyModel(): string {
  return normalizeRoleModelSelection(getSettingTrimmed('safetyModel', LM_STUDIO_MODEL_IDS.safety))
}

export async function classifyShellScope(command: string): Promise<ClassificationResult | null> {
  if (!getSetting<boolean>('safetyClassifierEnabled', true)) return null

  const model = resolveSafetyModel()
  if (!model) return null

  const workspaceRoot = getWorkspaceRoot()
  const payload = {
    tool: 'run_shell',
    command,
    workspace_root: workspaceRoot,
    sandbox_enabled: isProjectSandboxEnabled(),
    sandbox_rules: {
      network: 'denied',
      filesystem_read: 'workspace only',
      filesystem_write: 'workspace only',
    },
  }

  try {
    const provider = await buildProvider(model)
    const { text, usage } = await completeMessagesWithUsage(
      provider,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      FETCH_TIMEOUTS.safetyClassification,
    )
    if (usage.inputTokens || usage.outputTokens) {
      recordUsageEvent({
        model,
        source: 'safety-classifier',
        ...usage,
      })
    }
    return parseClassification(text)
  } catch {
    return null
  }
}
