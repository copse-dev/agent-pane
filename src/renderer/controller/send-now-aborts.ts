/**
 * Threads whose in-flight run the user interrupted by sending a queued prompt
 * now, as opposed to pressing Stop.
 *
 * Main records every user cancellation the same way (`status: 'cancelled'`,
 * `source: 'user'`), and the transcript cannot tell the two apart afterwards:
 * a prompt queued mid-run keeps its early timestamp and is drained right after
 * the cancelled turn whichever way the run was stopped. So the cause is noted
 * here at the moment of abort and stamped onto the turn's outcome when it
 * arrives (see the agent controller). A mark lives only until the run's `done`.
 */
const sendNowThreads = new Set<string>()

/** Note that this thread's run is being aborted by a send-now. */
export function markSendNowAbort(threadId: string): void {
  sendNowThreads.add(threadId)
}

/** Consume the mark: true when the run being cancelled was aborted by send-now. */
export function takeSendNowAbort(threadId: string): boolean {
  return sendNowThreads.delete(threadId)
}
