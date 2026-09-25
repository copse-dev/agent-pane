import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { parseClassification, type ClassificationResult } from './safety-classification-parse.ts'
import { classifyShellScopeWithClassifier } from './safety-classifier-profile.ts'
import { screenWithSafetyModel } from './safety-screening.ts'

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

function shellScopePayload(command: string): {
  tool: string
  command: string
  workspace_root: string | null
  sandbox_enabled: boolean
  sandbox_rules: Record<string, string>
} {
  return {
    tool: 'run_shell',
    command,
    workspace_root: getWorkspaceRoot(),
    sandbox_enabled: isProjectSandboxEnabled(),
    sandbox_rules: {
      network: 'denied',
      filesystem_read: 'workspace only',
      filesystem_write: 'workspace only',
    },
  }
}

export async function classifyShellScope(command: string): Promise<ClassificationResult | null> {
  const payload = shellScopePayload(command)
  const { verdict } = await screenWithSafetyModel({
    systemPrompt: SYSTEM_PROMPT,
    content: JSON.stringify(payload),
    parse: parseClassification,
    withClassifier: (id) => classifyShellScopeWithClassifier(id, payload),
  })
  return verdict
}
