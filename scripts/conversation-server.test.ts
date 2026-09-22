import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenAIProvider } from '@copse/llm/openai-provider'
import type { LLMMessage, ProviderStreamChunk } from '@copse/llm/wire-types'
import { startConversationServer } from '../tests/e2e/helpers/conversation-server.ts'

async function completion(
  baseUrl: string,
  messages: LLMMessage[],
  model = 'chat',
): Promise<ProviderStreamChunk[]> {
  const provider = new OpenAIProvider(model, { baseURL: baseUrl, apiKey: 'fixture' })
  return Array.fromAsync(provider.stream(messages, []))
}

describe('conversation HTTP fixture', () => {
  it('uses the real provider for natural replies and keeps title calls independent', async () => {
    const server = await startConversationServer({ title: 'Inspect workspace' })
    try {
      server.enqueue({
        user: 'List the project files.',
        text: 'The project contains a README and a source folder.',
      })
      const title = await completion(
        server.baseUrl,
        [{ role: 'user', content: 'Give this thread a title.' }],
        'titles',
      )
      assert.equal(
        title
          .filter((chunk) => chunk.type === 'text')
          .map((chunk) => chunk.text)
          .join(''),
        'Inspect workspace',
      )
      server.assertTitleRequested('Give this thread a title.')
      const reply = await completion(server.baseUrl, [
        { role: 'user', content: 'List the project files.' },
      ])
      assert.equal(
        reply
          .filter((chunk) => chunk.type === 'text')
          .map((chunk) => chunk.text)
          .join(''),
        'The project contains a README and a source folder.',
      )
      server.assertComplete()
    } finally {
      await server.close()
    }
  })

  it('matches actual tool IDs, arguments, results, and image follow-ups before replying', async () => {
    const server = await startConversationServer({ title: 'Choose a color' })
    try {
      server.enqueue(
        {
          user: 'Ask me which color to use, then list the workspace.',
          toolCalls: [
            { name: 'ask_user', args: { questions: [{ question: 'Which color should I use?' }] } },
            { name: 'list_dir', args: { path: '.' } },
          ],
        },
        {
          user: 'Ask me which color to use, then list the workspace.',
          toolResults: [
            { name: 'ask_user', includes: 'Green' },
            { name: 'list_dir', includes: 'package.json' },
          ],
          text: 'I will use green and review the workspace files.',
        },
      )
      const user: LLMMessage = {
        role: 'user',
        content: 'Ask me which color to use, then list the workspace.',
      }
      const chunks = await completion(server.baseUrl, [user])
      const calls = chunks.flatMap((chunk) => (chunk.type === 'tool_call' ? [chunk.toolCall] : []))
      assert.deepEqual(
        calls.map((call) => ({ name: call.name, args: call.args })),
        [
          { name: 'ask_user', args: { questions: [{ question: 'Which color should I use?' }] } },
          { name: 'list_dir', args: { path: '.' } },
        ],
      )
      const [askUser, listDirectory] = calls
      assert.ok(askUser && listDirectory, 'Expected two tool calls')
      const reply = await completion(server.baseUrl, [
        user,
        { role: 'assistant', content: calls },
        {
          role: 'tool',
          toolResults: [
            { toolCallId: askUser.id, result: 'Green' },
            {
              toolCallId: listDirectory.id,
              result: 'package.json\nsrc',
              images: [{ dataUrl: 'data:image/png;base64,AA==', name: 'workspace.png' }],
            },
          ],
        },
      ])
      assert.equal(
        reply
          .filter((chunk) => chunk.type === 'text')
          .map((chunk) => chunk.text)
          .join(''),
        'I will use green and review the workspace files.',
      )
      server.assertComplete()
    } finally {
      await server.close()
    }
  })

  it('rejects unexpected prompts and leaves an unconsumed response visible', async () => {
    const server = await startConversationServer({ title: 'Inspect project' })
    try {
      server.enqueue({ user: 'Inspect the README.', text: 'The README describes the build.' })
      assert.throws(() => {
        server.assertComplete()
      }, /Unconsumed/)
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'chat',
          stream: false,
          messages: [{ role: 'user', content: 'Delete the README.' }],
        }),
      })
      assert.equal(response.status, 400)
      await response.text()
      assert.throws(() => {
        server.assertComplete()
      }, /Conversation fixture failed/)
    } finally {
      await server.close()
    }
  })

  it('rejects extra and stale tool results', async () => {
    const extraServer = await startConversationServer({ title: 'Inspect files' })
    try {
      extraServer.enqueue(
        {
          user: 'Inspect the workspace.',
          toolCalls: [
            { name: 'list_dir', args: { path: '.' } },
            { name: 'read_file', args: { path: 'README.md' } },
          ],
        },
        {
          user: 'Inspect the workspace.',
          toolResults: [{ name: 'list_dir' }, { name: 'read_file' }],
          text: 'The workspace is ready.',
        },
      )
      const user: LLMMessage = { role: 'user', content: 'Inspect the workspace.' }
      const initial = await completion(extraServer.baseUrl, [user])
      const calls = initial.flatMap((chunk) => (chunk.type === 'tool_call' ? [chunk.toolCall] : []))
      const [listDirectory, readme] = calls
      assert.ok(listDirectory && readme, 'Expected two tool calls')
      const response = await fetch(`${extraServer.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'chat',
          stream: false,
          messages: [
            user,
            {
              role: 'assistant',
              content: null,
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name },
              })),
            },
            { role: 'tool', tool_call_id: listDirectory.id, content: 'files' },
            { role: 'tool', tool_call_id: readme.id, content: 'README' },
            { role: 'tool', tool_call_id: readme.id, content: 'duplicate' },
          ],
        }),
      })
      assert.equal(response.status, 400)
      await response.text()
      assert.throws(() => {
        extraServer.assertComplete()
      }, /Conversation fixture failed/)
    } finally {
      await extraServer.close()
    }

    const staleServer = await startConversationServer({ title: 'Inspect files' })
    try {
      staleServer.enqueue(
        {
          user: 'Inspect the workspace.',
          toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
        },
        {
          user: 'Inspect the workspace.',
          toolResults: [{ name: 'list_dir' }],
          text: 'The workspace is ready.',
        },
      )
      const user: LLMMessage = { role: 'user', content: 'Inspect the workspace.' }
      await completion(staleServer.baseUrl, [user])
      const response = await fetch(`${staleServer.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'chat',
          stream: false,
          messages: [
            user,
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'stale-list-dir', type: 'function', function: { name: 'list_dir' } },
              ],
            },
            { role: 'tool', tool_call_id: 'stale-list-dir', content: 'files' },
          ],
        }),
      })
      assert.equal(response.status, 400)
      await response.text()
      assert.throws(() => {
        staleServer.assertComplete()
      }, /Conversation fixture failed/)
    } finally {
      await staleServer.close()
    }
  })

  it('holds a real HTTP response until release and verifies an allowed cancellation', async () => {
    const server = await startConversationServer({ title: 'Inspect image' })
    try {
      server.enqueue({ user: 'Inspect this image.', hold: 'preview', text: 'The image is ready.' })
      const result = completion(server.baseUrl, [{ role: 'user', content: 'Inspect this image.' }])
      await server.waitForHold('preview')
      assert.throws(() => {
        server.assertComplete()
      }, /still active/)
      server.release('preview')
      await result
      server.assertComplete()
      server.enqueue({
        user: 'Keep inspecting.',
        hold: 'cancel',
        text: 'Inspection complete.',
        allowAbort: true,
      })
      const controller = new AbortController()
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'chat',
          messages: [{ role: 'user', content: 'Keep inspecting.' }],
        }),
        signal: controller.signal,
      })
      await server.waitForHold('cancel')
      controller.abort()
      await response.text().catch(() => undefined)
      await delay(30)
      server.assertComplete()
    } finally {
      await server.close()
    }
  })

  it('requires each duplicate hold to be released and records a disallowed cancellation', async () => {
    const server = await startConversationServer({ title: 'Inspect image' })
    try {
      server.enqueue(
        { user: 'Hold the first response.', hold: 'shared', text: 'First response.' },
        { user: 'Hold the second response.', hold: 'shared', text: 'Second response.' },
      )
      const first = completion(server.baseUrl, [
        { role: 'user', content: 'Hold the first response.' },
      ])
      await server.waitForHold('shared')
      server.release('shared')
      await first

      const second = completion(server.baseUrl, [
        { role: 'user', content: 'Hold the second response.' },
      ])
      await server.waitForHold('shared')
      await delay(30)
      assert.throws(() => {
        server.assertComplete()
      }, /still active/)
      server.release('shared')
      await second
      server.assertComplete()

      server.enqueue({
        user: 'Cancel this response.',
        hold: 'disallowed-cancel',
        text: 'This should not complete.',
      })
      const controller = new AbortController()
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'chat',
          messages: [{ role: 'user', content: 'Cancel this response.' }],
        }),
        signal: controller.signal,
      })
      await server.waitForHold('disallowed-cancel')
      controller.abort()
      await response.text().catch(() => undefined)
      await delay(30)
      assert.throws(() => {
        server.assertComplete()
      }, /Conversation fixture failed/)
    } finally {
      await server.close()
    }
  })
})
