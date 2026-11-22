// Lives in `@copse/thread-store` (the store persists worktree bindings); re-exported for `@shared/types`.
export * from '@copse/thread-store/worktree-types.ts'

/**
 * Where a new thread's worktree starts when its first-message checkout names no
 * base branch. Never persisted: it is a property of *who* is starting the
 * thread, decided by the caller of `prepareCheckout`.
 *
 * - `default-branch` — the repository default, which allocation then resolves
 *   to a freshly fetched `origin/<default>`. Every machine-initiated start uses
 *   this: an accepted `propose_thread` card, a subthread, a `send_thread_prompt`
 *   to a blank thread, an automation run. Nobody looked at the project
 *   checkout when those were started, so whatever branch it happens to be
 *   parked on is no signal at all — inheriting it is how proposed threads came
 *   to be cut from a weeks-old feature branch.
 * - `project-branch` — the project checkout's current branch (then the
 *   default). Only a human composing in front of a visible branch picker uses
 *   this, because the picker shows that branch whenever it cannot offer the
 *   default, and the thread must start where the user was shown it would.
 */
export const THREAD_BASE_FALLBACKS = ['default-branch', 'project-branch'] as const
export type ThreadBaseFallback = (typeof THREAD_BASE_FALLBACKS)[number]
