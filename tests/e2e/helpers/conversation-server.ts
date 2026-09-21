import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json'

const messageSchema = z.object({
  role: z.string(),
  content: z
    .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))])
    .nullable()
    .optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(z.object({ id: z.string(), function: z.object({ name: z.string() }) }))
    .optional(),
})
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  stream: z.boolean().optional(),
})
type CompletionRequest = z.infer<typeof requestSchema>

export interface ConversationResponse {
  user: string
  text?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  toolResults?: Array<{ name: string; includes?: string }>
  hold?: string
  allowAbort?: boolean
  chunkDelayMs?: number
}

interface PendingResponse {
  response: ConversationResponse
  complete: boolean
}

interface EmittedToolCall {
  id: string
  name: string
}

function messageText(message: z.infer<typeof messageSchema> | undefined): string {
  if (typeof message?.content === 'string') return message.content
  return message?.content?.map((part) => part.text ?? '').join('') ?? ''
}

/** A real OpenAI-compatible HTTP endpoint; fixture controls never enter the transcript. */
export async function startConversationServer(options: { title: string }) {
  const pending: PendingResponse[] = []
  const failures: string[] = []
  const titleRequests: string[] = []
  const activeHolds = new Set<string>()
  const released = new Set<string>()
  const connections = new Set<ServerResponse>()
  let cursor = 0
  let sequence = 0
  let expectedToolCalls: EmittedToolCall[] = []
  let restoreEnvironment: (() => void) | undefined

  function checkRequest(request: CompletionRequest, step: ConversationResponse): void {
    const latestToolCallIndex =
      step.toolResults === undefined
        ? -1
        : request.messages.findLastIndex(
            (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
          )
    const lastUserIndex = request.messages.findLastIndex(
      (message, index) =>
        message.role === 'user' &&
        messageText(message).length > 0 &&
        (latestToolCallIndex === -1 || index < latestToolCallIndex),
    )
    assert.notEqual(lastUserIndex, -1, 'Missing textual user message')
    const user = request.messages.at(lastUserIndex)
    assert.ok(user, 'Missing textual user message')
    assert.equal(messageText(user), step.user, 'Unexpected conversation request')
    if (step.toolResults !== undefined) {
      assert.ok(expectedToolCalls.length > 0, 'No tool calls were emitted for this continuation')
      assert.notEqual(latestToolCallIndex, -1, 'Missing assistant tool calls')
      const latestToolCallMessage = request.messages.at(latestToolCallIndex)
      assert.ok(latestToolCallMessage, 'Missing assistant tool calls')
      const latestToolCalls = latestToolCallMessage.tool_calls ?? []
      assert.deepEqual(
        latestToolCalls.map((call) => ({ id: call.id, name: call.function.name })),
        expectedToolCalls,
        'Unexpected assistant tool calls',
      )
      assert.equal(
        step.toolResults.length,
        expectedToolCalls.length,
        'Configured results do not cover emitted tool calls',
      )
      const actualResults = request.messages
        .slice(latestToolCallIndex + 1)
        .filter((message) => message.role === 'tool')
      assert.equal(actualResults.length, step.toolResults.length, 'Unexpected tool result count')
      for (const [index, expected] of step.toolResults.entries()) {
        const actual = actualResults[index]
        const emitted = expectedToolCalls[index]
        assert.ok(emitted, 'Missing emitted tool call')
        assert.equal(actual?.tool_call_id, emitted.id, 'Unexpected tool result ID')
        assert.equal(expected.name, emitted.name, 'Unexpected tool result name')
        if (expected.includes !== undefined)
          assert.ok(
            messageText(actual).includes(expected.includes),
            `Expected ${expected.name} result to contain ${expected.includes}`,
          )
      }
      expectedToolCalls = []
    } else {
      const round = request.messages.slice(lastUserIndex + 1)
      const actualResults = round.filter((message) => message.role === 'tool')
      assert.equal(
        actualResults.length,
        0,
        'An initial response must not consume a tool continuation',
      )
    }
  }

  async function send(
    response: ServerResponse,
    request: CompletionRequest,
    step: ConversationResponse,
    trackToolCalls: boolean,
  ): Promise<void> {
    let finished = false
    let aborted = false
    response.on('close', () => {
      if (!finished) aborted = true
    })
    const id = `conversation-${String(++sequence)}`
    const toolCalls = step.toolCalls?.map((call, index) => ({
      index,
      id: `${id}-tool-${String(index)}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }))
    if (trackToolCalls) {
      expectedToolCalls =
        toolCalls?.map((call) => ({ id: call.id, name: call.function.name })) ?? []
    }
    if (request.stream !== false) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
    }
    if (step.hold) {
      const deadline = Date.now() + 30_000
      activeHolds.add(step.hold)
      try {
        while (!released.delete(step.hold) && !aborted) {
          assert.ok(Date.now() < deadline, `Hold ${step.hold} was never released or cancelled`)
          await delay(10)
        }
      } finally {
        activeHolds.delete(step.hold)
      }
    }
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      )
    }
    if (!aborted && request.stream === false) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: step.text ?? '',
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      )
      finished = true
      return
    }
    if (!aborted) chunk({ role: 'assistant' })
    if (step.text && !aborted) {
      const fragments = step.chunkDelayMs ? [...step.text] : [step.text]
      for (const content of fragments) {
        if (aborted) break
        chunk({ content })
        if (step.chunkDelayMs) await delay(step.chunkDelayMs)
      }
    }
    if (aborted) {
      assert.equal(step.allowAbort, true, 'Conversation response was unexpectedly cancelled')
      return
    }
    if (toolCalls) chunk({ tool_calls: toolCalls })
    chunk({}, toolCalls ? 'tool_calls' : 'stop')
    response.write('data: [DONE]\n\n')
    finished = true
    response.end()
  }

  const server = createServer((request, response) => {
    connections.add(response)
    response.on('close', () => connections.delete(response))
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({ data: ['chat', 'titles'].map((id) => ({ id, object: 'model' })) }),
        )
        return
      }
      assert.equal(request.method, 'POST', 'Unexpected fixture method')
      assert.equal(request.url, '/v1/chat/completions', 'Unexpected fixture endpoint')
      request.setEncoding('utf8')
      let body = ''
      for await (const part of request) {
        assert.equal(typeof part, 'string')
        body += String(part)
        assert.ok(body.length < 2_000_000, 'Fixture request is too large')
      }
      const completion = safeJsonParse(body, decodeWithSchema(requestSchema))
      assert.ok(completion, 'Invalid completion request')
      if (completion.model === 'titles') {
        titleRequests.push(completion.messages.map(messageText).join('\n'))
        await send(response, completion, { user: '', text: options.title }, false)
        return
      }
      assert.equal(completion.model, 'chat', 'Unexpected fixture model')
      const next = pending[cursor++]
      assert.ok(next, 'No conversation response was registered for this request')
      checkRequest(completion, next.response)
      await send(response, completion, next.response, true)
      next.complete = true
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: failures.at(-1), type: 'fixture_error' } }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
  return {
    baseUrl,
    settings: {
      model: 'conversation:chat',
      smallTasksModel: 'conversation:titles',
      nextStepSuggestionEnabled: false,
      extraProviders: [
        {
          slug: 'conversation',
          label: 'Local model',
          baseUrl,
          models: [{ id: 'chat' }, { id: 'titles' }],
        },
      ],
    },
    enqueue(...steps: ConversationResponse[]) {
      pending.push(...steps.map((response) => ({ response, complete: false })))
    },
    configureEnvironment(overrides: Record<string, string> = {}) {
      assert.equal(restoreEnvironment, undefined, 'Environment was already configured')
      const path = join(process.cwd(), 'tests/e2e/electron-shell/.e2e-env.json')
      const original = readFileSync(path, 'utf8')
      const environment = safeJsonParse(
        original,
        decodeWithSchema(z.record(z.string(), z.string())),
      )
      assert.ok(environment, 'Invalid isolated Electron environment')
      const replacement = { COPSE_PANEL_MOCK_LLM: '0', ...overrides }
      const previous = new Map(Object.keys(replacement).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(replacement)) process.env[key] = value
      writeFileSync(path, JSON.stringify({ ...environment, ...replacement }))
      restoreEnvironment = () => {
        writeFileSync(path, original)
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    },
    async waitForHold(name: string) {
      const deadline = Date.now() + 20_000
      while (!activeHolds.has(name)) {
        assert.deepEqual(failures, [], 'Conversation fixture failed')
        assert.ok(Date.now() < deadline, `Conversation did not reach hold ${name}`)
        await delay(10)
      }
    },
    release(name: string) {
      released.add(name)
    },
    assertTitleRequested(includes: string) {
      assert.ok(
        titleRequests.some((prompt) => prompt.includes(includes)),
        `Expected a title request containing ${includes}`,
      )
    },
    assertComplete() {
      assert.deepEqual(failures, [], 'Conversation fixture failed')
      assert.equal(cursor, pending.length, 'Unconsumed conversation responses')
      assert.ok(
        pending.every((step) => step.complete),
        'A conversation response is still active',
      )
    },
    async close() {
      for (const response of connections) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      restoreEnvironment?.()
    },
  }
}

export type ConversationServer = Awaited<ReturnType<typeof startConversationServer>>
