// Dynamic model selection: *how* to pick a model, rather than *which* model.
//
// A pinned model id ("claude-opus-4-8") is a snapshot of a judgement that was
// true on the day it was written. It goes stale the moment a better/cheaper
// model ships, the user's plan window resets, or they load a different model
// into LM Studio — and every surface that pinned it has to be revisited by hand.
// A *selector* stores the judgement instead ("the best-value route I can reach",
// "at least 45 on the Intelligence Index, cheapest such route", "whatever is
// assigned to the reviewer role") and re-derives the concrete id at run time.
//
// Selectors live in the `auto:` namespace ({@link AUTO_MODEL_PREFIX}), alongside
// the other reserved model-selection namespaces (`lmstudio:`, `openrouter:`,
// `remote-agent:`, `acp:`, `plugin-model:`). `auto:best-value` predates this module
// as the chat default sentinel; it is the same string, now one member of a
// vocabulary rather than a one-off.
//
// This module is pure vocabulary — parsing, formatting, and the picker's option
// list. It deliberately holds no resolution logic: resolving a selector needs
// live provider availability, plan usage, and the loaded local-model list, all
// of which are host-side (`src/main/services/providers/dynamic-model.ts`). That
// split is what lets the Electron-free plugin manifests and the renderer share the
// vocabulary without pulling the host in.

import { AGENT_ROLES, getAgentRole, type AgentRoleId } from './agent-roles.ts'
import { parseModelSelection } from './model-selection.ts'
import { AUTO_MODEL_PREFIX } from './reserved-prefixes.ts'

export { AUTO_MODEL_PREFIX }

/**
 * A parsed selector. Each variant answers "which model?" with a *rule* the host
 * evaluates against the routes the user can actually reach right now.
 */
export type DynamicModelSelector =
  /** Best intellect-per-price on the plan-aware Pareto frontier (plan/local first). */
  | { kind: 'best-value' }
  /** Highest Intelligence Index score among routable models. */
  | { kind: 'best-intellect' }
  /** Highest Intelligence Index score among models loaded on this device. */
  | { kind: 'best-local' }
  /** Cheapest routable model (plan-covered and local count as free). */
  | { kind: 'cheapest' }
  /** Intellect/cost trade-off judged on real API price (no plan discount), biased toward plan-covered routes with headroom. */
  | { kind: 'balanced' }
  /** Cheapest routable model scoring at least `threshold` on the Intelligence Index. */
  | { kind: 'min-intellect'; threshold: number }
  /** Whatever the user assigned to this agent role (Settings → model roles). */
  | { kind: 'role'; role: AgentRoleId }

export const BEST_VALUE_MODEL_SELECTOR = `${AUTO_MODEL_PREFIX}best-value`
export const BEST_INTELLECT_MODEL_SELECTOR = `${AUTO_MODEL_PREFIX}best-intellect`
export const BEST_LOCAL_MODEL_SELECTOR = `${AUTO_MODEL_PREFIX}best-local`
export const CHEAPEST_MODEL_SELECTOR = `${AUTO_MODEL_PREFIX}cheapest`
export const BALANCED_MODEL_SELECTOR = `${AUTO_MODEL_PREFIX}balanced`

const MIN_INTELLECT_INFIX = 'min-intellect:'
const ROLE_INFIX = 'role:'

/** `auto:min-intellect:<threshold>` — the cheapest route at or above the bar. */
export function minIntellectSelector(threshold: number): string {
  return `${AUTO_MODEL_PREFIX}${MIN_INTELLECT_INFIX}${String(threshold)}`
}

/** `auto:role:<roleId>` — indirection through the agent-role registry. */
export function roleModelSelector(role: AgentRoleId): string {
  return `${AUTO_MODEL_PREFIX}${ROLE_INFIX}${role}`
}

/**
 * Intelligence Index bars offered in the picker. Chosen to span the measured
 * distribution (roughly 3–61 on the canonical v4.1 scale) with recognisable
 * steps rather than to track any one model — a bar keeps meaning what it says
 * as the scale extends, which is the whole point of storing it instead of an id.
 */
export const MIN_INTELLECT_THRESHOLDS: readonly number[] = [20, 30, 40, 50, 55]

/** True for any `auto:` selector, parseable or not. */
export function isDynamicModel(value: string | null | undefined): boolean {
  return typeof value === 'string' && parseModelSelection(value).namespace === 'auto'
}

