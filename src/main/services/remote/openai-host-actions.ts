import { z } from 'zod'
import { GITHUB_WRITE_TOOLS } from '../security/permission-policy.ts'
import type { StreamChunk } from '@shared/types'
import type { OpenAiHostTools } from './openai-host-tools.ts'
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
      name: z.string().default('gh_pr_create'),
      request: z.record(z.string(), z.unknown()),
      phase: z.enum(['queued', 'executing', 'done']),
      result: openAiFunctionResultSchema.optional(),
    }),
  )
  .max(64)
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
  if (GITHUB_WRITE_TOOLS.has(call.name)) {
    const parsed = z.record(z.string(), z.unknown()).safeParse(call.arguments)
    if (!parsed.success) return { success: false, error: 'Tool arguments must be an object.' }
    try {
      tools.validate(call.name, parsed.data)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid tool arguments.',
      }
    }
    const existing = actions.find(
      (entry) =>
        entry.turnId === call.turn_id &&
        (entry.callId === call.call_id ||
          (call.name === 'gh_pr_create' && entry.name === call.name)),
    )
    if (
      existing &&
      (existing.callId !== call.call_id ||
        existing.name !== call.name ||
        JSON.stringify(existing.request) !== JSON.stringify(parsed.data))
    )
      return {
        success: false,
        error:
          'A different request is already queued for this call or PR. Finish exporting the changes.',
      }
    if (!existing) {
      if (actions.length >= 64) return { success: false, error: 'Host action limit reached.' }
      actions.push({
        turnId: call.turn_id,
        callId: call.call_id,
        name: call.name,
        request: parsed.data,
        phase: 'queued',
      })
      await save()
    }
    result = {
      success: true,
      output:
        'Queued for local approval and execution after this turn completes and its changes are imported. No remote write has occurred. Run the required export command and finish the turn.',
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
  let blocked = false
  for (const action of actions) {
    signal.throwIfAborted()
    const id = `openai-publish-${action.turnId}-${action.callId}`
    onChunk({ type: 'tool_call', toolCall: { id, name: action.name, args: action.request } })
    if (action.phase === 'executing') {
      // A crash may have happened after GitHub accepted the write. Never guess and replay.
      action.result = {
        success: false,
        error:
          'GitHub action was interrupted and its outcome is uncertain. Check GitHub before requesting it again; Copse has not repeated the write.',
      }
      action.phase = 'done'
      await save()
    } else if (action.phase === 'queued' && blocked) {
      action.phase = 'done'
      action.result = {
        success: false,
        error:
          'GitHub action was not executed because an earlier queued action failed or was denied.',
      }
      await save()
    } else if (action.phase === 'queued') {
      if (!tools)
        throw new Error('Restore the host tool bridge to finish this queued GitHub request.')
      action.phase = 'executing'
      await save()
      action.result = await tools.execute(action.name, action.request, id, signal)
      action.phase = 'done'
      await save()
    }
    const result = action.result ?? {
      success: false,
      error: 'No saved GitHub result is available.',
    }
    if (!result.success) blocked = true
    const message = result.output ?? result.error ?? 'No GitHub result was returned.'
    onChunk({ type: 'tool_result', toolCallId: id, result: message, isError: !result.success })
    text += `\n\n${message}`
  }
  if (text) onChunk({ type: 'text', text })
  return text
}
