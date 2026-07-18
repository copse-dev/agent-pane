import { getModelInfo, type TrackedModel } from '@copse/llm/model-catalog.ts'
import {
  BAND_REPRESENTATIVE_MODEL,
  modelIntellect,
  type IntellectBand,
} from '@copse/llm/model-intellect.ts'
import { getAgentRole, type AgentRoleId } from '@copse/llm/agent-roles.ts'

/**
 * Experimental, opt-in "model classifier" feature (tracked in
 * https://github.com/jonathanKingston/agent-pane/issues/557).
 *
 * Given a task description and a few signals, recommend where the task sits on
 * the shared model intellect scale (`model-intellect.ts`) — and a
 * representative model — so cheap/fast models handle trivial work and
 * top-of-scale models are reserved for the hard tasks. The same scale grades
 * advisor pairings, so there is one capability vocabulary across the app.
 * This is a first-cut *heuristic* classifier (keyword + size signals); a
 * learned or model-judged version, and wiring the recommendation into the
 * actual provider-selection path, are follow-ups on the issue.
 *
 * Off by default; gates the `suggest_model` tool registration
 * (registry-bootstrap) so nothing is advertised until the user opts in via
 * Settings → Experimental. The classification function itself is pure and has
 * no side effects.
 */
export const MODEL_CLASSIFIER_ENABLED_SETTING = 'modelClassifierEnabled'

export interface ClassifyModelInput {
  /** The task / prompt to route. */
  task: string
  /** Rough estimate of the context the task will need to hold, in tokens. */
  contextTokensEstimate?: number | undefined
  /** Whether the task drives tools / subagents (a long agentic loop). */
  agentic?: boolean | undefined
}

export interface ModelRecommendation {
  /** Where the task's demand sits on the shared intellect scale. */
  band: IntellectBand
  /** The representative model's intellect number (see model-intellect.ts). */
  intellect: number
  /** Representative model id for the band (see {@link BAND_REPRESENTATIVE_MODEL}). */
  model: TrackedModel
  /** 0–1 confidence in the band choice. */
  confidence: number
  /** Human-readable explanation of why this band was chosen. */
  rationale: string
}

// Signals that a task is hard enough to want a top-of-scale model.
const TOP_BAND_HINTS =
  /\b(architect|architecture|refactor|redesign|design|migrat|debug|root cause|race condition|concurren|security|threat model|algorithm|prove|plan the|complex)/i

// Signals that a task is trivial enough for the low band.
const LOW_BAND_HINTS =
  /\b(rename|typo|format|lint|comment|docstring|summari[sz]e|classify|extract|translate|one-?liner|trivial|tweak)\b/i

/**
 * Heuristically place a task's demand on the intellect scale. Pure — no I/O,
 * no settings read — so it is cheap to call and easy to unit-test. The score
 * combines keyword hints, prompt length, context-window need, and whether the
 * task is agentic; the thresholds are intentionally simple and meant to be
 * tuned.
 */
export function classifyModelForTask(input: ClassifyModelInput): ModelRecommendation {
  const task = input.task.trim()
  const words = task ? task.split(/\s+/).length : 0
  const contextNeed = input.contextTokensEstimate ?? 0

  let score = 0
  const reasons: string[] = []

  if (TOP_BAND_HINTS.test(task)) {
    score += 2
    reasons.push('mentions design/refactor/debug-class work')
  }
  if (LOW_BAND_HINTS.test(task)) {
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

  const band: IntellectBand = score >= 2 ? 'top' : score <= -2 ? 'low' : 'mid'
  const model = BAND_REPRESENTATIVE_MODEL[band]
  // Representatives are annotated by construction (scale-validated in tests).
  const intellect = modelIntellect(model) ?? 0

  // If the estimated context exceeds the chosen model's window, say so — a real
  // router would escalate to a wider-context model here.
  const info = getModelInfo(model)
  if (info && contextNeed > info.contextWindow) {
    reasons.push(
      `note: estimated context ${String(contextNeed)} exceeds ${model}'s ${String(info.contextWindow)}-token window`,
    )
  }

  // Confidence grows with how decisively the score clears the band boundaries.
  const confidence = Math.min(0.95, 0.5 + 0.15 * Math.abs(score))
  const rationale = reasons.length ? reasons.join('; ') : 'no strong signals — default mid-band'

  return { band, intellect, model, confidence, rationale }
}

// Keyword → pipeline role, most-specific first (first match wins). This is the
// *role* axis (what job the task is), orthogonal to the *capability* axis above
// (how smart a model it needs). See docs/plans/model-roles-and-defaults.md.
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
