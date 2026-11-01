import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StreamChunk } from '../../../shared/types'
import { sessionUpdateToStreamChunks } from './session-update-adapter.ts'
import { createStore } from '../../../shared/store/store.ts'
import { getThreadById } from '../../../shared/store/thread-helpers.ts'
import { createTranscriptReducer } from '../../../shared/store/transcript-reducer.ts'
import { threadWith } from '../../../shared/store/transcript-stream.test-support.ts'

function text(value: string, id?: string): StreamChunk[] {
  return sessionUpdateToStreamChunks({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: value },
    ...(id === undefined ? {} : { messageId: id }),
  })
}

const tool: StreamChunk = {
  type: 'tool_call',
  toolCall: { id: 'read-1', name: 'read_file', args: { path: 'README.md' } },
}
const result: StreamChunk = {
  type: 'tool_result',
  toolCallId: 'read-1',
  result: 'Read complete',
  isError: false,
}

function reduce(chunks: StreamChunk[]): string[] {
  const store = createStore({ threads: [threadWith('t1')], activeThreadId: 't1' })
  const reducer = createTranscriptReducer(store)
  for (const chunk of chunks) reducer.apply('t1', chunk)
  return (getThreadById(store, 't1')?.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
}

const link = '[PR #4072](https://github.com/copse-dev/agent-pane/pull/4072)'
const samples = [
  link,
  'The tests passed.\n\nNext, check the build.',
  '```ts\nconst result = compute(123);\n```',
  'Read `src/main/index.ts` before editing.',
  '**All tests passed** with no errors.',
]

for (const id of [undefined, 'm1']) {
  for (const sample of samples) {
    test(`ACP ${id ?? 'without ids'} preserves every interruption position in ${JSON.stringify(sample)}`, () => {
      for (let index = 1; index < sample.length; index += 1) {
        assert.deepEqual(
          reduce([
            ...text(sample.slice(0, index), id),
            tool,
            result,
            ...text(sample.slice(index), id),
          ]),
          [sample],
          `interruption at ${String(index)}`,
        )
      }
    })
  }

  test(`ACP ${id ?? 'without ids'} preserves standalone whitespace after tools`, () => {
    assert.deepEqual(
      reduce([...text('Hello', id), tool, result, ...text(' ', id), ...text('world', id)]),
      ['Hello world'],
    )
  })

  test(`ACP ${id ?? 'without ids'} stays joined across a delayed tool update`, () => {
    assert.deepEqual(
      reduce([
        ...text('[PR #4072](https://', id),
        tool,
        ...text('github', id),
        { type: 'tool_call_update', toolCallId: 'read-1', status: 'done' },
        ...text('.com/copse-dev/agent-pane/pull/4072)', id),
      ]),
      [link],
    )
  })

  test(`ACP ${id ?? 'without ids'} finalizes at turn end`, () => {
    assert.deepEqual(reduce([...text('First', id), { type: 'done' }, ...text('Second', id)]), [
      'First',
      'Second',
    ])
  })
}

test('a new explicit ACP message id splits an unfinished link', () => {
  assert.deepEqual(
    reduce([
      ...text('[PR #4072](https://', 'm1'),
      tool,
      result,
      ...text('github.com/copse-dev/agent-pane/pull/4072)', 'm2'),
    ]),
    ['[PR #4072](https://', 'github.com/copse-dev/agent-pane/pull/4072)'],
  )
})

test('native text retains its post-tool message boundary', () => {
  assert.deepEqual(
    reduce([{ type: 'text', text: 'Checking.' }, tool, result, { type: 'text', text: 'Done.' }]),
    ['Checking.', 'Done.'],
  )
})
