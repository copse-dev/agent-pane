import type { LLMMessage, UserContent } from '@shared/types'
import { isAcpModel } from '@shared/acp.ts'
import { isLocalModel } from '@copse/llm/estimate-cost.ts'
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import { intellectBand, modelIntellect, topAnnotatedIntellect } from '@copse/llm/model-intellect.ts'

/**
 * Experimental, opt-in "advisor strategy" feature (tracked in
 * https://github.com/jonathanKingston/agent-pane/issues/566).
 *
 * Lets the user nominate a larger, higher-intelligence model as an *advisor*
 * that gives strategic guidance mid-task, while the everyday loop (the
 * "executor") runs on a cheaper/faster — ideally on-device / local — model.
 *
 * This is the **client-side** version of Anthropic's server-side
 * {@link https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool Advisor tool}:
 * we run the advisor sub-inference ourselves so *any* executor (local /
 * OpenAI / OpenRouter / on-device Claude) can consult a large cloud advisor,
 * which the native tool cannot do (it locks the executor to a Claude cloud
 * model). We deliberately mirror the native tool's *contract* — a no-parameter
 * `advisor` tool that is handed the full transcript, results normalized into
 * the native `advisor_result` shape, advisor runs "bare" (no tools) — so that
 * flipping a Claude-cloud executor over to the real `advisor_20260301` server
 * tool later is a drop-in with no behavioural change.
 *
 * This module is pure (no I/O, no settings read). The run-scoped provider call
 * lives in advisor-runner.ts, and the tool gating lives in registry-bootstrap.
 */

export const ADVISOR_STRATEGY_ENABLED_SETTING = 'advisorStrategyEnabled'
export const ADVISOR_MODEL_SETTING = 'advisorModel'

/** Default advisor model when the strategy is enabled (a frontier Claude). */
export const DEFAULT_ADVISOR_MODEL = 'claude-opus-4-8'

/**
 * Advisor sub-inference output cap. Mirrors the native tool's recommended
 * `max_tokens: 2048` (~7x smaller output than uncapped, ~0% truncation in
 * Anthropic's testing). The executor still generates the full deliverable at
 * its own lower rate; the advisor only produces the plan/course-correction.
 */
export const DEFAULT_ADVISOR_MAX_TOKENS = 2048

/**
 * Claude-compatible result shapes. The native tool returns an
 * `advisor_tool_result` whose `content` is a discriminated union:
 * `advisor_result` (plaintext, e.g. Opus) or `advisor_redacted_result`
 * (encrypted, e.g. Fable/Mythos). We normalize the client-side advisor's
 * output into the same union so history round-trips identically.
 */
export interface AdvisorResult {
  type: 'advisor_result'
  text: string
  stop_reason?: string
}

export interface AdvisorRedactedResult {
  type: 'advisor_redacted_result'
  encrypted_content: string
  stop_reason?: string
}

export type AdvisorToolResultContent = AdvisorResult | AdvisorRedactedResult

/** Normalize raw advisor text into the native `advisor_result` shape. */
export function normalizeAdvisorResult(text: string, stopReason?: string): AdvisorResult {
  return {
    type: 'advisor_result',
    text: text.trim(),
    ...(stopReason ? { stop_reason: stopReason } : {}),
  }
}

/**
 * Render an advisor result into the plaintext the executor sees, matching the
 * native tool: on a `max_tokens` stop the API appends a truncation marker so
 * the executor knows the advice was cut short.
 */
export function renderAdvisorResult(content: AdvisorToolResultContent): string {
  if (content.type === 'advisor_redacted_result') {
    // The native server decrypts this into the executor's prompt; client-side
    // we never produce encrypted output, but keep the branch for compatibility.
    return '[Advisor guidance omitted: redacted result.]'
  }
  const truncated = content.stop_reason === 'max_tokens'
  return truncated
    ? `${content.text}\n\n[Advisor output truncated at max_tokens=${String(DEFAULT_ADVISOR_MAX_TOKENS)}.]`
    : content.text
}

/**
 * Native advisor-tool compatibility table (executor -> allowed advisors), taken
 * verbatim from the docs. The advisor must be Claude Sonnet 4.6 or stronger and
 * at least as capable as the executor. We use this only as *advisory* UX: to
 * tell the user when a Claude/Claude pairing would also work with the native
 * server tool, keeping a future native switch clean. The client-side strategy
 * itself imposes no such restriction — the executor can be any model.
 */
