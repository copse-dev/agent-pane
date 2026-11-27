import { errorMessage } from './errors.ts'

/**
 * Name of the error the main-process dispatcher throws when a thread already has
 * an agent turn in flight. Electron carries only an invoke rejection's text over
 * IPC (`Error invoking remote method 'agent:run': AgentTurnBusyError: …`), so the
 * renderer recognises the rejection by this name rather than by class (#1881).
 */
export const AGENT_TURN_BUSY_ERROR_NAME = 'AgentTurnBusyError'

export class AgentTurnBusyError extends Error {
  override readonly name = AGENT_TURN_BUSY_ERROR_NAME

  /** `elsewhere` names the other Copse process that holds the thread's writer lease. */
  constructor(threadId: string, elsewhere?: string) {
    super(
      elsewhere === undefined
        ? `An agent turn is already running for thread "${threadId}"`
        : `Thread "${threadId}" is being run by another Copse process (${elsewhere})`,
    )
  }
}

/** Whether `reason` is the dispatcher's busy rejection, in-process or across IPC. */
export function isAgentTurnBusyError(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === AGENT_TURN_BUSY_ERROR_NAME) return true
  return errorMessage(reason).includes(`${AGENT_TURN_BUSY_ERROR_NAME}:`)
}
