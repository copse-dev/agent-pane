import { AcpTurnEnded, type AcpTurnEndReason } from './turn-end.ts'

// Generic over the bound context: importing the real type (even type-only) would put
// thread-execution-context's heavy graph in reach of the stdout-owning ACP workers, which
// scripts/stdout-protocol-guard.test.ts forbids.

/**
 * A coding agent can resume itself after its turn ended (a background-task
 * notification re-enters the model) without Copse sending a prompt. Copse never
 * opened a turn for that work, so the bridge has no execution context to bind
 * and rejects every tool call. This lease treats the self-started turn as a
 * machine-initiated continuation (hooks-and-feature-packs decision 5): it
 * charges the shared continuation budget, holds the agent's bridged calls until
 * that is settled, and binds the thread's persisted context for the duration.
 */

export type AgentInitiatedTurnClaim =
  | { status: 'granted'; turnTreeId: string; release: () => Promise<void> }
  | { status: 'budget-exhausted' }

export interface AgentInitiatedTurnAuthority {
  claimAgentInitiatedTurn: (
    projectId: string,
    threadId: string,
    options: { override: boolean },
  ) => Promise<AgentInitiatedTurnClaim>
}

let authority: AgentInitiatedTurnAuthority | null = null

export function setAgentInitiatedTurnAuthority(next: AgentInitiatedTurnAuthority | null): void {
  authority = next
}

export interface AgentTurnBridge<TContext> {
  setExecutionContext: (context: TContext | null, turnTreeId?: string) => void
  setTurnSignal: (signal: AbortSignal | null) => void
  setPendingExecutionContext: (pending: Promise<TContext | null> | null) => void
}

export interface AgentInitiatedTurnLeaseDeps<TContext> {
  projectId: string
  threadId: string
  bridge: AgentTurnBridge<TContext>
  resolveContext: (projectId: string, threadId: string) => Promise<TContext>
  /** Ask the human whether an over-budget self-resume may keep working. */
  confirmContinue: () => Promise<boolean>
  /** Mark the worktree as having a live writer; returns the release. */
  beginWriter: () => () => void
  getAuthority?: () => AgentInitiatedTurnAuthority | null
  idleMs?: number
}

export interface AgentInitiatedTurnLease {
  /** The agent produced turn output while no Copse prompt was outstanding. */
  begin: () => void
  /** More agent output during its own turn: restarts the idle clock. */
  touch: () => void
  /** The self-started turn finished, a Copse turn took over, or the session closed. */
  end: (reason?: AcpTurnEndReason) => void
  /** A self-started turn is in progress (between `begin` and `end`). */
  isActive: () => boolean
}

/** Nothing ends a self-started turn on agents that do not mark it, so bound the binding. */
const DEFAULT_IDLE_MS = 15 * 60 * 1000

export function createAgentInitiatedTurnLease<TContext>(
  deps: AgentInitiatedTurnLeaseDeps<TContext>,
): AgentInitiatedTurnLease {
  const getAuthority = deps.getAuthority ?? ((): AgentInitiatedTurnAuthority | null => authority)
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS
  let abort: AbortController | null = null
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let releaseBudget: (() => Promise<void>) | null = null
  let releaseWriter: (() => void) | null = null
  let bound = false

  const armIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      end('idle-timeout')
    }, idleMs)
    idleTimer.unref()
  }

  // Read through a call: the signal flips while this awaits, which a plain read
  // of `turn.signal.aborted` would not see past its narrowing.
  const isEnded = (turn: AbortController): boolean => turn.signal.aborted

  const settle = async (turn: AbortController): Promise<TContext | null> => {
    const owner = getAuthority()
    if (!owner) return null
    let claim = await owner.claimAgentInitiatedTurn(deps.projectId, deps.threadId, {
      override: false,
    })
    if (claim.status === 'budget-exhausted') {
      if (!(await deps.confirmContinue()) || isEnded(turn)) return null
      claim = await owner.claimAgentInitiatedTurn(deps.projectId, deps.threadId, {
        override: true,
      })
    }
    if (claim.status !== 'granted') return null
    if (isEnded(turn)) {
      await claim.release()
      return null
    }
    releaseBudget = claim.release
    const context = await deps.resolveContext(deps.projectId, deps.threadId)
    if (isEnded(turn)) return null
    deps.bridge.setExecutionContext(context, claim.turnTreeId)
    bound = true
    releaseWriter = deps.beginWriter()
    return context
  }

  function begin(): void {
    if (abort) {
      armIdle()
      return
    }
    const turn = new AbortController()
    abort = turn
    deps.bridge.setTurnSignal(turn.signal)
    const pending = settle(turn).catch((err: unknown) => {
      console.error(
        `[acp-agent-turn] could not bind thread ${deps.threadId} for the agent's own turn:`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    })
    deps.bridge.setPendingExecutionContext(pending)
    armIdle()
  }

  function end(reason: AcpTurnEndReason = 'completed'): void {
    clearTimeout(idleTimer)
    const turn = abort
    if (!turn) return
    abort = null
    turn.abort(new AcpTurnEnded(reason))
    deps.bridge.setPendingExecutionContext(null)
    if (bound) deps.bridge.setExecutionContext(null)
    deps.bridge.setTurnSignal(null)
    bound = false
    releaseWriter?.()
    releaseWriter = null
    const release = releaseBudget
    releaseBudget = null
    void release?.().catch(() => {})
  }

  return {
    begin,
    touch: (): void => {
      if (abort) armIdle()
    },
    end,
    isActive: (): boolean => abort !== null,
  }
}
