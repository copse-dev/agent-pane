import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockLLMProvider } from './mock-provider.ts'
import {
  assertMockScenarioComplete,
  clearMockScenarios,
  mockScenarioStatus,
  releaseMockScenario,
  setMockScenario,
  type MockScenario,
} from './mock-script.ts'
import type { LLMMessage, LLMTool, ProviderStreamChunk } from './wire-types.ts'

const LIST_DIR: LLMTool = { name: 'list_dir', description: 'list files', parameters: {} }
const READ_FILE: LLMTool = { name: 'read_file', description: 'read files', parameters: {} }

async function collectChunks(
  provider: MockLLMProvider,
  messages: LLMMessage[],
  tools: LLMTool[],
  signal?: AbortSignal,
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = []
  for await (const chunk of provider.stream(messages, tools, signal)) chunks.push(chunk)
  return chunks
}

function text(chunks: readonly ProviderStreamChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => chunk.text)
    .join('')
}

function inspectScenario(user = 'Inspect the source directory'): MockScenario {
  return {
    title: 'Source directory inspection',
    turns: [
      {
        user,
        responses: [
          {
            reasoning: 'I will inspect the source tree.',
            toolCalls: [{ name: 'list_dir', args: { path: 'src' } }],
          },
          {
            expectToolResults: [{ name: 'list_dir', includes: 'index.ts' }],
            toolCalls: [{ name: 'read_file', args: { path: 'src/index.ts' } }],
          },
          {
            expectToolResults: [{ name: 'read_file', includes: 'createApp' }],
            text: 'I found the application entry point in src/index.ts.',
          },
        ],
      },
    ],
  }
}

afterEach(() => {
  clearMockScenarios()
})

