import { RequestError } from '@agentclientprotocol/sdk'
import { acpReauthCommand, KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import { errorMessage } from '@shared/errors.ts'
import { expectRecord, isRecord } from '@shared/unknown-value.ts'
import { IMAGE_INPUT_UNSUPPORTED_MESSAGE } from '@shared/image-input-support.ts'

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
      const body = expectRecord(JSON.parse(raw.slice(brace)) as unknown)
      const detail = expectRecord(
        body['error'] && typeof body['error'] === 'object' ? body['error'] : body,
      )
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
    isRecord(err) &&
    typeof err['code'] === 'number' &&
    Number.isInteger(err['code']) &&
    typeof err['message'] === 'string'
  )
}

/** Walk `Error.cause` chains to find an ACP `RequestError` (or equivalent). */
function findJsonRpcError(err: unknown): JsonRpcError | null {
  let current: unknown = err
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (current instanceof RequestError || isJsonRpcError(current)) {
      const rpc: JsonRpcError = current
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
  return label
    ? `ACP error ${String(code)} (${label}): ${message}`
    : `ACP error ${String(code)}: ${message}`
}

function formatErrorData(data: unknown): string | null {
  if (data == null) return null
  if (typeof data === 'string') {
    const trimmed = data.trim()
    return trimmed || null
  }
  if (isRecord(data)) {
    const record = data
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
  if (typeof data === 'number' || typeof data === 'boolean' || typeof data === 'bigint') {
    return String(data)
  }
  return null
}

/**
 * Why an ACP turn could not authenticate. `required` is "this agent has never
 * been signed in / its key was refused"; `expired` is "it *was* signed in and
 * the stored credential lapsed" — a different user fix (sign in again) and the
 * only one that says so, which is why the two are not collapsed.
 */
export type AcpAuthFailureKind = 'required' | 'expired'

/**
 * A lapsed credential, however the agent words it. Agents rarely use the ACP
 * `auth_required` code for this — Claude's adapter reports an expired OAuth
 * token as a generic `-32603 Internal error` whose *message* carries the real
 * cause — so the text is the signal.
 */
const EXPIRED_AUTH_RE =
  /re-?authenticat|(?:token|session|login|credentials?|subscription)\s+(?:has\s+|have\s+)?expired|expired\s+(?:oauth\s+|access\s+|refresh\s+|api\s+)?(?:token|session|credentials?)/i

/** Auth failures that are not specifically an expiry (never signed in, key refused). */
const AUTH_FAILURE_RE =
  /authentication[\s_-]*(?:required|failed|error)|failed to authenticate|not (?:logged in|authenticated)|unauthenticated|invalid api key|\/login\b/i

/** Every string an agent might have hidden the auth signal in, joined for matching. */
function authSignalText(rpc: JsonRpcError | null, detail: string): string {
  const data = rpc ? formatErrorData(rpc.data) : null
  return [rpc?.message ?? '', detail, data ?? ''].join('\n')
}

/**
 * Classify an ACP turn failure as a credentials problem, and say which kind.
 * Returns `null` when the failure is something else.
 *
 * Without an `acpAgentId` only the unambiguous ACP `auth_required` code counts:
 * the text heuristics below would otherwise mislabel an ordinary provider 401
 * (whose fix is Copse's own key settings, not an external agent's login).
 */
export function classifyAcpAuthFailure(
  err: unknown,
  ctx?: ClassifyAgentErrorContext,
): AcpAuthFailureKind | null {
  const rpc = findJsonRpcError(err)
  if (!ctx?.acpAgentId) return rpc?.code === -32000 ? 'required' : null

  const { status, type, message } = parseProviderError(err)
  const text = authSignalText(rpc, message ?? errorMessage(err))

  // Expiry wins over the generic signals: an expired token also reports
  // "Failed to authenticate", and only the expiry reading names the right fix.
  if (EXPIRED_AUTH_RE.test(text)) return 'expired'
  if (rpc?.code === -32000) return 'required'
  if (AUTH_FAILURE_RE.test(text)) return 'required'
  if (status === 401 || type === 'authentication_error' || text.includes('Unauthorized'))
    return 'required'
  return null
}

/**
 * Where to configure the agent's credentials instead of running its login
 * command. Names the agent rather than a settings sub-path: Providers groups
 * agents under their vendor chip (Claude sits under Anthropic), and that mapping
 * lives in the renderer — repeating it here would be a second copy to rot.
 */
function acpEnvHint(known: { title: string; envHints?: string[] } | undefined): string {
  if (!known?.envHints || known.envHints.length === 0) return ''
  const variables = known.envHints.map((name) => `\`${name}\``).join(' or ')
  return `Alternatively, set ${variables} for ${known.title} in Settings → General → Providers.`
}

/** The agent's own words, kept verbatim below the guidance rather than leading with it. */
function acpAgentReport(rpc: JsonRpcError | null): string | null {
  if (!rpc) return null
  const dataDetail = formatErrorData(rpc.data)
  const report = formatJsonRpcErrorCode(rpc.code, rpc.message)
  return dataDetail ? `${report}\nDetails: ${dataDetail}` : report
}

/** Fence opaque agent diagnostics without trusting them to be Markdown. */
function markdownCodeBlock(value: string): string {
  const backtickRuns = value.match(/`+/g) ?? []
  const longestRun = backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 2)
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}text\n${value}\n${fence}`
}

function acpAuthNotice(agentName: string, kind: AcpAuthFailureKind): string {
  const title =
    kind === 'expired' ? `${agentName} sign-in expired` : `${agentName} needs authentication`
  const explanation =
    kind === 'expired'
      ? `This turn couldn’t run because ${agentName}’s saved credentials are no longer valid.`
      : `This turn couldn’t run because ${agentName} is not signed in.`
  return `> [!WARNING]\n> **${title}**\n>\n> ${explanation}`
}

function acpAuthSteps(command: string | null): string {
  if (!command) {
    return [
      '**To continue**',
      '',
      '1. Run the agent’s login command.',
      '2. Finish signing in, then re-send your message.',
    ].join('\n')
  }
  return [
    '**To continue**',
    '',
    `1. Run \`${command}\` in a terminal.`,
    '2. Finish signing in, then re-send your message.',
  ].join('\n')
}

function acpTechnicalDetails(rpc: JsonRpcError | null): string | null {
  const report = acpAgentReport(rpc)
  if (!report) return null
  return `**Technical details**\n\n${markdownCodeBlock(report)}`
}

const ACP_KEYS_NOT_FORWARDED =
  '> Copse’s built-in provider credentials are not automatically shared with external agents. Configure credentials for the agent itself.'

function formatAcpAuthError(
  rpc: JsonRpcError | null,
  kind: AcpAuthFailureKind,
  agentId?: string,
): string {
  const known = agentId ? KNOWN_ACP_AGENTS.find((agent) => agent.id === agentId) : undefined
  const agentName = known?.title ?? agentId ?? 'The external agent'

  // An expired credential is a *different* message: the agent is configured and
  // was working, so install/first-run guidance would send the user the wrong
  // way. Lead with the one action that fixes it, and keep the raw ACP code
  // (often an unhelpful `-32603 Internal error`) below the fold.
  if (kind === 'expired') {
    const reauth = acpReauthCommand(known)
    return [
      acpAuthNotice(agentName, kind),
      acpAuthSteps(reauth),
      acpEnvHint(known),
      ACP_KEYS_NOT_FORWARDED,
      acpTechnicalDetails(rpc),
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
  }

  return [
    acpAuthNotice(agentName, kind),
    acpAuthSteps(known?.setup ?? null),
    acpEnvHint(known),
    ACP_KEYS_NOT_FORWARDED,
    acpTechnicalDetails(rpc ?? { code: -32000, message: 'Authentication required' }),
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
}

/** Why a provider refused a request, when the cause is credentials or billing. */
export type ProviderAccessFailure = 'auth' | 'credit'

/**
 * Classify a provider failure as a credentials or billing problem — the two
 * cases where re-running the turn on a subscription-billed agent would actually
 * help. Everything else (rate limits, overload, network, bad request) is either
 * transient or unrelated to billing and returns `null`, so a retryable blip
 * never triggers a billing-path switch.
 *
 * Anthropic reports an exhausted balance three different ways depending on the
 * account: `402`, a `403` typed `billing_error`, and a `400 invalid_request_error`
 * whose message names the credit balance — all three are `credit`.
 */
export function classifyProviderAccessFailure(err: unknown): ProviderAccessFailure | null {
  const { status, type, code, message } = parseProviderError(err)
  const detail = message ?? errorMessage(err)

  if (
    status === 402 ||
    code === 'insufficient_quota' ||
    type === 'insufficient_quota' ||
    type === 'billing_error' ||
    /credit balance is too low|billing|out of credit/i.test(detail)
  )
    return 'credit'

  if (
    status === 401 ||
    type === 'authentication_error' ||
    detail.includes('Unauthorized') ||
    // 403 `permission_error` covers a key that is valid but not entitled to the
    // Managed Agents beta — same user fix as a rejected key: sort out the key.
    ((status === 403 || type === 'permission_error') && !/forbidden host/i.test(detail))
  )
    return 'auth'

  return null
}

/** Map provider / local-model failures to user-facing chat text. */
export function classifyAgentError(err: unknown, ctx?: ClassifyAgentErrorContext): string {
  const rpc = findJsonRpcError(err)
  const { status, type, code, message } = parseProviderError(err)
  const raw = errorMessage(err)
  const detail = message ?? raw

  const authFailure = classifyAcpAuthFailure(err, ctx)
  if (authFailure) return formatAcpAuthError(rpc, authFailure, ctx?.acpAgentId)

  // ACP turns never reach here: `classifyAcpAuthFailure` already claimed every
  // credentials failure that carries an agent id, and points at that agent's own
  // login rather than Copse's key settings.
  if (status === 401 || type === 'authentication_error' || detail.includes('Unauthorized')) {
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'
  }

  // OpenAI returns HTTP 429 for both rate limits and exhausted credit, so key
  // out-of-credit off the structured quota signals *before* the 429 check.
  if (status === 402 || code === 'insufficient_quota' || type === 'insufficient_quota')
    return `An error occurred: ${
      message ??
      'Your provider account is out of credit. Add credit or update billing with your provider, then try again.'
    }`

  // OpenRouter routing-policy failure: with ZDR-only routing (Copse's default)
  // or training exclusion active, a model with no compliant endpoint fails
  // deterministically. Point at the toggles rather than surfacing the raw 503.
  if (
    /no available model provider that meets your routing requirements|no endpoints found matching your data policy/i.test(
      detail,
    )
  )
    return 'No provider endpoint satisfies the current OpenRouter privacy routing (zero-data-retention / no-training). Pick another model, or relax the routing toggles in Settings → Providers → OpenRouter.'

  if (
    /no endpoints? (?:were )?found (?:that )?support(?:ing)? image input|does not support image (?:input|prompts?|attachments?)/i.test(
      detail,
    )
  )
    return IMAGE_INPUT_UNSUPPORTED_MESSAGE

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
