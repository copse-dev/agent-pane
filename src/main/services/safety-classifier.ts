import { getSetting, getLmStudioApiKey } from './settings.ts'
import { LM_STUDIO_MODEL_IDS, DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import { getWorkspaceRoot } from './workspace.ts'

export interface ClassificationResult {
  scope: 'sandbox' | 'external'
  confidence: number
  reason: string
}

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

function lmStudioKey(): string {
  return getLmStudioApiKey()
}

function parseClassification(text: string): ClassificationResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      scope?: string
      confidence?: number
      reason?: string
    }
    if (parsed.scope !== 'sandbox' && parsed.scope !== 'external') return null
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
    if (!reason) return null
    return { scope: parsed.scope, confidence, reason }
  } catch {
    return null
  }
}

async function resolveSafetyModel(url: string): Promise<string | null> {
  const configured = getSetting<string>('safetyModel', LM_STUDIO_MODEL_IDS.safety).trim()
  if (configured) return configured
  const fallback = getSetting<string>('localDefaultModel', LM_STUDIO_MODEL_IDS.chat).trim()
  if (fallback) return fallback
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${lmStudioKey()}` },
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return json.data?.[0]?.id ?? null
  } catch {
    return null
  }
}

export async function classifyShellScope(command: string): Promise<ClassificationResult | null> {
  if (!getSetting<boolean>('safetyClassifierEnabled', true)) return null

  const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
  const model = await resolveSafetyModel(url)
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

  const base = url.replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lmStudioKey()}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = json.choices?.[0]?.message?.content ?? ''
    return parseClassification(content)
  } catch {
    return null
  }
}
