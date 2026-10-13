import type { LLMMessage, UserContent } from '@shared/types'
import { BEST_INTELLECT_MODEL_SELECTOR } from '@copse/llm/dynamic-model.ts'
import { displayModelLabel } from '@shared/model-display.ts'

/**
 * Experimental, opt-in "advisor strategy" feature (tracked in
 * https://github.com/copse-dev/agent-pane/issues/566).
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
 * lives in advisor-runner.ts, and the tool gating lives in registry-bootstrap:
 * the `advisor` tool is now the `copse.advisor-strategy` first-party plugin, so it
 * is registered iff that plugin is enabled (Settings → Plugins). Which model the
 * advisor consults is now the plugin's own `advisorModel` `model` setting field
 * (see `advisor-strategy-plugin.ts`); `resolveAdvisorModelId` in advisor-runner.ts
 * reads it (a `roleModels` `advisor` assignment still wins first).
 */

/** Default advisor selection when nothing is configured — the most capable
 *  reachable model, chosen at consult time. Kept equal to
 *  `DEFAULT_ADVISOR_MODEL_ID` on the Electron-free plugin side. */
export const DEFAULT_ADVISOR_MODEL = BEST_INTELLECT_MODEL_SELECTOR

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
 * Human label for the advisor model id, used to attribute the advice in the
 * tool card so the advisor model's output is distinguishable from the
 * executor's (which drives the surrounding conversation). Routed through the
 * one shared labeler so the advisor attribution can no longer drift from the
 * picker, transcript, and subagent badge — every surface renders the same
 * `Title — Model` / `… · local` / house-style cloud form.
 */
export function formatAdvisorModelLabel(model: string): string {
  return displayModelLabel(model)
}

/**
 * Prefix the advice with a Markdown attribution line naming the advisor model,
 * so the tool card shows which model produced it (the advisor), plainly
 * distinct from the executor model that drives the conversation. Rendered as
 * Markdown by the tool card (`resultFormat: 'markdown'`).
 */