describe('MockLLMProvider scenarios', () => {
  it('runs a multi-round tool conversation across provider instances', async () => {
    setMockScenario('inspect', inspectScenario(), 'thread-a')
    const firstProvider = new MockLLMProvider('thread-a')
    const first = await collectChunks(
      firstProvider,
      [{ role: 'user', content: 'Inspect the source directory' }],
      [LIST_DIR, READ_FILE],
    )
    const toolCall = first.find(
      (chunk): chunk is Extract<ProviderStreamChunk, { type: 'tool_call' }> =>
        chunk.type === 'tool_call',
    )
    assert.ok(toolCall)
    assert.equal(toolCall.toolCall.name, 'list_dir')
    assert.equal(text(first), '')

    const secondProvider = new MockLLMProvider('thread-a')
    const second = await collectChunks(
      secondProvider,
      [
        { role: 'user', content: 'Inspect the source directory' },
        {
          role: 'assistant',
          content: [toolCall.toolCall],
        },
        {
          role: 'tool',
          toolResults: [{ toolCallId: toolCall.toolCall.id, result: 'index.ts' }],
        },
      ],
      [LIST_DIR, READ_FILE],
    )
    const secondCall = second.find(
      (chunk): chunk is Extract<ProviderStreamChunk, { type: 'tool_call' }> =>
        chunk.type === 'tool_call',
    )
    assert.ok(secondCall)
    assert.equal(secondCall.toolCall.name, 'read_file')
    const third = await collectChunks(
      new MockLLMProvider('thread-a'),
      [
        { role: 'user', content: 'Inspect the source directory' },
        {
          role: 'assistant',
          content: [toolCall.toolCall],
        },
        { role: 'tool', toolResults: [{ toolCallId: toolCall.toolCall.id, result: 'index.ts' }] },
        {
          role: 'assistant',
          content: [secondCall.toolCall],
        },
        {
          role: 'tool',
          toolResults: [{ toolCallId: secondCall.toolCall.id, result: 'createApp()' }],
        },
      ],
      [LIST_DIR, READ_FILE],
    )
    assert.equal(text(third), 'I found the application entry point in src/index.ts.')
    assert.ok(third.some((chunk) => chunk.type === 'done'))
    assertMockScenarioComplete('inspect')
  })

  it('matches exact multimodal user text and does not let background providers consume scenarios', async () => {
    setMockScenario(
      'scoped',
      {
        title: 'Exact prompt',
        turns: [{ user: 'Describe this image', responses: [{ text: 'It is a diagram.' }] }],
      },
      'thread-a',
    )
    const unscoped = await collectChunks(
      new MockLLMProvider(),
      [{ role: 'user', content: 'Describe this image' }],
      [],
    )
    assert.equal(text(unscoped), 'No conversation scenario is configured for this request.')
    assert.equal(mockScenarioStatus('scoped').complete, false)

    await assert.rejects(
      collectChunks(
        new MockLLMProvider('thread-a'),
        [{ role: 'user', content: 'Describe this' }],
        [],
      ),
      /expected user text/,
    )
    assert.throws(() => {
      assertMockScenarioComplete('scoped')
    }, /failed/)

    setMockScenario(
      'multimodal',
      {
        title: 'Multimodal title',
        turns: [{ user: 'Describe this image', responses: [{ text: 'It is a diagram.' }] }],
      },
      'thread-b',
    )
    const scoped = await collectChunks(
      new MockLLMProvider('thread-b'),
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe ' },
            { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
            { type: 'text', text: 'this image' },
          ],
        },
      ],
      [],
    )
    assert.equal(text(scoped), 'It is a diagram.')
    assertMockScenarioComplete('multimodal')
  })

  it('rejects stale history for repeated prompt text and accepts an appended user turn', async () => {
    const scenario: MockScenario = {
      title: 'Repeated prompt',
      turns: [
        { user: 'Continue', responses: [{ text: 'First reply.' }] },
        { user: 'Continue', responses: [{ text: 'Second reply.' }] },
      ],
    }
    setMockScenario('stale', scenario, 'thread-a')
    const provider = new MockLLMProvider('thread-a')
    await collectChunks(provider, [{ role: 'user', content: 'Continue' }], [])
    await assert.rejects(
      collectChunks(provider, [{ role: 'user', content: 'Continue' }], []),
      /previous user turn again/,
    )

    setMockScenario('fresh', scenario, 'thread-b')
    const fresh = new MockLLMProvider('thread-b')
    await collectChunks(fresh, [{ role: 'user', content: 'Continue' }], [])
    const second = await collectChunks(
      fresh,
      [
        { role: 'user', content: 'Continue' },
        { role: 'assistant', content: 'First reply.' },
        { role: 'user', content: 'Continue' },
      ],
      [],
    )
    assert.equal(text(second), 'Second reply.')
    assertMockScenarioComplete('fresh')
  })

  it('holds, releases, and records allowed aborts without emitting a fallback reply', async () => {
    setMockScenario(
      'hold',
      {
        title: 'Held reply',
        turns: [{ user: 'Wait', responses: [{ waitFor: 'release', text: 'Released.' }] }],
      },
      'thread-a',
    )
    const held = collectChunks(
      new MockLLMProvider('thread-a'),
      [{ role: 'user', content: 'Wait' }],
      [],
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(mockScenarioStatus('hold').waitingFor, 'release')
    releaseMockScenario('hold', 'release')
    assert.equal(text(await held), 'Released.')
    assertMockScenarioComplete('hold')

    setMockScenario(
      'abort',
      {
        title: 'Abortable',
        turns: [
          {
            user: 'Cancel',
            allowAbort: true,
            responses: [{ waitFor: 'stop', text: 'Never sent.' }],
          },
        ],
      },
      'thread-b',
    )
    const controller = new AbortController()
    const pending = collectChunks(
      new MockLLMProvider('thread-b'),
      [{ role: 'user', content: 'Cancel' }],
      [],
      controller.signal,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    assert.deepEqual(await pending, [])
    assert.equal(mockScenarioStatus('abort').cancelledTurns, 1)
    assertMockScenarioComplete('abort')
  })

  it('consumes each same-named hold release once', async () => {
    setMockScenario(
      'reusable-hold',
      {
        title: 'Reusable hold',
        turns: [
          { user: 'First', responses: [{ waitFor: 'gate', text: 'First released.' }] },
          { user: 'Second', responses: [{ waitFor: 'gate', text: 'Second released.' }] },
        ],
      },
      'thread-a',
    )
    const first = collectChunks(
      new MockLLMProvider('thread-a'),
      [{ role: 'user', content: 'First' }],
      [],
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseMockScenario('reusable-hold', 'gate')
    assert.equal(text(await first), 'First released.')

    const second = collectChunks(
      new MockLLMProvider('thread-a'),
      [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'First released.' },
        { role: 'user', content: 'Second' },
      ],
      [],
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(mockScenarioStatus('reusable-hold').waitingFor, 'gate')
    releaseMockScenario('reusable-hold', 'gate')
    assert.equal(text(await second), 'Second released.')
    assertMockScenarioComplete('reusable-hold')
  })

  it('records a disallowed abort and cancels a held fixture when it is cleared', async () => {
    setMockScenario(
      'disallowed-abort',
      {
        title: 'Not abortable',
        turns: [{ user: 'Cancel', responses: [{ waitFor: 'stop', text: 'Never.' }] }],
      },
      'thread-a',
    )
    const controller = new AbortController()
    const aborted = collectChunks(
      new MockLLMProvider('thread-a'),
      [{ role: 'user', content: 'Cancel' }],
      [],
      controller.signal,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    assert.deepEqual(await aborted, [])
    assert.match(
      mockScenarioStatus('disallowed-abort').errors.join('\n'),
      /aborted without allowAbort/,
    )

    setMockScenario(
      'cleared',
      {
        title: 'Cleared',
        turns: [{ user: 'Hold', responses: [{ waitFor: 'cleanup', text: 'Never emitted.' }] }],
      },
      'thread-b',
    )
    const cleared = collectChunks(
      new MockLLMProvider('thread-b'),
      [{ role: 'user', content: 'Hold' }],
      [],
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    clearMockScenarios()
    assert.deepEqual(await cleared, [])
  })

  it('binds pending scenarios independently and rejects requests after exhaustion', async () => {
    setMockScenario('pending-one', {
      title: 'One',
      turns: [{ user: 'One', responses: [{ text: 'First pending reply.' }] }],
    })
    setMockScenario('pending-two', {
      title: 'Two',
      turns: [{ user: 'Two', responses: [{ text: 'Second pending reply.' }] }],
    })
    assert.equal(
      text(
        await collectChunks(
          new MockLLMProvider('thread-one'),
          [{ role: 'user', content: 'One' }],
          [],
        ),
      ),
      'First pending reply.',
    )
    assert.equal(
      text(
        await collectChunks(
          new MockLLMProvider('thread-two'),
          [{ role: 'user', content: 'Two' }],
          [],
        ),
      ),
      'Second pending reply.',
    )
    assertMockScenarioComplete('pending-one')
    assertMockScenarioComplete('pending-two')
    await assert.rejects(
      collectChunks(new MockLLMProvider('thread-one'), [{ role: 'user', content: 'One' }], []),
      /after the conversation completed/,
    )
    assert.throws(() => {
      assertMockScenarioComplete('pending-one')
    }, /failed/)
  })

  it('retains completed scenario handles when a scope receives a replacement', async () => {
    setMockScenario(
      'old',
      { title: 'Old title', turns: [{ user: 'Old prompt', responses: [{ text: 'Old reply.' }] }] },
      'thread-a',
    )
    await collectChunks(
      new MockLLMProvider('thread-a'),
      [{ role: 'user', content: 'Old prompt' }],
      [],
    )
    assertMockScenarioComplete('old')

    setMockScenario(
      'new',
      { title: 'New title', turns: [{ user: 'New prompt', responses: [{ text: 'New reply.' }] }] },
      'thread-a',
    )
    assertMockScenarioComplete('old')
    const replacement = await collectChunks(
      new MockLLMProvider('thread-a'),
      [{ role: 'user', content: 'New prompt' }],
      [],
    )
    assert.equal(text(replacement), 'New reply.')
    assertMockScenarioComplete('new')
  })

  it('stores unavailable, missing, and mismatched tool-result failures for teardown assertions', async () => {
    setMockScenario(
      'unavailable',
      {
        title: 'Unavailable',
        turns: [
          {
            user: 'Write it',
            responses: [
              { toolCalls: [{ name: 'write_file', args: { path: 'note.txt', content: 'hello' } }] },
              { text: 'The note is written.' },
            ],
          },
        ],
      },
      'thread-a',
    )
    await assert.rejects(
      collectChunks(new MockLLMProvider('thread-a'), [{ role: 'user', content: 'Write it' }], []),
      /unavailable/,
    )
    assert.throws(() => {
      assertMockScenarioComplete('unavailable')
    }, /failed/)

    setMockScenario('missing', inspectScenario('Inspect once'), 'thread-b')
    const initial = await collectChunks(
      new MockLLMProvider('thread-b'),
      [{ role: 'user', content: 'Inspect once' }],
      [LIST_DIR, READ_FILE],
    )
    const call = initial.find(
      (chunk): chunk is Extract<ProviderStreamChunk, { type: 'tool_call' }> =>
        chunk.type === 'tool_call',
    )
    await assert.rejects(
      collectChunks(
        new MockLLMProvider('thread-b'),
        [
          { role: 'user', content: 'Inspect once' },
          {
            role: 'assistant',
            content: [call?.toolCall ?? { id: 'missing', name: 'list_dir', args: {} }],
          },
        ],
        [LIST_DIR, READ_FILE],
      ),
      /expected 1 tool result/,
    )
    assert.throws(() => {
      assertMockScenarioComplete('missing')
    }, /failed/)

    setMockScenario('mismatch', inspectScenario('Inspect again'), 'thread-c')
    const mismatchInitial = await collectChunks(
      new MockLLMProvider('thread-c'),
      [{ role: 'user', content: 'Inspect again' }],
      [LIST_DIR, READ_FILE],
    )
    const mismatchCall = mismatchInitial.find(
      (chunk): chunk is Extract<ProviderStreamChunk, { type: 'tool_call' }> =>
        chunk.type === 'tool_call',
    )
    await assert.rejects(
      collectChunks(
        new MockLLMProvider('thread-c'),
        [
          { role: 'user', content: 'Inspect again' },
          {
            role: 'assistant',
            content: [mismatchCall?.toolCall ?? { id: 'missing', name: 'list_dir', args: {} }],
          },
          {
            role: 'tool',
            toolResults: [
              { toolCallId: mismatchCall?.toolCall.id ?? 'missing', result: 'no files' },
            ],
          },
        ],
        [LIST_DIR, READ_FILE],
      ),
      /did not include/,
    )
    assert.throws(() => {
      assertMockScenarioComplete('mismatch')
    }, /failed/)
  })

  it('emits prompt progress before a cancellable hold', async () => {
    setMockScenario(
      'progress',
      {
        title: 'Inspect context',
        turns: [
          {
            user: 'Inspect context',
            allowAbort: true,
            responses: [
              { promptProgress: 0.47, waitFor: 'context-loaded', text: 'The context is loaded.' },
            ],
          },
        ],
      },
      'progress',
    )
    const controller = new AbortController()
    const stream = new MockLLMProvider('progress')
      .stream([{ role: 'user', content: 'Inspect context' }], [], controller.signal)
      [Symbol.asyncIterator]()
    assert.deepEqual((await stream.next()).value, { type: 'prompt_progress', fraction: 0.47 })
    const pending = stream.next()
    controller.abort()
    assert.equal((await pending).done, true)
    assertMockScenarioComplete('progress')
  })

  it('continues a provider response after text-based tool recovery and matches a machine wake', async () => {
    setMockScenario(
      'recovery',
      {
        title: 'Inspect files',
        turns: [
          {
            user: 'Inspect files',
            responses: [
              { text: 'tool recovery payload', continueTurn: true },
              { text: 'The files are listed.' },
            ],
          },
          {
            user: { includes: 'exited with code 0' },
            responses: [{ text: 'The background check passed.' }],
          },
        ],
      },
      'recovery',
    )
    const provider = new MockLLMProvider('recovery')
    const messages: LLMMessage[] = [{ role: 'user', content: 'Inspect files' }]
    assert.equal(text(await collectChunks(provider, messages, [])), 'tool recovery payload')
    messages.push({ role: 'assistant', content: 'tool recovery payload' })
    assert.equal(text(await collectChunks(provider, messages, [])), 'The files are listed.')
    messages.push({ role: 'user', content: 'Background task abc exited with code 0' })
    assert.equal(text(await collectChunks(provider, messages, [])), 'The background check passed.')
    assertMockScenarioComplete('recovery')
  })

  it('accounts for cancellation while a real tool is waiting on approval', async () => {
    setMockScenario(
      'approval',
      {
        ...inspectScenario(),
        turns: inspectScenario().turns.map((turn) => ({ ...turn, allowAbort: true })),
      },
      'approval',
    )
    const controller = new AbortController()
    await collectChunks(
      new MockLLMProvider('approval'),
      [{ role: 'user', content: 'Inspect the source directory' }],
      [LIST_DIR],
      controller.signal,
    )
    controller.abort()
    assertMockScenarioComplete('approval')
    assert.equal(mockScenarioStatus('approval').cancelledTurns, 1)
  })

  it('keeps the unscripted first-turn tool fallback for smoke coverage', async () => {
    const chunks = await collectChunks(
      new MockLLMProvider(),
      [{ role: 'user', content: 'hello' }],
      [LIST_DIR],
    )
    assert.ok(
      chunks.some((chunk) => chunk.type === 'tool_call' && chunk.toolCall.name === 'list_dir'),
    )
  })
})
