/**
 * The ACP half of deferred thread worktrees (docs/plans/deferred-thread-worktrees.md,
 * docs/plans/acp-session-continuity.md#whats-the-deferred-worktree-flow-must-do).
 *
 * An ACP agent's cwd and OS sandbox are fixed when its process starts, so it
 * cannot follow the thread into a worktree it asked for mid-turn. Its process
 * starts read-only against the user's checkout; `request_write_access` creates
 * the worktree and tells the agent to end its turn; the next turn is a
 * continuation that Copse starts under the worktree, where the session pool
 * respawns the agent and reattaches the same agent session.
 */

/** Appended to the `request_write_access` result the bridge returns to the agent. */
export const ACP_WRITE_ACCESS_HANDOFF_NOTE =
  'Your own file, git, and shell tools are still read-only in this process, so do not try to edit with them yet. ' +
  'End your turn now with one short sentence saying what you will change. Copse will restart you in the worktree with the same conversation, ' +
  'with write access, and send a message to continue. (Copse file and shell tools offered through this bridge already work in the worktree.)'

/** The message that opens the continuation turn, after the agent is restarted in the worktree. */
export function acpWriteAccessContinuationPrompt(root: string): string {
  return (
    `Write access is now available: you are running in this thread's own worktree at ${root}. ` +
    'Continue the task you were doing before you asked for it. If you had already finished, reply with one short sentence instead.'
  )
}

/**
 * Prompt note for a session that starts on a read-only checkout. It follows the
 * sandbox note, whose "writes are allowed inside the workspace" it overrides.
 */
export const ACP_READONLY_CHECKOUT_PROMPT_NOTE =
  "Read-only workspace: for now the workspace is a read-only view of the user's checkout. " +
  'Read, search, and inspect freely, but your own file, git, and shell tools cannot write there, ' +
  'despite the note above. When you are ready to change anything, first call the ' +
  '"request_write_access" tool on the "copse" MCP server (pass a short branch_name describing ' +
  'the change). It gives this thread its own worktree and branch; then end your turn as its ' +
  'result says, and you will be restarted there with write access and the same conversation. ' +
  'Do not retry a blocked write.'
