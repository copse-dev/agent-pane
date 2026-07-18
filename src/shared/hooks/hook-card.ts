import type { SpineHookRunLine } from '../threads/spine-schema.ts'

/**
 * Renderer-facing display model for a hook execution, decision, or halt
 * (decision 10 of docs/plans/hooks-and-feature-packs.md). Hook UI is a distinct
 * tool-call-style card family — right-aligned, same blue — never a user message.
 *
 * A {@link HookCard} is *derived*, never a second source of truth: it is mapped
 * from the always-on spine `hook_run` record ({@link SpineHookRunLine}, decision
 * 6) at fold time, and from the live `hook_run` stream chunk during a run. That
 * keeps history rendering resolving from spine data, never from live hook
 * registration (decision 17): opening an old thread shows the hook cards exactly
 * as they ran, even for a hook that is no longer registered.
 */

/**
 * What a hook card is *about* — selects the card's icon + accent:
 * - `decision`  — a permission verdict (`deny` / `ask`) on a gated action.
 * - `halt`      — the hook asked to stop the run (`continue: false`, decision 12).
 * - `execution` — a plain observation / allow run (no blocking verdict).
 */
export type HookCardKind = 'decision' | 'halt' | 'execution'

/** Normalized status the card badges + colours by. */
export type HookCardStatus =
  'allow' | 'deny' | 'ask' | 'halted' | 'halt-suppressed' | 'blocked' | 'error' | 'ok'

export interface HookCard {
  /** Spine `hook_run` id (stable identity across live/reload). */
  id: string
  /** Canonical or dialect event name that fired (e.g. `stop`, `beforeShellExecution`). */
  event: string
  /** Stable hook id: registry id (function hooks) or command string (command hooks). */
  hookId: string
  executor: 'function' | 'command'
  kind: HookCardKind
  status: HookCardStatus
  /** Wall-clock duration of the execution (ms). */
  durationMs: number
  /** Process exit code (command hooks); null when killed, absent for function hooks. */
  exitCode?: number | null
  /** Whether stdout parsed into a response (command hooks; always true for function hooks). */
  parseOk: boolean
  /** The hook rewrote the gated tool's input (H1). */
  updatedInput?: boolean
  /** Bounded halt reason (`continue: false` + `stopReason`, decision 12). */
  stopReason?: string
  /** Character count of injected context (blocking hooks, H2). */
  injectContextChars?: number
  /** Character count of an async queued follow-up (decision 4). */
  queuedMessageChars?: number
  /** The hook ran inside the project sandbox and was blocked by it (F3, decision 7). */
  sandboxBlocked?: boolean
  /** Error message when a function hook threw (fail-hard, decision 9). */
  error?: string
}

/** Map an always-on spine `hook_run` record into its display card (decision 10). */
export function hookCardFromSpineLine(line: SpineHookRunLine): HookCard {
  const d = line.decision
  const kind = hookCardKind(line)
  return {
    id: line.id,
    event: line.event,
    hookId: line.hookId,
    executor: line.executor,
    kind,
    status: hookCardStatus(line, kind),
    durationMs: line.durationMs,
    parseOk: line.parseOk,
    ...(line.exitCode !== undefined ? { exitCode: line.exitCode } : {}),
    ...(d.updatedInput !== undefined ? { updatedInput: d.updatedInput } : {}),
    ...(d.stopReason !== undefined ? { stopReason: d.stopReason } : {}),
    ...(d.injectContextChars !== undefined ? { injectContextChars: d.injectContextChars } : {}),
    ...(d.queuedMessageChars !== undefined ? { queuedMessageChars: d.queuedMessageChars } : {}),
    ...(d.sandboxBlocked !== undefined ? { sandboxBlocked: d.sandboxBlocked } : {}),
    ...(line.error !== undefined ? { error: line.error } : {}),
  }
}

function hookCardKind(line: SpineHookRunLine): HookCardKind {
  const d = line.decision
  if (d.haltRun) return 'halt'
  if (d.permission === 'deny' || d.permission === 'ask') return 'decision'
  return 'execution'
}

function hookCardStatus(line: SpineHookRunLine, kind: HookCardKind): HookCardStatus {
  const d = line.decision
  // A sandbox block or a function-hook throw is always a failure, regardless of
  // what the hook otherwise decided (F3 / decision 9) — surface it, never hide it.
  if (d.sandboxBlocked) return 'blocked'
  if (line.error !== undefined) return 'error'
  if (kind === 'halt') {
    if (d.haltApplied) return 'halted'
    if (d.haltSuppressedStale) return 'halt-suppressed'
    return 'halted'
  }
  if (d.permission === 'deny') return 'deny'
  if (d.permission === 'ask') return 'ask'
  if (d.permission === 'allow') return 'allow'
  return 'ok'
}

/** Whether a status is a failure/blocking one (drives the error accent). */
export function isHookCardBlocking(status: HookCardStatus): boolean {
  return status === 'deny' || status === 'blocked' || status === 'error' || status === 'halted'
}

/** Human label for a canonical/dialect event name (`afterToolUse` → `After tool use`). */
export function hookEventLabel(event: string): string {
  const spaced = event
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (spaced.length === 0) return event
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Card title: the human event label (e.g. `Stop`, `Before shell execution`). */
export function getHookCardTitle(card: HookCard): string {
  return hookEventLabel(card.event)
}

/** Short badge label for the card's status. */
export function getHookCardStatusLabel(card: HookCard): string {
  switch (card.status) {
    case 'allow':
      return 'Allowed'
    case 'deny':
      return 'Denied'
    case 'ask':
      return 'Asked'
    case 'halted':
      return 'Halted'
    case 'halt-suppressed':
      return 'Halt suppressed'
    case 'blocked':
      return 'Sandbox blocked'
    case 'error':
      return 'Error'
    case 'ok':
      return 'Ran'
  }
}
