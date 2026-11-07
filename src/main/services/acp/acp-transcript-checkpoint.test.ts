import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import { checkpointAcpTranscript, unseenAcpTranscript } from './acp-transcript-checkpoint.ts'

const old: LLMMessage[] = [
  { role: 'user', content: 'first task' },
  { role: 'assistant', content: 'first answer' },
]
const checkpoint = checkpointAcpTranscript(old, 'continue')
const known: LLMMessage[] = [
  ...old,
  { role: 'user', content: 'continue' },
  { role: 'assistant', content: 'done' },
]

test('ordinary consecutive ACP turns do not replay the already-known transcript', () => {
  assert.deepEqual(unseenAcpTranscript(known, checkpoint), [])
})
test('an intervening provider request and its partial progress reach the reused agent', () => {
  const missing: LLMMessage[] = [
    { role: 'user', content: 'repair the new task' },
    { role: 'assistant', content: 'checkpoint exists; provider failed' },
  ]
  assert.deepEqual(unseenAcpTranscript([...known, ...missing], checkpoint), missing)
})
test('repeating the same user wording does not hide an intervening provider turn', () => {
  const missing: LLMMessage[] = [
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'new checkpoint' },
  ]
  assert.deepEqual(unseenAcpTranscript([...known, ...missing], checkpoint), missing)
})
test('changed or trimmed history conservatively catches up from the available transcript', () => {
  const changed: LLMMessage[] = [{ role: 'user', content: 'revised task' }, ...known.slice(1)]
  assert.deepEqual(unseenAcpTranscript(changed, checkpoint), changed)
  assert.deepEqual(unseenAcpTranscript(known.slice(2), checkpoint), known.slice(2))
})
test('an unknown checkpoint includes available progress and a new checkpoint stops repeated replay', () => {
  assert.deepEqual(unseenAcpTranscript(known, undefined), known)
  const next = checkpointAcpTranscript(known, 'new request')
  assert.deepEqual(
    unseenAcpTranscript(
      [
        ...known,
        { role: 'user', content: 'new request' },
        { role: 'assistant', content: 'new answer' },
      ],
      next,
    ),
    [],
  )
})
