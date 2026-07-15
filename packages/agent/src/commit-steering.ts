// Commit turn-start steering — owned by `@copse/agent` so first-party hooks can
// use it without importing the host app (execution-guidance rule 4). The
// Co-Authored-By trailer helpers stay in `@shared/git/commit-attribution` (used
// by the git commit path); only the prompt-steering surface lives here.
// `@shared` re-exports these for existing consumers.

/** True when the user's message is about making a commit (commit, committed, committing, commits). */
export function shouldSteerCommit(userMessage: string): boolean {
  return /\bcommit(s|ted|ting)?\b/i.test(userMessage)
}

/** Contextual steering: prefer the git_commit tool so attribution is added automatically. */
export function buildCommitSteeringPrompt(): string {
  return 'When you create a commit, use the git_commit tool rather than `run_shell git commit` so the Co-Authored-By: Copse trailer and the models used are added automatically.'
}