/**
 * Parse a stored selection. Returns null for a pinned model id *and* for an
 * `auto:` value this build does not understand — an unknown selector is treated
 * as "not dynamic" so a downgrade routes it through the pinned-id path rather
 * than silently resolving it as something else.
 *
 * The namespace split comes from the shared parser; what the rule body *means*
 * is this module's own grammar, the same division `plugin-model.ts` draws for its
 * URI-encoded halves.
 */
export function parseDynamicModel(value: string | null | undefined): DynamicModelSelector | null {
  if (typeof value !== 'string') return null
  const selection = parseModelSelection(value)
  if (selection.namespace !== 'auto') return null
  const body = selection.id
  if (body === 'best-value') return { kind: 'best-value' }
  if (body === 'best-intellect') return { kind: 'best-intellect' }
  if (body === 'best-local') return { kind: 'best-local' }
  if (body === 'cheapest') return { kind: 'cheapest' }
  if (body === 'balanced') return { kind: 'balanced' }
  if (body.startsWith(MIN_INTELLECT_INFIX)) {
    const threshold = Number(body.slice(MIN_INTELLECT_INFIX.length))
    if (!Number.isFinite(threshold) || threshold <= 0) return null
    return { kind: 'min-intellect', threshold }
  }
  if (body.startsWith(ROLE_INFIX)) {
    const role = getAgentRole(body.slice(ROLE_INFIX.length))
    return role ? { kind: 'role', role: role.id } : null
  }
  return null
}

/** Short picker/footer label for a selector value. Null when not dynamic. */
export function dynamicModelLabel(value: string): string | null {
  const selector = parseDynamicModel(value)
  if (!selector) return null
  switch (selector.kind) {
    case 'best-value':
      return 'Best value'
    case 'best-intellect':
      return 'Most capable'
    case 'best-local':
      return 'Best on-device'
    case 'cheapest':
      return 'Cheapest'
    case 'balanced':
      return 'Balanced'
    case 'min-intellect':
      return `At least ${String(selector.threshold)} intelligence`
    case 'role':
      return `Role: ${getAgentRole(selector.role)?.label ?? selector.role}`
  }
}

/** One row in a dynamic-only model picker. */
export interface DynamicModelChoice {
  value: string
  label: string
  /** Second line: what the rule actually does when it resolves. */
  description: string
  /** Picker group heading. */
  group: string
}

const AUTOMATIC_GROUP = 'Automatic'
const INTELLIGENCE_GROUP = 'Minimum intelligence'
const ROLE_GROUP = 'By role'

/**
 * Every selector a picker offers, in display order. Roles come last: they are
 * indirection through the user's own assignments, so they only pay off once
 * those assignments exist.
 */
export function dynamicModelChoices(): DynamicModelChoice[] {
  const choices: DynamicModelChoice[] = [
    {
      value: BEST_VALUE_MODEL_SELECTOR,
      label: 'Best value',
      description: 'Best intelligence per pound across your plans, providers, and local server',
      group: AUTOMATIC_GROUP,
    },
    {
      value: BEST_INTELLECT_MODEL_SELECTOR,
      label: 'Most capable',
      description: 'Highest intelligence available, ignoring price',
      group: AUTOMATIC_GROUP,
    },
    {
      value: BEST_LOCAL_MODEL_SELECTOR,
      label: 'Best on-device',
      description: 'Strongest model loaded on your machine',
      group: AUTOMATIC_GROUP,
    },
    {
      value: CHEAPEST_MODEL_SELECTOR,
      label: 'Cheapest',
      description: 'Lowest token price; plans and local count as free',
      group: AUTOMATIC_GROUP,
    },
    {
      value: BALANCED_MODEL_SELECTOR,
      label: 'Balanced',
      description: 'Strong capability at a fair price; favors plans',
      group: AUTOMATIC_GROUP,
    },
  ]
  for (const threshold of MIN_INTELLECT_THRESHOLDS) {
    choices.push({
      value: minIntellectSelector(threshold),
      label: `At least ${String(threshold)} intelligence`,
      description: `Cheapest route scoring ${String(threshold)}+ on the Intelligence Index`,
      group: INTELLIGENCE_GROUP,
    })
  }
  for (const role of AGENT_ROLES) {
    choices.push({
      value: roleModelSelector(role.id),
      label: role.label,
      description: role.description,
      group: ROLE_GROUP,
    })
  }
  return choices
}
