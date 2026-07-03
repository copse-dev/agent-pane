import { RequestError } from '@agentclientprotocol/sdk'
import { KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { errorMessage } from '@shared/errors.ts'

/** Optional context so ACP failures can name the agent and its auth steps. */
export interface ClassifyAgentErrorContext {
  acpAgentId?: string
}

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

interface ProviderError {
  status?: number
  type?: string
  code?: string
  message?: string
}

/**
 * Parse a provider failure into structured fields.
 *
 * Provider SDKs (Anthropic / OpenAI) format `APIError.message` as
 * `<status> <raw JSON body>`, e.g.
 * `400 {"type":"error","error":{"type":"…","message":"…"},"request_id":"…"}`.
 * Reading the leading status code and the nested `error` object lets callers
 * classify on structured fields instead of substring-matching the whole blob,
 * and lets the fallback surface the provider's own `message` without the
 * `type`/`request_id` noise.
 */
function parseProviderError(err: unknown): ProviderError {
  const raw = errorMessage(err)
  const parsed: ProviderError = {}
  const status = /^\s*(\d{3})\b/.exec(raw)
  if (status) parsed.status = Number(status[1])
  const brace = raw.indexOf('{')
  if (brace !== -1) {
    try {
      const body = JSON.parse(raw.slice(brace)) as Record<string, unknown>
      const detail = (
        body['error'] && typeof body['error'] === 'object' ? body['error'] : body
      ) as Record<string, unknown>
      if (typeof detail['type'] === 'string') parsed.type = detail['type']
      if (typeof detail['code'] === 'string') parsed.code = detail['code']
      if (typeof detail['message'] === 'string') parsed.message = detail['message'].trim()
    } catch {
      // Not JSON (e.g. local-model / chat-template failures) — leave unset.
    }
  }
  return parsed
}

const ACP_ERROR_CODE_LABELS: Readonly<Record<number, string>> = {
  [-32700]: 'Parse error',
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
  [-32800]: 'Request cancelled',
  [-32000]: 'Authentication required',
  [-32002]: 'Resource not found',
  [-32042]: 'URL elicitation required',
}

function isJsonRpcError(err: unknown): err is JsonRpcError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as JsonRpcError).code === 'number' &&
    Number.isInteger((err as JsonRpcError).code) &&
    typeof (err as JsonRpcError).message === 'string'
  )
}

/** Walk `Error.cause` chains to find an ACP `RequestError` (or equivalent). */
function findJsonRpcError(err: unknown): JsonRpcError | null {
  let current: unknown = err
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (current instanceof RequestError || isJsonRpcError(current)) {
      const rpc = current as JsonRpcError
      return { code: rpc.code, message: rpc.message, data: rpc.data }
    }
    current =
      current instanceof Error && 'cause' in current && current.cause !== undefined
        ? current.cause
        : null
  }
  return null
}

function formatJsonRpcErrorCode(code: number, message: string): string {
  const label = ACP_ERROR_CODE_LABELS[code]
  return label ? `ACP error ${code} (${label}): ${message}` : `ACP error ${code}: ${message}`
}

function formatErrorData(data: unknown): string | null {
  if (data == null) return null
  if (typeof data === 'string') {
    const trimmed = data.trim()
    return trimmed || null
  }
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>
    for (const key of ['message', 'detail', 'details', 'reason'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    try {
      const serialized = JSON.stringify(data)
      return serialized.length <= 240 ? serialized : `${serialized.slice(0, 240)}…`
    } catch {
      return null
    }
  }
  return String(data)
}

function formatAcpAuthError(rpc: JsonRpcError | null, agentId?: string): string {
  const known = agentId ? KNOWN_ACP_AGENTS.find((agent) => agent.id === agentId) : undefined
  const agentName = known?.title ?? agentId ?? 'The external agent'
  const code = rpc?.code ?? -32000
  const message = rpc?.message ?? 'Authentication required'
  const lines = [
    `${agentName} requires authentication before it can run (${formatJsonRpcErrorCode(code, message)}).`,
  ]
  const dataDetail = rpc ? formatErrorData(rpc.data) : null
  if (dataDetail) lines.push(`Details: ${dataDetail}`)
  if (known?.setup) {
    const envHint =
      known.envHints && known.envHints.length > 0
        ? ` Alternatively, set ${known.envHints.join(' or ')} in Settings → ACP agents → ${known.title} → Environment.`
        : ''
    lines.push(`Sign in with \`${known.setup}\`.${envHint}`)
  } else {
    lines.push(
      'Run the agent’s login command or add its required API keys in Settings → ACP agents → Environment for that agent.',
    )
  }
  lines.push(
    'Copse’s built-in provider keys (Settings → Providers) are not passed to external agents — configure auth on the agent itself.',
  )
  return lines.join('\n\n')
}

function isAcpAuthFailure(
  rpc: JsonRpcError | null,
  detail: string,
  ctx?: ClassifyAgentErrorContext,
): boolean {
  if (rpc?.code === -32000) return true
  if (!ctx?.acpAgentId) return false
  return /^Authentication required\b/i.test(detail)
}

/** Map provider / local-model failures to user-facing chat text. */
export function classifyAgentError(err: unknown, ctx?: ClassifyAgentErrorContext): string {
  const rpc = findJsonRpcError(err)
  const { status, type, code, message } = parseProviderError(err)
  const raw = errorMessage(err)
  const detail = message ?? raw

  if (isAcpAuthFailure(rpc, detail, ctx)) return formatAcpAuthError(rpc, ctx?.acpAgentId)

  if (status === 401 || type === 'authentication_error' || detail.includes('Unauthorized')) {
    if (ctx?.acpAgentId) return formatAcpAuthError(rpc, ctx.acpAgentId)
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'
  }

  // OpenAI returns HTTP 429 for both rate limits and exhausted credit, so key
  // out-of-credit off the structured quota signals *before* the 429 check.
  if (status === 402 || code === 'insufficient_quota' || type === 'insufficient_quota')
    return `An error occurred: ${
      message ??
      'Your provider account is out of credit. Add credit or update billing with your provider, then try again.'
    }`

  if (status === 429 || type === 'rate_limit_error' || detail.includes('rate_limit'))
    return 'Rate limit reached. Please wait a moment and try again.'

  // Anthropic 529 / `overloaded_error`. ACP agents surface this as opaque text
  // (e.g. `Internal error: API Error: Overloaded`), so also match the word.
  if (status === 529 || type === 'overloaded_error' || /\boverloaded\b/i.test(detail))
    return 'The model provider is temporarily overloaded. This is transient — wait a moment and try again.'

  if (
    detail.includes('context_length') ||
    detail.includes('context window') ||
    detail.includes('tokens to keep from the initial prompt')
  )
    return 'Conversation too long for the loaded model context. Reload the model in LM Studio with a larger context, start a new thread, or use smaller reads.'

  if (detail.includes('No user query found in messages') || detail.includes('jinja template'))
    return 'The local model prompt template failed after history was trimmed. Reload the model in LM Studio with enough context for the chat template, or use a model with a fixed chat template (e.g. under lmstudio-community).'

  if (rpc && ctx?.acpAgentId) {
    const dataDetail = formatErrorData(rpc.data)
    const suffix = dataDetail ? `\n\nDetails: ${dataDetail}` : ''
    return `An error occurred: ${formatJsonRpcErrorCode(rpc.code, rpc.message)}${suffix}`
  }

  return `An error occurred: ${message ?? raw}`
}