const NATIVE_ADVISOR_COMPAT: Record<string, readonly string[]> = {
  'claude-haiku-4-5': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  'claude-sonnet-4-6': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  'claude-sonnet-5': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-opus-4-6': [
    'claude-fable-5',
    'claude-mythos-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
  ],
  'claude-opus-4-7': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-opus-4-8': ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4-7'],
  'claude-fable-5': ['claude-fable-5'],
  'claude-mythos-5': ['claude-mythos-5'],
}

/** True when (executor, advisor) is a valid pair for the native advisor tool. */
export function isNativeAdvisorPair(executorModel: string, advisorModel: string): boolean {
  return NATIVE_ADVISOR_COMPAT[executorModel]?.includes(advisorModel) ?? false
}

export interface AdvisorPairAssessment {
  /** Whether to allow the pairing at all (client-side is permissive). */
  ok: boolean
  /** Whether this pairing would also work with the native `advisor_20260301` tool. */
  native: boolean
  /**
   * Severity for the settings UI: `good` = the pairing the strategy is designed
   * for, `info` = works but nothing special, `warn` = the annotations say the
   * advisor is unlikely to add lift.
   */
  level: 'good' | 'info' | 'warn'
  /** Human-readable note for the settings UI. */
  reason: string
}

/**
 * What the model annotations know about a model's capability: an intellect
 * number for the tracked cloud models (`model-intellect.ts`), sizing for
 * catalogued local models (`local-model-catalog.ts`), or nothing
 * (OpenRouter / ACP / uncatalogued ids).
 */
type CapabilityAnnotation =
  | { kind: 'cloud'; intellect: number }
  | { kind: 'local'; paramsB: number | null }
  | { kind: 'unknown' }

function annotationFor(model: string): CapabilityAnnotation {
  if (isLocalModel(model)) {
    const bareId = model.startsWith('lmstudio:') ? model.slice('lmstudio:'.length) : model
    return { kind: 'local', paramsB: getLocalModelCapability(bareId)?.paramsB ?? null }
  }
  const intellect = modelIntellect(model)
  return intellect !== null ? { kind: 'cloud', intellect } : { kind: 'unknown' }
}

/**
 * Assess an (executor, advisor) pairing for the client-side strategy. Permissive
 * by design — the only pairing we refuse to bless is advising with the *same*
 * model, which buys nothing. Everything else is allowed, but the model
 * annotations (cloud capability tiers, local catalog sizing) grade how much
 * lift to expect so the settings UI can steer the user toward a genuinely
 * stronger advisor. Also reports whether the pairing is native-compatible so
 * the UI can hint at a future zero-change switch to the server tool.
 */
