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
import { serviceTierBody } from './service-tier.ts'
import { toolCallIdOrSynthesized } from './tool-call-id.ts'
import { yieldStreamWithRetry } from './stream-retry.ts'
import { toolResultImageFollowUp } from './tool-result-images.ts'
import type {
  ImageDetail,
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
} from './wire-types.ts'
import { responsesParameterFields, type ModelParameters } from './model-parameters.ts'

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
  private readonly serviceTier: string | undefined
  /** User-tuned reasoning / sampling, in this API's request shape. */
  private readonly tuned: ReturnType<typeof responsesParameterFields>
  private readonly imageDetail: ImageDetail
  lastUsage: { inputTokens: number; outputTokens: number } | null = null

  constructor(
    model: string,
    opts: {
      baseURL: string
      apiKey: string
      serverTools?: Tool[]
      extraBody?: Record<string, unknown>
      /** OpenAI `service_tier` (e.g. `'flex'`, `'priority'`). Omitted when unset. */
      serviceTier?: string
      params?: ModelParameters
      /** Image fidelity to request. Defaults to `'auto'` — the historical behaviour. */
      imageDetail?: ImageDetail
    },
  ) {
    this.model = model
    this.serverTools = opts.serverTools ?? []
    this.extraBody = opts.extraBody
    this.serviceTier = opts.serviceTier
    this.tuned = responsesParameterFields(opts.params ?? {})
    this.imageDetail = opts.imageDetail ?? 'auto'
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
            input: toResponsesInput(messages, self.imageDetail),
            stream: true,
            tools: [...self.serverTools, ...localTools],
            ...serviceTierBody(self.serviceTier),
            // Last, so an explicit extraBody entry still wins — that field is
            // the user's own escape hatch for provider-specific overrides.
            ...self.tuned,
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
        // OpenAI always sets call_id, but this adapter also drives third-party
        // Responses-compatible endpoints (e.g. Perplexity) that may not.
        id: toolCallIdOrSynthesized(event.item.call_id),
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

export function toResponsesInput(
  messages: LLMMessage[],
  imageDetail: ImageDetail = 'auto',
): ResponseInput {
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
              ? { type: 'input_image', image_url: part.dataUrl, detail: imageDetail }
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
              ? { type: 'input_image', image_url: part.dataUrl, detail: imageDetail }
              : { type: 'input_text', text: part.text },
          ),
        },
      ]
    }
    return []
  })
}
