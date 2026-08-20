/**
 * Shared types and text for the shell auto-approval classifier.
 *
 * Kept free of Node built-ins so the Settings renderer can import it; the
 * classifier itself (which depends on `shell-scope.ts` and `shell-quote`) lives
 * in `src/main/services/security/auto-approval.ts`.
 *
 * The feature answers the prompt-fatigue half of principle #3 in
 * `docs/threat-model.md`: a control that makes everyday work painful gets turned
 * off, and a disabled control protects nothing. Everyday agent work is dominated
 * by a handful of shapes — `git fetch origin main`, `git push origin <branch>`,
 * `gh pr create` — that are external (so they prompt today) yet carry a bounded,
 * recoverable blast radius. The classifier recognises those shapes
 * DETERMINISTICALLY and lets them run without a prompt, so approvals are spent on
 * genuinely novel actions instead.
 *
 * It is a UX lever layered on the existing gate, never a new boundary. See the
 * classifier for the exact eligibility rules and the safety argument.
 */

/** Setting key holding the highest auto-approval tier the user has enabled. */
export const AUTO_APPROVAL_LEVEL_SETTING = 'shellAutoApprovalLevel'

/**
 * The tiers a command can be classified into, ordered by blast radius. A tier is
 * honoured only when the user's configured level is at least that tier, and each
 * level includes every tier below it.
 *
 * - `off` — classify nothing; every command that prompts today keeps prompting.
 * - `read` — no mutation anywhere and no repo-controlled code execution: local
 *   reads (`ls`, `grep`, `git status`/`log`/`diff`) plus network *reads* against
 *   a remote already configured in the repository (`git fetch origin`,
 *   `gh pr view`).
 * - `local-write` — additionally mutates the local repository (`git add`,
 *   `git commit`, `git checkout -b`, `git stash`). These run repo-controlled git
 *   hooks, so this tier can execute code the repository supplies.
 * - `remote-write` — additionally writes to a remote the user configured
 *   (`git push` without force, `gh pr create`, `gh issue comment`).
 */
export const AUTO_APPROVAL_LEVELS = ['off', 'read', 'local-write', 'remote-write'] as const

export type AutoApprovalLevel = (typeof AUTO_APPROVAL_LEVELS)[number]

/** A tier a classified command lands in — every level except the `off` sentinel. */
export type AutoApprovalTier = Exclude<AutoApprovalLevel, 'off'>

/**
 * Blast-radius ordering. A command classified at tier T runs without a prompt
 * only when `AUTO_APPROVAL_RANK[level] >= AUTO_APPROVAL_RANK[T]`.
 */
export const AUTO_APPROVAL_RANK: Readonly<Record<AutoApprovalLevel, number>> = {
  off: 0,
  read: 1,
  'local-write': 2,
  'remote-write': 3,
}

/** The level shipped by default: reads only — nothing that mutates or runs hooks. */
export const DEFAULT_AUTO_APPROVAL_LEVEL: AutoApprovalLevel = 'read'

export const AUTO_APPROVAL_LEVEL_LABELS: Readonly<Record<AutoApprovalLevel, string>> = {
  off: 'Off — approve every external command',
  read: 'Reads — local reads and fetches from a configured remote',
  'local-write': 'Reads + local commits — also git add/commit/checkout/stash',
  'remote-write': 'Reads + local commits + pushes — also git push and gh pr create',
}

export function isAutoApprovalLevel(value: unknown): value is AutoApprovalLevel {
  return typeof value === 'string' && (AUTO_APPROVAL_LEVELS as readonly string[]).includes(value)
}

/** Validate a value coming off the settings store or a form, falling back to the default. */
export function sanitizeAutoApprovalLevel(value: unknown): AutoApprovalLevel {
  return isAutoApprovalLevel(value) ? value : DEFAULT_AUTO_APPROVAL_LEVEL
}

/** Whether `tier` is permitted at the configured `level`. */
export function autoApprovalLevelAllows(level: AutoApprovalLevel, tier: AutoApprovalTier): boolean {
  return AUTO_APPROVAL_RANK[level] >= AUTO_APPROVAL_RANK[tier]
}

/**
 * Write tiers run repo-controlled git hooks. Without an OS sandbox those execute
 * with the user's full host privilege (GA ledger N1). Cap at `read` so a
 * Windows session — or a macOS/Linux session after ASRT init failed — cannot
 * honour `local-write` / `remote-write` uncontained. `off` stays `off`.
 * `resolveAutoApproval` now refuses every tier unless the sandbox is active;
 * this cap remains so a write-tier cannot leak if a caller skips that gate.
 */
export function effectiveAutoApprovalLevel(
  configured: AutoApprovalLevel,
  sandboxEnabled: boolean,
): AutoApprovalLevel {
  if (sandboxEnabled || configured === 'off' || configured === 'read') return configured
  return 'read'
}
