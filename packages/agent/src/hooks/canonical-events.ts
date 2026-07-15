// Canonical events — Milestone 0.1 of the hooks platform.
//
// A *canonical event* is a named point where the harness calls the registry
// (glossary, docs/plans/hooks-and-feature-packs.md). Harness code fires
// canonical events only; it never knows dialects or executor kinds exist. The
// event names are final — changing one is a decisions-log edit, not a refactor.
//
// M0 wires only the two blocking *assembly* events used to lift the inline
// todo behavior out of the core files:
//
//   - `turnStart`      fires in `runAgent` after the system prompt is built,
//                      before the loop (steering, prior-todos pin). Wired in
//                      M0.2 — named hooks own the policy; `messages[0]` string
//                      surgery stays in `runAgent`.
//   - `beforeFinalize` fires in `runAgentLoop`'s finalize checks (open-todos
//                      closeout nudge selection). Wired in M0.3 — named hooks
//                      own the nudge / attempt-budget policy; the closeout
//                      loop and still-open note stay in `runAgentLoop`.
//
// The payload shapes below carry what those fire sites hand their hooks.
import type { TodoItem } from '../wire-types.ts'
import type { BlockingHookOutcome, AsyncHookOutcome } from './hook-outcome.ts'

/**
 * Payload for `turnStart`. Steering hooks read the raw user text to decide which
 * prompt blocks to add and see the carried-over todos for the prior-todos pin.
 */
export interface TurnStartPayload {
  /** Raw user message text used for steering decisions (redaction-independent). */
  userText: string
  /** Todos carried over from prior turns (drives the prior-todos pin). */
  priorTodos: readonly TodoItem[]
}

/**
 * Payload for `beforeFinalize`. The closeout hook escalates its nudge after the
 * first attempt, so the attempt index travels with the still-open todos.
 */
export interface BeforeFinalizePayload {
  /** Todos still open (pending / in_progress) at the finalize checkpoint. */
  openTodos: readonly TodoItem[]
  /** Zero-based closeout attempt index; nudge text escalates after the first. */
  attempt: number
}

/** Payload each canonical event delivers to its hooks, keyed by event name. */
export interface HookEventPayloads {
  turnStart: TurnStartPayload
  beforeFinalize: BeforeFinalizePayload
}

/** Every canonical event name wired in this milestone. Order is registration-neutral. */
export const HOOK_EVENT_NAMES = ['turnStart', 'beforeFinalize'] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

/** How the harness dispatches an event: awaited in the critical path, or detached. */
export type HookDispatch = 'blocking' | 'async'

/** What an event is for: assembles the prompt, decides an action, or observes. */
export type HookRole = 'assembly' | 'decision' | 'observation'

export interface HookEventSpec {
  name: HookEventName
  dispatch: HookDispatch
  role: HookRole
}

/**
 * Static metadata for every canonical event. Both M0.1 events are blocking
 * assembly events; the `Record<HookEventName, …>` key type makes a missing
 * entry a compile error, so this table stays complete as events are added.
 */
export const HOOK_EVENT_SPECS: Record<HookEventName, HookEventSpec> = {
  turnStart: { name: 'turnStart', dispatch: 'blocking', role: 'assembly' },
  beforeFinalize: { name: 'beforeFinalize', dispatch: 'blocking', role: 'assembly' },
}

/**
 * Cross-cutting services and signals a hook receives alongside its event
 * payload. First-party (function) hooks receive app services *here*, never by
 * importing them — that is what keeps `packages/agent` Electron-free
 * (execution-guidance rule 4). M0.2's turn-start hooks need the abort signal
 * plus an optional GitHub-slug resolver; later phases widen this further.
 */
export interface HookContext {
  /** Abort signal for the current run; hooks should bail out if it fires. */
  signal?: AbortSignal
  /**
   * Resolve the workspace GitHub `org/repo` slug, or null when the remote is
   * missing / not GitHub. Provided by the host so `github-link-steering` never
   * imports the app's git service.
   */
  resolveGithubRepoSlug?: () => Promise<string | null>
}

type MaybePromise<T> = T | Promise<T>

/**
 * A first-party *blocking* hook: an in-process function that runs in the
 * harness's critical path. Fail-hard (decision 9) — a throw is a bug, surfaced
 * loudly, never swallowed into an allow.
 */
export type BlockingHookFn<E extends HookEventName = HookEventName> = (
  payload: HookEventPayloads[E],
  context: HookContext,
) => MaybePromise<BlockingHookOutcome | undefined>

/**
 * A first-party *async* (detached) hook. No async canonical events are wired in
 * M0.1, but the executor-kind + outcome split exists from day one so decisions 4
 * & 11 are enforced by the compiler the moment async events land (Phase C).
 */
export type AsyncHookFn<TPayload = unknown> = (
  payload: TPayload,
  context: HookContext,
) => MaybePromise<AsyncHookOutcome | undefined>

/** A registered first-party blocking hook: a stable id, its event, and its handler. */
export interface BlockingHook<E extends HookEventName = HookEventName> {
  /** Stable id for spine attribution, the Sources UI, and dedup. */
  id: string
  /** Canonical event this hook subscribes to. */
  event: E
  // Method syntax (bivariant params) lets hooks for different events share one
  // storage list in the registry without a cast; the public `register`/`emit`
  // surface preserves per-event type safety at the boundaries. A hook with no
  // opinion returns `undefined` (the house style bans `void` in a union).
  run(
    payload: HookEventPayloads[E],
    context: HookContext,
  ): MaybePromise<BlockingHookOutcome | undefined>
}
