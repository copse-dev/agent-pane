import { acpReauthCommand, KNOWN_ACP_AGENTS } from '@shared/acp-known-agents.ts'
import type { AcpAuthFailureKind } from '../agent-errors.ts'
import { requestUserAnswers } from '../ask-user.ts'
import { canRunTerminalCommand, requestTerminalCommand } from '../exec/terminal-launch.ts'

/**
 * Offer to re-authenticate an external ACP agent whose turn just failed on
 * credentials, and — if the user accepts — open a shell already running its
 * login command.
 *
 * Copse cannot sign the user in itself: an ACP agent is a separate program with
 * its own credential store, deliberately isolated from Copse's provider keys.
 * The best it can do is name the right command and put the user in front of it,
 * which is the gap this closes — an expired token previously surfaced as a raw
 * `ACP error -32603 (Internal error)` with no route back to a working session.
 */
export interface AcpReauthOffer {
  agentId: string
  kind: AcpAuthFailureKind
}

/**
 * Answers that mean "yes, sign me in". The ask dialog lets the user type
 * anything, so anything unrecognised counts as a decline — opening a terminal
 * uninvited is the outcome worth being conservative about, and a blank answer
 * (window closed, ask timed out, headless host) lands here too.
 */
const ACCEPT = /^\s*(?:y|yes|ok|okay|sure|sign in\b.*|log ?in\b.*|run\b.*)\s*$/i

function offerQuestion(agentName: string, kind: AcpAuthFailureKind, command: string): string {
  const cause =
    kind === 'expired'
      ? `${agentName}’s saved sign-in has expired, so this turn could not run.`
      : `${agentName} is not signed in, so this turn could not run.`
  return (
    `${cause} Open a terminal and run \`${command}\` to sign in again? ` +
    `Copse can’t complete the sign-in for you — finish it in that terminal, then re-send your message.`
  )
}

/**
 * Ask whether to launch the agent's login command, and launch it on acceptance.
 * Returns the command that was started, or `null` when nothing ran: an unknown /
 * custom agent with no catalog login command, no terminal surface to run it in
 * (headless), or the user declining.
 */
export async function offerAcpReauth(offer: AcpReauthOffer): Promise<string | null> {
  const known = KNOWN_ACP_AGENTS.find((agent) => agent.id === offer.agentId)
  const command = acpReauthCommand(known)
  if (!command) return null
  // Don't ask a question we can't act on — with no Shells pane attached, the
  // error text's written instructions are already the whole answer.
  if (!canRunTerminalCommand()) return null

  const accept = `Run \`${command}\``
  const { answers } = await requestUserAnswers({
    questions: [
      {
        question: offerQuestion(known?.title ?? offer.agentId, offer.kind, command),
        options: [accept, 'Not now'],
      },
    ],
  })

  const answer = answers[0] ?? ''
  if (answer.trim() !== accept && !ACCEPT.test(answer)) return null
  return requestTerminalCommand(command) ? command : null
}
