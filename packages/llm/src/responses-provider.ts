import OpenAI from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
} from 'openai/resources/responses/responses'
import { withAppAttribution } from './app-attribution.ts'
import { parseToolArgs } from './parse-tool-args.ts'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { toolResultImageFollowUp } from './tool-result-images.ts'
import type { LLMMessage, LLMProvider, LLMTool, ProviderStreamChunk } from './wire-types.ts'

/**
 * Provider adapter for OpenAI-compatible Responses API endpoints.
 *
 * Copse's existing OpenAI adapter uses Chat Completions. Responses endpoints
 * differ in their message, function-call, and streaming event shapes, so they
 * need a distinct transport even when the same OpenAI SDK supplies the client.
 */
export class ResponsesProvider implements LLMProvider {
  private readonly client: OpenAI
  private readonly model: string
  private readonly serverTools: Tool[]
  private readonly extraBody: Record<string, unknown> | undefined
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  constructor(
    model: string,
    opts: {
      baseURL: string
      apiKey: string
      serverTools?: Tool[]
      extraBody?: Record<string, unknown>
    },
  ) {
    this.model = model
    this.serverTools = opts.serverTools ?? []
    this.extraBody = opts.extraBody
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      defaultHeaders: withAppAttribution(),
    })
  }

  stream(
    messages: LLMMessage[],
    tools: LLMTool[],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    const self = this
    return yieldStreamWithRetry(
      async function* () {
        const localTools: FunctionTool[] = tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        }))
        const response = await self.client.responses.create(
          {
            model: self.model,
            input: toResponsesInput(messages),
            stream: true,
            tools: [...self.serverTools, ...localTools],
            ...(self.extraBody ?? {}),
          },
          { signal },
        )

        for await (const event of response) {
          yield* streamEventChunks(event, self.model, self)
        }
      },
      { ...(signal ? { signal } : {}) },
    )
  }
}

function* streamEventChunks(
  event: ResponseStreamEvent,
  model: string,
  provider: ResponsesProvider,
): Generator<ProviderStreamChunk> {
  if (event.type === 'response.output_text.delta') {
    yield { type: 'text', text: event.delta }
    return
  }
  if (
    event.type === 'response.reasoning_text.delta' ||
    event.type === 'response.reasoning_summary_text.delta'
  ) {
    yield { type: 'reasoning', text: event.delta }
    return
  }
  if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
    const parsed = parseToolArgs(event.item.arguments)
    yield {
      type: 'tool_call',
      toolCall: {
        id: event.item.call_id,
        name: event.item.name,
        args: parsed.args,
        ...(parsed.error ? { argsError: parsed.error } : {}),
      },
    }
    return
  }
  if (event.type === 'response.completed') {
    yield* usageChunks(event.response, model, provider)
    const calledTool = event.response.output.some((item) => item.type === 'function_call')
    yield { type: 'done', stopReason: calledTool ? 'tool_calls' : 'stop' }
    return
  }
  if (event.type === 'response.incomplete') {
    yield* usageChunks(event.response, model, provider)
    const reason = event.response.incomplete_details?.reason
    yield {
      type: 'done',
      stopReason: reason === 'max_output_tokens' ? 'max_tokens' : (reason ?? 'incomplete'),
    }
    return
  }
  if (event.type === 'response.failed') {
    throw new Error(event.response.error?.message ?? 'Responses API request failed')
  }
  if (event.type === 'error') throw new Error(event.message)
}

function* usageChunks(
  response: Response,
  model: string,
  provider: ResponsesProvider,
): Generator<ProviderStreamChunk> {
  const usage = response.usage
  if (!usage) return
  provider.lastUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  }
  yield {
    type: 'usage',
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.input_tokens_details.cached_tokens
      ? { cacheReadTokens: usage.input_tokens_details.cached_tokens }
      : {}),
  }
}

export function toResponsesInput(messages: LLMMessage[]): ResponseInput {
  return messages.flatMap((message): ResponseInput => {
    if (message.role === 'system') {
      return [{ role: 'system', content: message.content }]
    }
    if (message.role === 'user' && typeof message.content === 'string') {
      return [{ role: 'user', content: message.content }]
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      return [
        {
          role: 'user',
          content: message.content.map((part) =>
            part.type === 'image'
              ? { type: 'input_image', image_url: part.dataUrl, detail: 'auto' }
              : { type: 'input_text', text: part.text },
          ),
        },
      ]
    }
    if (message.role === 'assistant' && typeof message.content === 'string') {
      return [{ role: 'assistant', content: message.content }]
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      return message.content.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }))
    }
    if (message.role === 'tool') {
      const outputs: ResponseInput = message.toolResults.map((result) => ({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: result.result,
      }))
      // A function_call_output is a plain string here too, so images a tool
      // produced follow as their own user message rather than being lost.
      const images = toolResultImageFollowUp(message.toolResults)
      if (!images || typeof images === 'string') return outputs
      return [
        ...outputs,
        {
          role: 'user',
          content: images.map((part) =>
            part.type === 'image'
              ? { type: 'input_image', image_url: part.dataUrl, detail: 'auto' }
              : { type: 'input_text', text: part.text },
          ),
        },
      ]
    }
    return []
  })
}