export function validateAdvisorPair(
  executorModel: string,
  advisorModel: string,
): AdvisorPairAssessment {
  const native = isNativeAdvisorPair(executorModel, advisorModel)
  if (executorModel === advisorModel) {
    return {
      ok: false,
      native,
      level: 'warn',
      reason: 'Advisor and executor are the same model — pick a stronger advisor to get any lift.',
    }
  }
  if (native) {
    return {
      ok: true,
      native,
      level: 'good',
      reason: 'Native-compatible pairing: also valid for Claude’s server-side advisor tool.',
    }
  }
  if (isAcpModel(advisorModel)) {
    // Advice routed through an external ACP agent (acp-advisor.ts). The agent
    // owns its own model, so there is no annotation to compare against.
    return {
      ok: true,
      native,
      level: 'info',
      reason:
        'Advice comes from the configured external ACP agent, consulted on a bare one-off session. No capability annotations, so no strength comparison.',
    }
  }

  const executor = annotationFor(executorModel)
  const advisor = annotationFor(advisorModel)

  if (advisor.kind === 'cloud' && executor.kind === 'local') {
    // The pairing the strategy exists for: work stays on device, top-of-scale
    // intelligence is pulled in at the moments that matter. Bands are derived
    // from the annotated distribution, so this judgement self-corrects when a
    // stronger model extends the scale.
    const band = intellectBand(advisor.intellect)
    if (band === 'top') {
      return {
        ok: true,
        native,
        level: 'good',
        reason:
          'Recommended pairing: an on-device executor consulting a top-of-scale cloud advisor — the setup this strategy is designed for.',
      }
    }
    return {
      ok: true,
      native,
      level: band === 'low' ? 'warn' : 'info',
      reason: `On-device executor with a cloud advisor annotated intellect ${String(advisor.intellect)} of ${String(topAnnotatedIntellect())} — a stronger advisor gives more lift.`,
    }
  }

  if (advisor.kind === 'cloud' && executor.kind === 'cloud') {
    const diff = advisor.intellect - executor.intellect
    if (diff > 0) {
      return {
        ok: true,
        native,
        level: 'good',
        reason: `Advisor is annotated stronger than the executor (intellect ${String(advisor.intellect)} vs ${String(executor.intellect)}).`,
      }
    }
    if (diff === 0) {
      return {
        ok: true,
        native,
        level: 'info',
        reason: `Advisor and executor are annotated at the same intellect (${String(advisor.intellect)}) — expect a second opinion rather than stronger guidance.`,
      }
    }
    return {
      ok: true,
      native,
      level: 'warn',
      reason: `Advisor is annotated weaker than the executor (intellect ${String(advisor.intellect)} vs ${String(executor.intellect)}) — its advice is unlikely to add lift.`,
    }
  }

  if (advisor.kind === 'cloud') {
    // Executor has no annotation (OpenRouter / ACP / uncatalogued id).
    return {
      ok: true,
      native,
      level: 'info',
      reason: `Cloud advisor annotated intellect ${String(advisor.intellect)} of ${String(topAnnotatedIntellect())}; the executor isn’t in the capability annotations, so no strength comparison is possible.`,
    }
  }

  if (advisor.kind === 'local') {
    if (executor.kind === 'local' && advisor.paramsB !== null && executor.paramsB !== null) {
      if (advisor.paramsB > executor.paramsB) {
        return {
          ok: true,
          native,
          level: 'info',
          reason: `Advisor is a larger local model (~${String(advisor.paramsB)}B vs ~${String(executor.paramsB)}B) — modest lift; a frontier cloud advisor gives more.`,
        }
      }
      return {
        ok: true,
        native,
        level: 'warn',
        reason: `Advisor (~${String(advisor.paramsB)}B) is not larger than the executor (~${String(executor.paramsB)}B) — pick a bigger model to get any lift.`,
      }
    }
    return {
      ok: true,
      native,
      level: 'warn',
      reason:
        'A local advisor is unlikely to out-think the executor — this strategy expects a larger (ideally frontier cloud) advisor.',
    }
  }

  return {
    ok: true,
    native,
    level: 'info',
    reason:
      'Client-side pairing — any configured executor/advisor combination works. Neither model carries capability annotations, so no strength comparison is possible.',
  }
}

const ROLE_LABEL: Record<LLMMessage['role'], string> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool results',
}

function userContentToText(content: UserContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
    .trim()
}

/**
 * Format the executor's transcript as the quoted context the advisor reads —
 * the client-side equivalent of what the native server assembles automatically.
 * Pure and deterministic so it is easy to unit-test. Includes the system prompt,
 * prior turns, tool calls, and tool results, matching the native advisor's view.
 */
export function buildAdvisorTranscript(messages: LLMMessage[]): string {
  const sections: string[] = []
  const push = (label: string, text: string): void => {
    if (text.trim()) sections.push(`## ${label}\n${text.trim()}`)
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      const lines = message.toolResults.map((r) => `- ${r.toolCallId}: ${r.result}`)
      push(ROLE_LABEL.tool, lines.join('\n'))
    } else if (message.role === 'user') {
      push(ROLE_LABEL.user, userContentToText(message.content))
    } else if (message.role === 'system') {
      push(ROLE_LABEL.system, message.content)
    } else if (Array.isArray(message.content)) {
      const lines = message.content.map((c) => `- ${c.name}(${safeJson(c.args)})`)
      push('Assistant (tool calls)', lines.join('\n'))
    } else {
      push(ROLE_LABEL.assistant, message.content)
    }
  }
  return sections.join('\n\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
