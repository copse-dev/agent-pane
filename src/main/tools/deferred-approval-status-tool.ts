import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import { readDeferredApprovals } from '../services/security/deferred-approval-store.ts'

/** A deferred request is informational until a human resolves it. */
export const deferredApprovalStatusTool = defineTool({
  name: 'deferred_approval_status',
  provenance: 'external',
  description:
    'Check the status of a deferred approval request from this thread. Pass the request id returned when the action was queued. Reading status does not approve or execute the action; continue independent work while it is pending.',
  parameters: z.object({
    id: z.uuid().describe('Request id from the queued approval result.'),
  }),
  async execute({ id }) {
    const context = getThreadExecutionContext()
    if (!context) return 'No active thread.'
    const requests = await readDeferredApprovals(context.projectId)
    const request = requests.find((entry) => entry.id === id && entry.threadId === context.threadId)
    if (!request) return 'No deferred approval with that id belongs to this thread.'
    if (request.status === 'pending') {
      return `Request ${id} is pending human review. The action has not run. Do not retry or reroute it.`
    }
    if (request.status === 'rejected') {
      return `Request ${id} was rejected. The action has not run.${request.note ? ` Note: ${request.note}` : ''}`
    }
    return `Request ${id} was approved. Approval is a decision record, not proof that the action ran; verify the current state before acting.`
  },
})
