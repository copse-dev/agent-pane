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

  constructor(threadId: string) {
    super(`An agent turn is already running for thread "${threadId}"`)
  }
}

/** Whether `reason` is the dispatcher's busy rejection, in-process or across IPC. */
export function isAgentTurnBusyError(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === AGENT_TURN_BUSY_ERROR_NAME) return true
  return errorMessage(reason).includes(`${AGENT_TURN_BUSY_ERROR_NAME}:`)
}
