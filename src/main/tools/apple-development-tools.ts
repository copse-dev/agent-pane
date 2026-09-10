import { z } from 'zod'
import { defineTool } from '@shared/types'
import {
  appleConfigureInputSchema,
  appleExecuteInputSchema,
  appleOperationInputSchema,
} from '@shared/types/apple-development.ts'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { getActiveRunTurnTreeId } from '../services/thread-models.ts'
import {
  getAppleDevelopmentService,
  type AppleInvocation,
} from '../services/apple-development/apple-development-service.ts'

function invocation(signal: AbortSignal): AppleInvocation {
  const turnTreeId = getActiveRunTurnTreeId()
  return {
    owner: requireThreadExecutionOwner(),
    source: 'agent' as const,
    signal,
    ...(turnTreeId ? { turnTreeId } : {}),
  }
}

function present(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export const appleDiscoverTool = defineTool({
  name: 'apple_discover',
  description:
    'Inspect Apple Development setup for this thread. With refresh=false, probe the host and find Xcode projects without invoking project metadata commands. With refresh=true, also ask installed Xcode for schemes and available destinations; this can resolve dependencies, report unavailable project metadata, and requires per-call user approval.',
  parameters: z.object({ refresh: z.boolean().optional() }),
  async execute({ refresh }, signal) {
    const state = await getAppleDevelopmentService().discover(invocation(signal), refresh === true)
    return present(state)
  },
})

export const appleConfigureTool = defineTool({
  name: 'apple_configure',
  description:
    'Select a discovered Xcode workspace/project, scheme, configuration, and explicit destination for this thread. Pass the current selection revision (0 before the first selection).',
  parameters: appleConfigureInputSchema,
  async execute(input, signal) {
    return present(await getAppleDevelopmentService().configure(invocation(signal), input))
  },
})

export const appleExecuteTool = defineTool({
  name: 'apple_execute',
  description:
    'Queue a supervised build, test, or Simulator run for this thread’s captured Apple target. Agent calls require per-call user approval. Requires the current selection revision and a request ID; exact retries deduplicate.',
  parameters: appleExecuteInputSchema,
  async execute(input, signal) {
    const operation = await getAppleDevelopmentService().execute(invocation(signal), input)
    return present({
      operationId: operation.id,
      target: operation.target,
      status: operation.status,
      completionDelivery: 'poll',
    })
  },
})

export const appleOperationTool = defineTool({
  name: 'apple_operation',
  description:
    'Read status or bounded logs for an Apple operation owned by this thread, or cancel it idempotently. Operation IDs from other threads are inaccessible.',
  parameters: appleOperationInputSchema,
  async execute({ operationId, action, logCursor }, signal) {
    const call = invocation(signal)
    if (action === 'cancel') {
      return present(await getAppleDevelopmentService().cancel(call, operationId))
    }
    const page = getAppleDevelopmentService().operation(call, operationId, logCursor)
    return present(action === 'status' ? page.operation : page)
  },
})

export const appleAppStopTool = defineTool({
  name: 'apple_app_stop',
  description:
    'Stop an iOS Simulator app session launched by this thread. Agent calls require per-call user approval. It never terminates unrelated simulator apps.',
  parameters: z.object({ appSessionId: z.string().min(1).max(256) }),
  async execute({ appSessionId }, signal) {
    const stopped = await getAppleDevelopmentService().stopApp(invocation(signal), appSessionId)
    return stopped
      ? `Stopped Apple app session ${appSessionId}.`
      : 'The app session is no longer running.'
  },
})

export const appleDevelopmentTools = [
  appleDiscoverTool,
  appleConfigureTool,
  appleExecuteTool,
  appleOperationTool,
  appleAppStopTool,
] as const
