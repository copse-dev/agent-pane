import type { WebContents } from 'electron'
import type { ApprovalRequest, ApprovalResponse } from './approval.ts'
import { confirmNativeAction } from './native-human-confirmation.ts'

/** The app renderer proposes an answer; only this main-owned dialog can approve it. */
export async function confirmNativeApproval(
  sender: WebContents,
  request: ApprovalRequest,
  proposed: ApprovalResponse,
  signal: AbortSignal,
): Promise<boolean> {
  const grants = [
    proposed.remember
      ? (request.rememberLabel ?? request.approveLabel ?? 'Remember this permission.')
      : proposed.grantScope === 'turn-tree'
        ? 'Allow this request and the bounded retries below.'
        : (request.approveOnceLabel ?? 'Allow this request once.'),
    ...(proposed.grantScope === 'turn-tree'
      ? [request.turnTreeLeaseLabel ?? 'Allow bounded retries in this task.']
      : []),
  ]
  const detail = [request.bodyAdvice, request.body, request.bodyFooter, '', ...grants]
    .filter((part) => part !== undefined)
    .join('\n\n')

  return confirmNativeAction(sender, { title: request.title, detail }, signal)
}
