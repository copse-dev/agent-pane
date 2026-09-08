import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import {
  decodeGuestTranscript,
  foldGuestTranscript,
  relocateGuestPaths,
  relocateTranscript,
} from './guest-transcript.ts'

const call = (id: string, name = 'run_shell'): StreamChunk => ({
  type: 'tool_call',
  toolCall: { id, name, args: { command: `echo ${id}` } },
})
const result = (toolCallId: string, text = 'ok', isError = false): StreamChunk => ({
  type: 'tool_result',
  toolCallId,
  result: text,
  isError,
})

describe('foldGuestTranscript', () => {
  it('folds text, reasoning and tool calls into subagent messages, a new one after each tool turn', () => {
    const messages = foldGuestTranscript([
      { type: 'reasoning', text: 'Let me look. ' },
      { type: 'text', text: 'Checking the lint config.' },
      call('t1'),
      result('t1', 'clean'),
      call('t2', 'read_file'),
      result('t2', 'contents'),
      { type: 'text', text: 'All good.' },
      { type: 'usage', model: 'm', inputTokens: 1, outputTokens: 1 },
      { type: 'done' },
    ])
    assert.deepEqual(
      messages.map((m) => [m.content, m.reasoning ?? null, m.toolCalls.map((tc) => tc.id)]),
      [
        ['Checking the lint config.', 'Let me look. ', ['t1', 't2']],
        ['All good.', null, []],
      ],
    )
    const first = messages[0]
    assert.ok(first)
    assert.deepEqual(
      first.toolCalls.map((tc) => [tc.name, tc.status, tc.result]),
      [
        ['run_shell', 'done', 'clean'],
        ['read_file', 'done', 'contents'],
      ],
    )
    assert.ok(messages.every((m) => m.role === 'assistant' && typeof m.createdAt === 'number'))
  })

  it('honours an ACP agent finishing its calls through tool_call_update patches', () => {
    const [message] = foldGuestTranscript([
      call('t1'),
      { type: 'tool_call_update', toolCallId: 't1', args: { command: 'pnpm test' } },
      {
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'done',
        result: '242 specs',
        resultFormat: 'markdown',
      },
      call('t2'),
      { type: 'tool_call_update', toolCallId: 't2', status: 'error', result: 'exit 1' },
      { type: 'tool_call_update', toolCallId: 'unknown', status: 'done' },
    ])
    assert.ok(message)
    assert.deepEqual(
      message.toolCalls.map((tc) => [tc.status, tc.result, tc.resultFormat ?? null, tc.args]),
      [
        ['done', '242 specs', 'markdown', { command: 'pnpm test' }],
        ['error', 'exit 1', null, { command: 'echo t2' }],
      ],
    )
  })

  it('marks an unanswered tool call as an error and an error result as one', () => {
    const [message] = foldGuestTranscript([call('t1'), result('t1', 'boom', true), call('t2')])
    assert.ok(message)
    assert.deepEqual(
      message.toolCalls.map((tc) => [tc.status, tc.result]),
      [
        ['error', 'boom'],
        ['error', 'no result: the run ended before this tool finished'],
      ],
    )
  })

  it('cuts a long result and keeps the end of an over-long run', () => {
    const [message] = foldGuestTranscript([call('t1'), result('t1', 'x'.repeat(50))], {
      resultLimit: 10,
    })
    assert.equal(
      message?.toolCalls[0]?.result,
      `${'x'.repeat(10)}\n… (40 more characters not carried)`,
    )
    const chunks: StreamChunk[] = []
    for (let i = 0; i < 6; i += 1) {
      chunks.push(
        { type: 'text', text: `step ${String(i)}` },
        call(`t${String(i)}`),
        result(`t${String(i)}`),
      )
    }
    const capped = foldGuestTranscript(chunks, { messageLimit: 2 })
    assert.deepEqual(
      capped.map((m) => m.content),
      ['… 4 earlier messages not carried', 'step 4', 'step 5'],
    )
  })

  it('leaves out nested subagent chunks and empty messages', () => {
    const messages = foldGuestTranscript([
      {
        type: 'subagent_start',
        parentToolCallId: 'p',
        session: {
          id: 's',
          kind: 'explore',
          status: 'running',
          prompt: '',
          summary: null,
          messages: [],
        },
      },
      { type: 'done' },
    ])
    assert.deepEqual(messages, [])
  })
})

describe('decodeGuestTranscript', () => {
  it('round-trips what the fold wrote and refuses anything else', () => {
    const folded = foldGuestTranscript([{ type: 'text', text: 'hi' }, call('t1'), result('t1')])
    const decoded = decodeGuestTranscript(JSON.parse(JSON.stringify(folded)))
    assert.deepEqual(decoded, folded)
    assert.equal(decodeGuestTranscript({ not: 'a list' }), null)
    assert.equal(decodeGuestTranscript([{ id: 'x' }]), null)
  })
})

describe('relocateGuestPaths', () => {
  it('turns guest checkout paths into checkout-relative ones, everywhere the agent wrote them', () => {
    assert.equal(
      relocateGuestPaths(
        'see [index](/workspace/repo/src/main/index.ts:214) and /workspace/repo/.tmp/run.log',
      ),
      'see [index](src/main/index.ts:214) and .tmp/run.log',
    )
    assert.equal(relocateGuestPaths('/workspace/home/x'), '/workspace/home/x')
    const [message] = relocateTranscript([
      {
        id: 'm',
        role: 'assistant',
        content: 'read /workspace/repo/a.ts',
        reasoning: 'look at /workspace/repo/b.ts',
        toolCalls: [
          { id: 't', name: 'read_file', args: {}, status: 'done', result: '/workspace/repo/c.ts' },
          { id: 'u', name: 'read_file', args: {}, status: 'done', result: null },
        ],
      },
    ])
    assert.ok(message)
    assert.equal(message.content, 'read a.ts')
    assert.equal(message.reasoning, 'look at b.ts')
    assert.deepEqual(
      message.toolCalls.map((tc) => tc.result),
      ['c.ts', null],
    )
  })
})
