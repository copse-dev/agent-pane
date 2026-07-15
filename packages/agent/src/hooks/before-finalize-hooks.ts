// Named `beforeFinalize` hooks — Milestone 0.3 of the hooks platform.
//
// These lift the open-todos closeout nudge selection out of `runAgentLoop`.
// Each hook returns `injectContext` (the nudge text) or abstains; the harness
// still owns the closeout loop that runs tool-enabled nudge turns and the
// still-open note (M0.3 scope). `STUCK_FINALIZE_NUDGE` is deliberately not
// here — it fires mid-loop under context pressure and stays for E1.
import type { BlockingHook } from './canonical-events.ts'
import {
  hasOpenTodos,
  MAX_TODO_CLOSEOUT_ATTEMPTS,
  OPEN_TODOS_FINALIZE_NUDGE,
  OPEN_TODOS_FINALIZE_NUDGE_STRICT,
} from '../agent-loop-guards.ts'

/**
 * Open-todos closeout nudge at finalize. Escalates after the first attempt and
 * abstains once {@link MAX_TODO_CLOSEOUT_ATTEMPTS} is exhausted so the harness
 * can fall through to the still-open note / text-only finalize.
 */
export const todoFinalizeCloseoutHook: BlockingHook<'beforeFinalize'> = {
  id: 'todo-finalize-closeout',
  event: 'beforeFinalize',
  run(payload) {
    if (!hasOpenTodos(payload.openTodos)) return undefined
    if (payload.attempt < 0 || payload.attempt >= MAX_TODO_CLOSEOUT_ATTEMPTS) {
      return undefined
    }
    const nudge =
      payload.attempt === 0 ? OPEN_TODOS_FINALIZE_NUDGE : OPEN_TODOS_FINALIZE_NUDGE_STRICT
    return { injectContext: nudge }
  },
}

/**
 * Finalize hooks in the order the previous inline closeout policy ran.
 * Changing this order (or the attempt→nudge mapping) is a behavior change.
 */
export const BEFORE_FINALIZE_HOOKS: readonly BlockingHook<'beforeFinalize'>[] = [
  todoFinalizeCloseoutHook,
]
