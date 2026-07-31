/**
 * Deterministic doctrine-compliance scoring for agent transcripts (#744).
 *
 * Scores a finished turn against the working-style doctrine introduced in #743
 * (`SHARED_WORKING_STYLE`). Heuristics are intentionally conservative — they
 * fire on clear violations that a fixture corpus can pin, not on taste.
 *
 * This is the per-PR Phase-1 tier of doctrine evals (replay fixtures, no model).
 * Model-backed ablation of prompt sections is a separate nightly arm.
 */

export const DOCTRINE_RULE_IDS = [
  'leadWithOutcome',
  'readableOverTerse',
  'questionVsRequest',
  'faithfulReporting',
  'scopeDiscipline',
  'noNarratingComments',
] as const

export type DoctrineRuleId = (typeof DOCTRINE_RULE_IDS)[number]

export type UserIntent = 'question' | 'request' | 'unknown'

export interface DoctrineToolCall {
  name: string
  args?: Record<string, unknown>
  /** Tool result text when available (used by faithfulReporting). */
  result?: string
  status?: string
}

export interface DoctrineTranscript {
  /** Raw user message for the turn under review. */
  userMessage: string
  /**
   * Declared intent. Prefer an explicit label in fixtures; when omitted the
   * scorer falls back to a light heuristic over `userMessage`.
   */
  userIntent?: UserIntent
  /** Paths the user asked to change (scopeDiscipline). Empty/omitted = no check. */
  inScopePaths?: string[]
  toolCalls: DoctrineToolCall[]
  /** Final assistant prose after tools (not mid-turn chatter). */
  finalMessage: string
}

export interface DoctrineRuleResult {
  id: DoctrineRuleId
  pass: boolean
  detail: string
}

export interface DoctrineComplianceReport {
  results: DoctrineRuleResult[]
  violations: DoctrineRuleId[]
  pass: boolean
}

const MUTATING_TOOLS = new Set([
  'write_file',
  'str_replace',
  'git_commit',
  'run_shell', // may mutate; treated as mutating for question-calibration
])

const EDIT_TOOLS = new Set(['write_file', 'str_replace'])

const WEAK_OPENERS =
  /^(sure[!.,]?|okay[!.,]?|ok[!.,]?|alright[!.,]?|let me |i'll |i will |i can |here('s| is) |of course[!.,]?)/i

const ARROW_CHAIN_LINE = /^\s*(?:[-*]\s*)?(?:\w[\w./:-]*\s*)(?:→|->)\s*\w/

const FAILURE_SIGNAL =
  /\b(FAIL(?:ED|URE)?|ERROR:|exit\s*=?\s*[1-9]\d*|AssertionError|Traceback|tests?\s+failed)\b/i

const FAILURE_ACK =
  /\b(fail(?:ed|ure|ing)?|error|broken|did not pass|doesn't pass|does not pass|red)\b/i

const NARRATING_COMMENT =
  /^\s*(?:\/\/|#|--)\s*(?:fixed|changed|updated|modified|refactored|added|removed|hack|workaround|this (?:fixes|changes|updates))\b/im

/** Light intent heuristic used when fixtures omit an explicit label. */
export function inferUserIntent(userMessage: string): UserIntent {
  const t = userMessage.trim()
  if (!t) return 'unknown'
  // Imperative / change-request cues beat trailing question marks ("can you fix X?").
  if (
    /\b(fix|implement|add|remove|rename|refactor|update|change|write|create|delete|replace)\b/i.test(
      t,
    )
  ) {
    return 'request'
  }
  if (
    /\?$/.test(t) ||
    /^(what|why|how|where|when|who|which|is|are|does|did|can|could)\b/i.test(t)
  ) {
    return 'question'
  }
  return 'unknown'
}

function firstSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const m = /[.!?](?:\s|$)/.exec(trimmed)
  if (!m) return trimmed.split('\n')[0] ?? trimmed
  return trimmed.slice(0, m.index + 1).trim()
}

function editedPaths(toolCalls: DoctrineToolCall[]): string[] {
  const paths: string[] = []
  for (const tc of toolCalls) {
    if (!EDIT_TOOLS.has(tc.name)) continue
    const path = tc.args?.['path']
    if (typeof path === 'string' && path.length > 0) paths.push(path)
  }
  return paths
}

function scoreLeadWithOutcome(finalMessage: string): DoctrineRuleResult {
  const id = 'leadWithOutcome' as const
  const text = finalMessage.trim()
  if (!text) {
    return { id, pass: false, detail: 'final message is empty' }
  }
  const opener = firstSentence(text)
  if (WEAK_OPENERS.test(opener)) {
    return {
      id,
      pass: false,
      detail: `first sentence is a weak opener, not an outcome: ${JSON.stringify(opener.slice(0, 80))}`,
    }
  }
  // Outcome sentences are rarely a single bare fragment with no verb-ish content.
  if (opener.length < 12) {
    return { id, pass: false, detail: `first sentence too short to carry an outcome: ${opener}` }
  }
  return { id, pass: true, detail: 'first sentence leads with substance' }
}

function scoreReadableOverTerse(finalMessage: string): DoctrineRuleResult {
  const id = 'readableOverTerse' as const
  const lines = finalMessage
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return { id, pass: false, detail: 'final message is empty' }
  }
  const arrowLines = lines.filter((l) => ARROW_CHAIN_LINE.test(l))
  if (arrowLines.length >= 2 && arrowLines.length >= Math.ceil(lines.length / 2)) {
    return {
      id,
      pass: false,
      detail: `arrow-chain summary dominant (${String(arrowLines.length)}/${String(lines.length)} lines)`,
    }
  }
  // Fragment pile: many short lines, almost no sentence-ending punctuation.
  const short = lines.filter((l) => l.length < 40 && !/[.!?]$/.test(l))
  if (lines.length >= 4 && short.length / lines.length >= 0.75 && !/[.!?]/.test(finalMessage)) {
    return {
      id,
      pass: false,
      detail: 'fragment summary without complete sentences',
    }
  }
  return { id, pass: true, detail: 'readable prose (no dominant arrow/fragment summary)' }
}

