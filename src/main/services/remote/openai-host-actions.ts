import { z } from 'zod'
import type { StreamChunk } from '@shared/types'
import { openAiPrRequestSchema, type OpenAiHostTools } from './openai-host-tools.ts'
import {
  openAiFunctionResultSchema,
  type OpenAiFunctionCall,
  type OpenAiFunctionResult,
} from './openai-agents-api.ts'

export const openAiHostActionsSchema = z
  .array(
    z.object({
      turnId: z.string(),
      callId: z.string(),
      request: openAiPrRequestSchema,
      phase: z.enum(['queued', 'executing', 'done']),
      result: openAiFunctionResultSchema.optional(),
    }),
  )
  .max(8)
export type OpenAiHostActions = z.infer<typeof openAiHostActionsSchema>
type HostContext = {
  actions: OpenAiHostActions
  tools: OpenAiHostTools | undefined
  save: () => Promise<void>
  onChunk: (chunk: StreamChunk) => void
  signal: AbortSignal
}

export async function handleOpenAiHostCall(
  call: OpenAiFunctionCall,
  context: HostContext,
): Promise<OpenAiFunctionResult> {
  const { tools, actions, save, onChunk, signal } = context
  if (!tools?.definitions.some((tool) => tool.name === call.name))
    return { success: false, error: 'This host tool is not offered in this session.' }
  const id = `openai-host-${call.turn_id}-${call.call_id}`
  let result: OpenAiFunctionResult
  if (call.name === 'gh_pr_create') {
    const parsed = openAiPrRequestSchema.safeParse(call.arguments)
    if (!parsed.success)
      return { success: false, error: 'PR requests require title, body and draft only.' }
    const existing = actions.find((entry) => entry.turnId === call.turn_id)
    if (
      existing &&
      (existing.callId !== call.call_id ||
        JSON.stringify(existing.request) !== JSON.stringify(parsed.data))
    )
      return {
        success: false,
        error: 'A PR request is already queued for this turn. Finish exporting the changes.',
      }
    if (!existing) {
      if (actions.length >= 8) return { success: false, error: 'Host action limit reached.' }
      actions.push({
        turnId: call.turn_id,
        callId: call.call_id,
        request: parsed.data,
        phase: 'queued',
      })
      await save()
    }
    result = {
      success: true,
      output:
        'Queued for local approval and creation after this turn completes and its changes are imported. No PR has been opened. Run the required export command and finish the turn.',
    }
  } else {
    onChunk({ type: 'tool_call', toolCall: { id, name: call.name, args: call.arguments } })
    result = await tools.execute(call.name, call.arguments, id, signal)
    onChunk({
      type: 'tool_result',
      toolCallId: id,
      result: result.output ?? result.error ?? '',
      isError: !result.success,
    })
  }
  return result
}

/** Call only after successful turn completion and Git adoption. */
export async function finishOpenAiHostActions(context: HostContext): Promise<string> {
  const { actions, tools, save, onChunk, signal } = context
  let text = ''
  for (const action of actions) {
    signal.throwIfAborted()
    const id = `openai-publish-${action.turnId}-${action.callId}`
    onChunk({ type: 'tool_call', toolCall: { id, name: 'gh_pr_create', args: action.request } })
    if (action.phase === 'executing') {
      // A crash may have happened after GitHub accepted the write. Never guess and replay.
      action.result = {
        success: false,
        error:
          'PR creation was interrupted and its outcome is uncertain. Check GitHub before requesting it again; Copse has not repeated the write.',
      }
      action.phase = 'done'
      await save()
    } else if (action.phase === 'queued') {
      if (!tools) throw new Error('Restore the host tool bridge to finish this queued PR request.')
      action.phase = 'executing'
      await save()
      action.result = await tools.execute('gh_pr_create', action.request, id, signal)
      action.phase = 'done'
      await save()
    }
    const result = action.result ?? { success: false, error: 'No saved PR result is available.' }
    const message = result.output ?? result.error ?? 'No PR result was returned.'
    onChunk({ type: 'tool_result', toolCallId: id, result: message, isError: !result.success })
    text += `\n\n${message}`
  }
  if (text) onChunk({ type: 'text', text })
  return text
}
