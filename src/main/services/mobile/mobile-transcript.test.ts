import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Message } from '@shared/types'
import { mobileTranscriptMessages } from './mobile-transcript.ts'

function message(id: string, role: Message['role'], content: string, summary?: string): Message {
  return {
    id,
    role,
    content,
    toolCalls: [],
    createdAt: 1,
    ...(summary ? { toolSummary: summary } : {}),
  }
}

it('keeps the latest 40 readable messages after omitting empty assistant records', () => {
  const transcript = [
    message('old', 'user', 'Outside the visible window'),
    ...Array.from({ length: 40 }, (_, index) =>
      message(String(index), 'assistant', `Answer ${String(index)}`),
    ),
    ...Array.from({ length: 20 }, (_, index) => message(`empty-${String(index)}`, 'assistant', '')),
    message('summary', 'assistant', '', 'Reviewed three files'),
    message('whitespace', 'assistant', '  '),
  ]

  const visible = mobileTranscriptMessages(transcript)
  assert.equal(visible.length, 40)
  assert.equal(visible[0]?.content, 'Answer 1')
  assert.deepEqual(visible.at(-1), {
    role: 'assistant',
    content: '',
    summary: 'Reviewed three files',
  })
  assert.equal(
    visible.some((item) => item.content === 'Outside the visible window'),
    false,
  )
})

it('keeps user and error records, and caps displayed text', () => {
  assert.deepEqual(
    mobileTranscriptMessages([
      message('image', 'user', ''),
      message('failure', 'error', 'Failed'),
      message('long', 'assistant', 'x'.repeat(20_001)),
    ]),
    [
      { role: 'user', content: '', summary: null },
      { role: 'error', content: 'Failed', summary: null },
      { role: 'assistant', content: 'x'.repeat(20_000), summary: null },
    ],
  )
})
