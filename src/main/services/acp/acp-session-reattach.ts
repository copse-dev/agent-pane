import type { SessionUpdate } from '@agentclientprotocol/sdk'

/**
 * Reattaching a Copse thread to the ACP session it already had, from a new
 * agent process — after an idle reap, a dropped transport, or a config change
 * that forces a respawn (a new permission mode, sandbox, or working directory).
 * See docs/plans/acp-session-continuity.md.
 *
 * The pure policy lives here so it can be read and tested apart from the
 * connection plumbing in acp-client.ts.
 */

/** The session a new process should try to reattach to. */
export interface AcpSessionCarryOver {
  sessionId: string
  /** The cwd that session last ran in. A different spawn cwd is a move. */
  cwd: string
  /**
   * Whether the session has anything to lose: at least one prompt was sent
   * to it, or it was itself restored from one that had. Without history, a
   * load that replays nothing is not evidence of anything.
   */
  hasHistory: boolean
}

export type AcpReattachMethod = 'resume' | 'load'

/**
 * Why a new process could not carry the previous session over:
 * - `unsupported` — the agent advertises neither `session/resume` nor `session/load`;
 * - `moved-without-load` — the cwd changed and the agent cannot `session/load`
 *   (a resume across directories cannot be verified; see {@link acpReattachMethods});
 * - `rejected` — the agent refused every reattach Copse tried;
 * - `history-missing` — `session/load` succeeded but replayed none of the
 *   conversation, so the agent did not actually find it.
 */
export type AcpCarryOverFailure =
  | 'unsupported'
  | 'moved-without-load'
  | 'rejected'
  | 'history-missing'

/**
 * Which reattach methods to try, in order.
 *
 * In the same directory, resume first — it restores the agent's memory without
 * replaying the transcript — then load, the only method a load-only agent
 * (Cursor) has.
 *
 * After a move, load only. An agent that files its sessions per directory can
 * answer a resume from the new one with an empty session and no error, and
 * resume replays nothing, so Copse could not tell a real continuation from a
 * silent reset. A load replays the conversation before it returns, which proves
 * the agent found it. The continuity probe observed resume working across
 * directories for Claude Agent ACP 0.70.0 and Codex ACP 1.6.2, but that is two
 * adapter versions, not a protocol guarantee — and both also load.
 */
export function acpReattachMethods(
  caps: { resume: boolean; load: boolean },
  moved: boolean,
): AcpReattachMethod[] {
  if (moved) return caps.load ? ['load'] : []
  const methods: AcpReattachMethod[] = []
  if (caps.resume) methods.push('resume')
  if (caps.load) methods.push('load')
  return methods
}

/** The failure to report when {@link acpReattachMethods} left nothing to try. */
export function noReattachMethodFailure(
  caps: { resume: boolean; load: boolean },
  moved: boolean,
): AcpCarryOverFailure {
  if (!caps.resume && !caps.load) return 'unsupported'
  return moved ? 'moved-without-load' : 'unsupported'
}

/**
 * Whether a `session/update` received during `session/load` is the replayed
 * conversation rather than live session state. Copse already shows that
 * conversation in its own transcript, so these are counted and dropped: letting
 * them through the update pump would re-render the whole thread as new output.
 * State updates (commands, mode, config, title) still apply.
 */
export function isReplayedHistory(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
      return true
    default:
      return false
  }
}

/**
 * Split what arrived during a `session/load` into the replayed history and the
 * state updates to keep, and say whether the replay proves the conversation
 * was found: it must include at least one of the user's own messages.
 */
export function splitLoadReplay(updates: readonly SessionUpdate[]): {
  keep: SessionUpdate[]
  replayed: number
  foundConversation: boolean
} {
  const keep: SessionUpdate[] = []
  let replayed = 0
  let foundConversation = false
  for (const update of updates) {
    if (isReplayedHistory(update)) {
      replayed++
      if (update.sessionUpdate === 'user_message_chunk') foundConversation = true
    } else {
      keep.push(update)
    }
  }
  return { keep, replayed, foundConversation }
}

/**
 * A thread's previous agent session could not be carried into its new process,
 * so the turn starts a fresh session from Copse's transcript. Reported only
 * when that session had conversation to lose.
 */
export interface AcpSessionHandover {
  reason: AcpCarryOverFailure
  fromCwd: string
  toCwd: string
}

function handoverCause(handover: AcpSessionHandover): string {
  const where = handover.fromCwd === handover.toCwd ? '' : ` in \`${handover.toCwd}\``
  switch (handover.reason) {
    case 'moved-without-load':
      return (
        `It now works in \`${handover.toCwd}\` instead of \`${handover.fromCwd}\`, ` +
        'and it cannot load a session into a different directory.'
      )
    case 'unsupported':
      return `It had to restart${where}, and it cannot reopen a previous session.`
    case 'rejected':
      return `It restarted${where} but refused to reopen its previous session — it may have expired.`
    case 'history-missing':
      return `It restarted${where} and reopened its previous session, but with none of the conversation in it.`
  }
}

/**
 * The thread note for a handover. It says what the agent still has (the
 * visible conversation, replayed from Copse's transcript) and, just as
 * plainly, what it no longer has: the replay is text only, so the agent's own
 * tool calls and their output, the files it read, and its reasoning are gone.
 */
export function acpSessionHandoverNotice(handover: AcpSessionHandover, agentTitle: string): string {
  return (
    `_**${agentTitle} lost its earlier session.** ${handoverCause(handover)} ` +
    "It is continuing from Copse's transcript of this thread: your messages and its replies " +
    'carry over, but its earlier tool calls and their output, the files it read, and its ' +
    'reasoning do not. Ask it to re-check anything that depends on them._\n\n'
  )
}