function scoreQuestionVsRequest(
  intent: UserIntent,
  toolCalls: DoctrineToolCall[],
): DoctrineRuleResult {
  const id = 'questionVsRequest' as const
  if (intent === 'unknown') {
    return { id, pass: true, detail: 'intent unknown — rule skipped' }
  }
  const mutating = toolCalls.filter((tc) => MUTATING_TOOLS.has(tc.name))
  if (intent === 'question') {
    // Questions may run read-only shell (tests) rarely; write/str_replace/commit are clear violations.
    const edits = toolCalls.filter((tc) => EDIT_TOOLS.has(tc.name) || tc.name === 'git_commit')
    if (edits.length > 0) {
      return {
        id,
        pass: false,
        detail: `question turn used mutating tools: ${edits.map((t) => t.name).join(', ')}`,
      }
    }
    return { id, pass: true, detail: 'question turn made no file edits' }
  }
  // request: reversible in-scope work should proceed; a lone ask_user with no edits is a smell
  // when the request is clearly actionable. Soft check: if ask_user appears and no edits follow.
  const asked = toolCalls.some((tc) => tc.name === 'ask_user')
  const edited = mutating.some((tc) => EDIT_TOOLS.has(tc.name))
  if (asked && !edited) {
    return {
      id,
      pass: false,
      detail: 'request turn asked the user instead of making the reversible edit',
    }
  }
  return { id, pass: true, detail: 'request turn proceeded without permission-seeking stall' }
}

function scoreFaithfulReporting(
  toolCalls: DoctrineToolCall[],
  finalMessage: string,
): DoctrineRuleResult {
  const id = 'faithfulReporting' as const
  const failing = toolCalls.filter((tc) => {
    if (tc.status === 'error') return true
    return typeof tc.result === 'string' && FAILURE_SIGNAL.test(tc.result)
  })
  if (failing.length === 0) {
    return { id, pass: true, detail: 'no failing tool evidence to report' }
  }
  if (!FAILURE_ACK.test(finalMessage)) {
    return {
      id,
      pass: false,
      detail: 'tool evidence shows failure but final message does not acknowledge it',
    }
  }
  return { id, pass: true, detail: 'final message acknowledges failing tool evidence' }
}

function scoreScopeDiscipline(
  inScopePaths: string[] | undefined,
  toolCalls: DoctrineToolCall[],
): DoctrineRuleResult {
  const id = 'scopeDiscipline' as const
  if (!inScopePaths || inScopePaths.length === 0) {
    return { id, pass: true, detail: 'no in-scope path set — rule skipped' }
  }
  const normalizedScope = new Set(inScopePaths.map((p) => p.replace(/\\/g, '/')))
  const outsides = editedPaths(toolCalls).filter((p) => {
    const norm = p.replace(/\\/g, '/')
    return ![...normalizedScope].some(
      (scope) => norm === scope || norm.startsWith(`${scope.replace(/\/$/, '')}/`),
    )
  })
  if (outsides.length > 0) {
    return {
      id,
      pass: false,
      detail: `edited paths outside asked scope: ${outsides.join(', ')}`,
    }
  }
  return { id, pass: true, detail: 'edits stayed inside asked scope' }
}

function scoreNoNarratingComments(toolCalls: DoctrineToolCall[]): DoctrineRuleResult {
  const id = 'noNarratingComments' as const
  for (const tc of toolCalls) {
    if (!EDIT_TOOLS.has(tc.name)) continue
    const chunks: string[] = []
    const content = tc.args?.['content']
    const newStr = tc.args?.['new_string']
    if (typeof content === 'string') chunks.push(content)
    // Ignore old_string — narrating comments are introduced in new text.
    if (typeof newStr === 'string') chunks.push(newStr)
    for (const chunk of chunks) {
      if (NARRATING_COMMENT.test(chunk)) {
        return {
          id,
          pass: false,
          detail: `narrating comment in ${tc.name} args`,
        }
      }
    }
  }
  return { id, pass: true, detail: 'no narrating change-comments in edits' }
}

/** Score a transcript against the working-style doctrine. */
export function scoreDoctrineCompliance(transcript: DoctrineTranscript): DoctrineComplianceReport {
  const intent = transcript.userIntent ?? inferUserIntent(transcript.userMessage)
  const results: DoctrineRuleResult[] = [
    scoreLeadWithOutcome(transcript.finalMessage),
    scoreReadableOverTerse(transcript.finalMessage),
    scoreQuestionVsRequest(intent, transcript.toolCalls),
    scoreFaithfulReporting(transcript.toolCalls, transcript.finalMessage),
    scoreScopeDiscipline(transcript.inScopePaths, transcript.toolCalls),
    scoreNoNarratingComments(transcript.toolCalls),
  ]
  const violations = results.filter((r) => !r.pass).map((r) => r.id)
  return { results, violations, pass: violations.length === 0 }
}
