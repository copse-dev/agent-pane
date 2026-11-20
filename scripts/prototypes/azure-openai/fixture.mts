import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import type { LLMMessage, LLMTool, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { createAzurePrototype } from './adapter.mts'

export const fixtureEndpoint = 'https://copse-prototype.openai.azure.com'
export const fixtureDeployment = 'team-coding-deployment'

export const requestSchema = z.object({
  model: z.string(),
  stream: z.boolean(),
  store: z.boolean(),
  input: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.object({ type: z.string(), name: z.string() })),
})

/** Deliberately split UTF-8 and SSE framing, not just semantic SDK events. */
export function eventResponse(events: readonly unknown[]): Response {
  const data = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )
  let offset = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (offset >= data.length) {
          controller.close()
          return
        }
        // The first text delta's two-byte é straddles bytes 63 and 64.
        const end = Math.min(data.length, offset + 8)
        controller.enqueue(data.slice(offset, end))
        offset = end
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const toolCall = {
  type: 'function_call',
  id: 'item_lookup',
  call_id: 'call_lookup',
  name: 'lookup',
  arguments: '{"path":"README.md"}',
  status: 'completed',
}

export function completeEvents(tool: boolean): unknown[] {
  return [
    ...(tool
      ? [{ type: 'response.output_item.done', output_index: 0, item: toolCall }]
      : [
          { type: 'response.output_text.delta', delta: 'Checked café. ' },
          { type: 'response.output_text.delta', delta: 'Done.' },
        ]),
    {
      type: 'response.completed',
      response: {
        id: 'response_fixture',
        status: 'completed',
        output: tool ? [toolCall] : [],
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
}

const lookup: LLMTool = {
  name: 'lookup',
  description: 'Look up a fixture file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/** Executable offline scenario, also consumed by the focused contract test. */
export async function runAzureScenario(): Promise<{
  deployment: string
  requests: number
  credentialResolutions: number
  rotatedCredential: boolean
  replayedToolResult: boolean
  text: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}> {
  let resolutions = 0
  let now = 1_000
  const captured: Array<{ request: z.infer<typeof requestSchema>; authorization: string | null }> =
    []
  const provider = createAzurePrototype(
    {
      endpoint: fixtureEndpoint,
      deployment: fixtureDeployment,
      auth: {
        kind: 'entra',
        getToken: () => {
          resolutions++
          return Promise.resolve({
            token: `synthetic-azure-token-${String(now)}`,
            expiresAt: now + 60_000,
          })
        },
      },
    },
    {
      now: () => now,
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const body = safeJsonParse(await request.text(), decodeWithSchema(requestSchema))
        if (!body) throw new Error('Invalid fixture request')
        if (!body.tools.some((tool) => tool.type === 'function' && tool.name === 'lookup'))
          throw new Error('Fixture tool declaration did not reach the SDK request')
        captured.push({ request: body, authorization: request.headers.get('authorization') })
        return eventResponse(completeEvents(captured.length === 1))
      },
    },
  )
  const messages: LLMMessage[] = [{ role: 'user', content: 'Look up README.md and report.' }]
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, [lookup])) chunks.push(chunk)
  const call = chunks.find((chunk) => chunk.type === 'tool_call')
  if (call?.type !== 'tool_call') throw new Error('Missing fixture tool call')
  if (
    call.toolCall.name !== 'lookup' ||
    !z.object({ path: z.literal('README.md') }).safeParse(call.toolCall.args).success
  )
    throw new Error('Fixture tool name or parsed arguments changed')
  messages.push(
    { role: 'assistant', content: [call.toolCall] },
    {
      role: 'tool',
      toolResults: [{ toolCallId: call.toolCall.id, result: 'Fixture README contents' }],
    },
  )
  now += 120_000
  for await (const chunk of provider.stream(messages, [lookup])) chunks.push(chunk)
  const first = captured[0]
  const second = captured[1]
  if (!first || !second) throw new Error('Missing fixture request')
  const usage = chunks.filter((chunk) => chunk.type === 'usage')
  return {
    deployment: first.request.model,
    requests: captured.length,
    credentialResolutions: resolutions,
    rotatedCredential: first.authorization !== second.authorization,
    replayedToolResult: second.request.input.some(
      (item) =>
        item['type'] === 'function_call_output' &&
        item['call_id'] === call.toolCall.id &&
        item['output'] === 'Fixture README contents',
    ),
    text: chunks
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.text)
      .join(''),
    inputTokens: usage.reduce((sum, chunk) => sum + chunk.inputTokens, 0),
    outputTokens: usage.reduce((sum, chunk) => sum + chunk.outputTokens, 0),
    cacheReadTokens: usage.reduce((sum, chunk) => sum + (chunk.cacheReadTokens ?? 0), 0),
  }
}
