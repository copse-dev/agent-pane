import { acpReauthCommand, findAcpCatalogEntry } from '@shared/acp-known-agents.ts'
import type { AcpAuthFailureKind } from '../agent-errors.ts'
import { requestUserAnswers } from '../ask-user.ts'
import { canRunTerminalCommand, requestTerminalCommand } from '../exec/terminal-launch.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { acpSshTarget, buildRemoteAcpLoginCommand } from './acp-ssh-transport.ts'

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

function offerQuestion(
  agentName: string,
  kind: AcpAuthFailureKind,
  command: string,
  hostId?: string,
): string {
  const cause =
    kind === 'expired'
      ? `${agentName}’s saved sign-in has expired, so this turn could not run.`
      : `${agentName} is not signed in, so this turn could not run.`
  const open = hostId
    ? `The agent runs on the SSH host ${hostId} and its credentials live there, ` +
      `so open a terminal connected to ${hostId} running \`${command}\` to sign in?`
    : `Open a terminal and run \`${command}\` to sign in again?`
  return (
    `${cause} ${open} ` +
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
  const known = findAcpCatalogEntry(offer.agentId)
  const command = acpReauthCommand(known)
  if (!command) return null
  // Don't ask a question we can't act on — with no Shells pane attached, the
  // error text's written instructions are already the whole answer.
  if (!canRunTerminalCommand()) return null

  // An agent that ran on an SSH host keeps its credential store there, so the
  // sign-in must happen there too. On an SSH workspace the Shells pane's tab is
  // itself a pty on the host, so the login command is typed into a shell that
  // is already remote — no ssh wrapper (nesting ssh on the host with this
  // machine's identity/socket paths is exactly how it breaks). A host that
  // vanished from settings mid-offer launches nothing.
  const target = acpSshTarget(getAgentExecutionRoot() ?? '')
  const launch = target ? buildRemoteAcpLoginCommand(command, target) : command
  if (!launch) return null
  const display = target ? `${command} (on ${target.hostId})` : command

  const accept = `Run \`${display}\``
  const { answers } = await requestUserAnswers({
    questions: [
      {
        question: offerQuestion(known?.title ?? offer.agentId, offer.kind, command, target?.hostId),
        options: [accept, 'Not now'],
      },
    ],
  })

  const answer = answers[0] ?? ''
  if (answer.trim() !== accept && !ACCEPT.test(answer)) return null
  return requestTerminalCommand(launch) ? display : null
}
