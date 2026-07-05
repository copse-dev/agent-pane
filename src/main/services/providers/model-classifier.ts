import { getModelInfo, type TrackedModel } from '@shared/llm/model-catalog.ts'
import { getAgentRole, type AgentRoleId } from '@shared/llm/agent-roles.ts'

/**
 * Experimental, opt-in "model classifier" feature (tracked in
 * https://github.com/jonathanKingston/agent-pane/issues/557).
 *
 * Given a task description and a few signals, recommend which capability tier —
 * and a representative model — is the best fit, so cheap/fast models handle
 * trivial work and frontier models are reserved for the hard tasks. This is a
 * first-cut *heuristic* classifier (keyword + size signals); a learned or
 * model-judged version, and wiring the recommendation into the actual
 * provider-selection path, are follow-ups on the issue.
 *
 * Off by default; gates the `suggest_model` tool registration
 * (registry-bootstrap) so nothing is advertised until the user opts in via
 * Settings → Experimental. The classification function itself is pure and has
 * no side effects.
 */
export const MODEL_CLASSIFIER_ENABLED_SETTING = 'modelClassifierEnabled'

/** Capability tiers, cheapest/fastest first. */
export type ModelTier = 'fast' | 'balanced' | 'frontier'

/**
 * Representative model per tier, drawn from the tracked catalog. Deliberately
 * Anthropic-only for now (the app's default family); mapping to the user's
 * actually-configured/available providers is a follow-up — see the issue.
 */
const TIER_MODEL: Record<ModelTier, TrackedModel> = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  frontier: 'claude-opus-4-8',
}

export interface ClassifyModelInput {
  /** The task / prompt to route. */
  task: string
  /** Rough estimate of the context the task will need to hold, in tokens. */
  contextTokensEstimate?: number | undefined
  /** Whether the task drives tools / subagents (a long agentic loop). */
  agentic?: boolean | undefined
}

export interface ModelRecommendation {
  tier: ModelTier
  /** Representative model id for the tier (see {@link TIER_MODEL}). */
  model: TrackedModel
  /** 0–1 confidence in the tier choice. */
  confidence: number
  /** Human-readable explanation of why this tier was chosen. */
  rationale: string
}

// Signals that a task is hard enough to want a frontier model.
const FRONTIER_HINTS =
  /\b(architect|architecture|refactor|redesign|design|migrat|debug|root cause|race condition|concurren|security|threat model|algorithm|prove|plan the|complex)/i

// Signals that a task is trivial enough for the fast tier.
const FAST_HINTS =
  /\b(rename|typo|format|lint|comment|docstring|summari[sz]e|classify|extract|translate|one-?liner|trivial|tweak)\b/i

/**
 * Heuristically pick a capability tier for a task. Pure — no I/O, no settings
 * read — so it is cheap to call and easy to unit-test. The score combines
 * keyword hints, prompt length, context-window need, and whether the task is
 * agentic; the thresholds are intentionally simple and meant to be tuned.
 */
export function classifyModelForTask(input: ClassifyModelInput): ModelRecommendation {
  const task = input.task.trim()
  const words = task ? task.split(/\s+/).length : 0
  const contextNeed = input.contextTokensEstimate ?? 0

  let score = 0
  const reasons: string[] = []

  if (FRONTIER_HINTS.test(task)) {
    score += 2
    reasons.push('mentions design/refactor/debug-class work')
  }
  if (FAST_HINTS.test(task)) {
    score -= 2
    reasons.push('looks like a small, mechanical edit')
  }
  if (words > 120) {
    score += 1
    reasons.push('long, detailed instructions')
  } else if (words > 0 && words < 15) {
    score -= 1
    reasons.push('short prompt')
  }
  if (input.agentic) {
    score += 1
    reasons.push('agentic (drives tools/subagents)')
  }
  if (contextNeed > 200_000) {
    score += 1
    reasons.push('needs a large context window')
  }

  const tier: ModelTier = score >= 2 ? 'frontier' : score <= -2 ? 'fast' : 'balanced'
  const model = TIER_MODEL[tier]

  // If the estimated context exceeds the chosen model's window, say so — a real
  // router would escalate to a wider-context model here.
  const info = getModelInfo(model)
  if (info && contextNeed > info.contextWindow) {
    reasons.push(
      `note: estimated context ${String(contextNeed)} exceeds ${model}'s ${String(info.contextWindow)}-token window`,
    )
  }

  // Confidence grows with how decisively the score clears the tier boundaries.
  const confidence = Math.min(0.95, 0.5 + 0.15 * Math.abs(score))
  const rationale = reasons.length
    ? reasons.join('; ')
    : 'no strong signals — default balanced tier'

  return { tier, model, confidence, rationale }
}

// Keyword → pipeline role, most-specific first (first match wins). This is the
// *role* axis (what job the task is), orthogonal to the *tier* axis above (how
// capable a model it needs). See docs/plans/model-roles-and-defaults.md.
const ROLE_HINTS: ReadonlyArray<readonly [AgentRoleId, RegExp]> = [
  ['security-auditor', /\b(vulnerab|security|exploit|CVE|injection|threat model|auth[nz]?)\b/i],
  [
    'test-gen',
    /\b(unit tests?|integration tests?|property tests?|write tests?|test coverage|add tests?)\b/i,
  ],
  ['reviewer', /\b(review|maintainab|code quality|readabilit|nitpick)\b/i],
  [
    'refactor',
    /\b(refactor|rename|extract (a )?(function|method|variable)|restructure|clean up)\b/i,
  ],
  [
    'debugger',
    /\b(bug|fix the|crash|stack trace|root cause|debug|regression|why is .* failing)\b/i,
  ],
  ['planner', /\b(plan the|break (this )?down|decompose|roadmap|design doc|architecture)\b/i],
  ['docs', /\b(document|readme|docstring|api docs?|write comments?|changelog)\b/i],
  ['research', /\b(look up|research|how does|what is|find out|investigate|compare)\b/i],
]

export interface RoleRecommendation {
  role: AgentRoleId
  /** Human-readable role label, for display. */
  label: string
  /** Why this role was chosen. */
  rationale: string
}

/**
 * Heuristically pick the pipeline role a task belongs to (coder by default).
 * Pure — keyword-only, no I/O — so it's cheap and unit-testable. Advisory: it
 * names the *kind* of work, which a caller can pair with the tier above to route
 * to the model assigned to that role.
 */
export function suggestRoleForTask(task: string): RoleRecommendation {
  const text = task.trim()
  for (const [role, re] of ROLE_HINTS) {
    if (re.test(text)) {
      const label = getAgentRole(role)?.label ?? role
      return { role, label, rationale: `task looks like ${label.toLowerCase()} work` }
    }
  }
  const coder = getAgentRole('coder')
  return {
    role: 'coder',
    label: coder?.label ?? 'coder',
    rationale: 'no role-specific signal — default to coding',
  }
}