export function attributeAdvice(advice: string, advisorModel: string): string {
  return `**Advisor — ${formatAdvisorModelLabel(advisorModel)}**\n\n${advice}`
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

export {
  isNativeAdvisorPair,
  cloudAdvisorAddsLift,
  assessCloudAdvisorPair,
  advisorAddsLift,
  validateAdvisorPair,
  type AdvisorPairAssessment,
} from '@shared/advisor-pair.ts'

const ROLE_LABEL: Record<LLMMessage['role'], string> = {
  system: 'System',
  developer: 'Developer',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool results',
  provider_state: 'Provider state',
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
 * Character budget for the executor transcript forwarded to the advisor
 * (~30k tokens at ~4 chars/token). The transcript grows with every tool result,
 * so without a cap a long run hands the advisor — usually the most expensive
 * model in the pairing — the whole history on every consult, and eventually
 * more than its context window holds. The advisor needs the task and where the
 * executor is now far more than the middle of a long run, so truncation drops
 * the *oldest* sections first (see {@link capAdvisorTranscript}).
 */
export const MAX_ADVISOR_TRANSCRIPT_CHARS = 120_000

/**
 * Format the executor's transcript as the quoted context the advisor reads —
 * the client-side equivalent of what the native server assembles automatically.
 * Pure and deterministic so it is easy to unit-test. Includes the system prompt,
 * prior turns, tool calls, and tool results, matching the native advisor's view,
 * capped at `maxChars` (see {@link capAdvisorTranscript}).
 */
export function buildAdvisorTranscript(
  messages: LLMMessage[],
  maxChars: number = MAX_ADVISOR_TRANSCRIPT_CHARS,
): string {
  const sections: string[] = []
  let taskIndex = -1
  const push = (label: string, text: string): void => {
    if (!text.trim()) return
    if (label === ROLE_LABEL.user && taskIndex === -1) taskIndex = sections.length
    sections.push(`## ${label}\n${text.trim()}`)
  }
  for (const message of messages) {
    if (message.role === 'provider_state') continue
    if (message.role === 'tool') {
      const lines = message.toolResults.map((r) => `- ${r.toolCallId}: ${r.result}`)
      push(ROLE_LABEL.tool, lines.join('\n'))
    } else if (message.role === 'user') {
      push(ROLE_LABEL.user, userContentToText(message.content))
    } else if (message.role === 'system' || message.role === 'developer') {
      push(ROLE_LABEL[message.role], message.content)
    } else if (Array.isArray(message.content)) {
      const lines = message.content.map((c) => `- ${c.name}(${safeJson(c.args)})`)
      push('Assistant (tool calls)', lines.join('\n'))
    } else {
      push(ROLE_LABEL.assistant, message.content)
    }
  }
  return capAdvisorTranscript(sections, maxChars, taskIndex)
}

const SECTION_SEPARATOR = '\n\n'

/** Room reserved for the truncation notice so the capped result stays within budget. */
const TRUNCATION_NOTICE_RESERVE = 320

/** The share of the budget the original task may take and still be pinned. */
const TASK_BUDGET_SHARE = 4

/**
 * Fit formatted transcript sections into `maxChars`, keeping the most recent
 * context. Sections are kept whole from the newest backwards until the next one
 * would not fit; the rest are dropped and a leading notice says how much, so the
 * advisor knows it is reading a tail rather than the whole run. The first user
 * message — the task itself — stays pinned at the top when it is small enough
 * (a quarter of the budget), because advice without the task is guesswork.
 * When even the newest section alone exceeds the budget, its tail is kept.
 */
export function capAdvisorTranscript(
  sections: readonly string[],
  maxChars: number,
  taskIndex = -1,
): string {
  const full = sections.join(SECTION_SEPARATOR)
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : maxChars === Number.POSITIVE_INFINITY
      ? maxChars
      : 0
  if (full.length <= limit) return full
  if (limit === 0) return ''

  const budget = Math.max(0, limit - TRUNCATION_NOTICE_RESERVE)
  const task = taskIndex >= 0 ? sections[taskIndex] : undefined
  const pinTask = task !== undefined && task.length <= budget / TASK_BUDGET_SHARE
  let remaining = pinTask ? budget - task.length - SECTION_SEPARATOR.length : budget

  const recent: string[] = []
  for (let i = sections.length - 1; i >= 0; i--) {
    if (pinTask && i === taskIndex) break
    const section = sections[i] ?? ''
    const cost = section.length + (recent.length > 0 ? SECTION_SEPARATOR.length : 0)
    if (cost > remaining) break
    recent.unshift(section)
    remaining -= cost
  }

  // Nothing recent fitted whole: keep the tail of the newest section — unless the
  // newest section *is* the pinned task, in which case it is already kept.
  const newestIsPinnedTask = pinTask && taskIndex === sections.length - 1
  let keptTail = ''
  if (recent.length === 0 && !newestIsPinnedTask) {
    const newest = sections[sections.length - 1] ?? ''
    keptTail = `…${newest.slice(newest.length - Math.max(0, remaining - 1))}`
  }
  const keptCount = recent.length + (pinTask ? 1 : 0)
  const omittedSections = sections.length - keptCount - (keptTail ? 1 : 0)
  const keptChars =
    [...(pinTask ? [task] : []), ...recent].join(SECTION_SEPARATOR).length + keptTail.length
  const omittedDetail =
    omittedSections > 0
      ? `${String(omittedSections)} earlier section${omittedSections === 1 ? '' : 's'}`
      : 'the start of the most recent section'
  const notice =
    `[Transcript truncated to fit the advisor’s ${String(limit)}-character budget: ` +
    `${omittedDetail} omitted (${String(full.length - keptChars)} of ${String(full.length)} characters). ` +
    `${pinTask ? 'The original task is kept first; the ' : 'The '}most recent context follows.]`
  const rendered = [
    notice,
    ...(pinTask ? [task] : []),
    ...(pinTask && omittedSections > 0 ? ['[…]'] : []),
    ...recent,
    ...(keptTail ? [keptTail] : []),
  ].join(SECTION_SEPARATOR)
  if (rendered.length <= limit) return rendered

  // A caller may deliberately use a budget smaller than the detailed notice.
  // Keep the hard cap truthful in that case: retain a compact marker and spend
  // the remaining room on the newest transcript tail.
  const compactNotice = '[Transcript truncated]'
  if (compactNotice.length >= limit) return compactNotice.slice(0, limit)
  const tailBudget = limit - compactNotice.length - SECTION_SEPARATOR.length
  if (tailBudget <= 0) return compactNotice
  const tail = `…${full.slice(full.length - Math.max(0, tailBudget - 1))}`
  return `${compactNotice}${SECTION_SEPARATOR}${tail}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
