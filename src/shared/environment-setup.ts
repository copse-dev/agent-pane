/**
 * Wire types for environment setup: suggestions, drawn from the prompts a user
 * keeps approving, for the fixed-rule permission settings that would have
 * removed them. See `docs/plans/environment-setup.md`.
 *
 * Kept free of Node built-ins so the renderer can import it.
 */

/** The existing setting each suggestion would change. */
export const ENVIRONMENT_SUGGESTION_KINDS = [
  'auto-approval-level',
  'trusted-command',
  'web-origin',
  'trusted-ssh-host',
  'trusted-package-registry',
] as const

export type EnvironmentSuggestionKind = (typeof ENVIRONMENT_SUGGESTION_KINDS)[number]

export interface EnvironmentSuggestion {
  /** Opaque, issued by main for this review only. */
  id: string
  kind: EnvironmentSuggestionKind
  /** The level, command basename, origin, host or registry the change adds. */
  value: string
  /** Short user-facing description of the change. */
  label: string
  /** The setting's existing risk copy. */
  risk: string
  /** Prompts you approved that this change would have removed. */
  approvals: number
  /** Threads those approvals came from. */
  threads: number
  /** Most recent approval, epoch milliseconds. */
  lastAt: number
  /** Up to three recent examples (redacted commands, or the origin). */
  examples: string[]
  /** Whether the item starts ticked. */
  checked: boolean
  /** You refused a prompt this change would also have removed; it cannot be ticked. */
  declined: boolean
}

export interface EnvironmentSetupReview {
  reviewId: string
  suggestions: EnvironmentSuggestion[]
  /** Days of history the suggestions draw on. */
  windowDays: number
}

export interface EnvironmentSetupStatus {
  /** Show the composer offer. */
  offer: boolean
  /** Approved prompts the current suggestions would have removed. */
  promptCount: number
}

export interface EnvironmentSetupChange {
  kind: EnvironmentSuggestionKind
  value: string
  label: string
}

export interface EnvironmentSetupApplyResult {
  applied: EnvironmentSetupChange[]
  /** Pass to `undo` while the app keeps running; null when nothing changed. */
  undoId: string | null
}

export interface EnvironmentSetupClient {
  status(): Promise<EnvironmentSetupStatus>
  review(): Promise<EnvironmentSetupReview>
  /** Apply the ticked suggestions of a review main issued. Values come from main. */
  apply(reviewId: string, suggestionIds: string[]): Promise<EnvironmentSetupApplyResult>
  /** Remove exactly what one apply added. */
  undo(undoId: string): Promise<EnvironmentSetupChange[]>
  /** Hide the offer: for two weeks, or for good. */
  dismiss(forever: boolean): Promise<void>
}
