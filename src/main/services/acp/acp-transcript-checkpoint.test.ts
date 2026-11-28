import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  checkpointAcpHistory,
  checkpointAcpTranscript,
  unseenAcpTranscript,
} from './acp-transcript-checkpoint.ts'

const old: LLMMessage[] = [
  { role: 'user', content: 'first task' },
  { role: 'assistant', content: 'first answer' },
]
const known: LLMMessage[] = [
  ...old,
  { role: 'user', content: 'continue' },
  { role: 'assistant', content: 'done' },
]

/** The hash checkpoints stored before it was computed incrementally. */
function storedHash(messages: readonly LLMMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

/** Distinct objects with the same content, as a reload from disk gives. */
function reloaded(messages: readonly LLMMessage[]): LLMMessage[] {
  return messages.map((message) => structuredClone(message))
}

test('ordinary consecutive ACP turns do not replay the already-known transcript', async () => {
  const checkpoint = await checkpointAcpTranscript(old, 'continue')
  assert.deepEqual(await unseenAcpTranscript(known, checkpoint), [])
})
test('an intervening provider request and its partial progress reach the reused agent', async () => {
  const checkpoint = await checkpointAcpTranscript(old, 'continue')
  const missing: LLMMessage[] = [
    { role: 'user', content: 'repair the new task' },
    { role: 'assistant', content: 'checkpoint exists; provider failed' },
  ]
  assert.deepEqual(await unseenAcpTranscript([...known, ...missing], checkpoint), missing)
})
test('repeating the same user wording does not hide an intervening provider turn', async () => {
  const checkpoint = await checkpointAcpTranscript(old, 'continue')
  const missing: LLMMessage[] = [
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'new checkpoint' },
  ]
  assert.deepEqual(await unseenAcpTranscript([...known, ...missing], checkpoint), missing)
})
test('changed or trimmed history conservatively catches up from the available transcript', async () => {
  const checkpoint = await checkpointAcpTranscript(old, 'continue')
  const changed: LLMMessage[] = [{ role: 'user', content: 'revised task' }, ...known.slice(1)]
  assert.deepEqual(await unseenAcpTranscript(changed, checkpoint), changed)
  assert.deepEqual(await unseenAcpTranscript(known.slice(2), checkpoint), known.slice(2))
})
test('an unknown checkpoint includes available progress and a new checkpoint stops repeated replay', async () => {
  assert.deepEqual(await unseenAcpTranscript(known, undefined), known)
  const next = await checkpointAcpTranscript(known, 'new request')
  assert.deepEqual(
    await unseenAcpTranscript(
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

const varied: LLMMessage[] = [
  { role: 'system', content: 'be brief' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Look — “this” 🌲 and a lone \ud800 surrogate, "quoted" \\ ]},[' },
      { type: 'image', dataUrl: `data:image/png;base64,${'iVBORw0KGgo'.repeat(500)}` },
    ],
  },
  { role: 'assistant', content: [{ id: 'call-1', name: 'read_file', args: { path: 'ä/ö.txt' } }] },
  { role: 'tool', toolResults: [{ toolCallId: 'call-1', result: 'line\n\ttab\u0000nul' }] },
  {
    role: 'provider_state',
    state: {
      kind: 'openai-responses-compaction',
      v: 1,
      model: 'gpt-5.6-sol',
      endpoint: '',
      itemId: 'cmp_1',
      encryptedContent: 'opaque',
    },
  },
]

test('checkpoints keep the hash already stored in saved session links', async () => {
  for (let length = 0; length <= varied.length; length++) {
    const prior = varied.slice(0, length)
    assert.deepEqual(await checkpointAcpTranscript(prior, 'next step'), {
      messageCount: length + 1,
      prefixHash: storedHash([...prior, { role: 'user', content: 'next step' }]),
    })
    assert.deepEqual(await checkpointAcpHistory(prior), {
      messageCount: length,
      prefixHash: storedHash(prior),
    })
  }
})

test('a checkpoint saved before a relaunch still matches the reloaded history', async () => {
  // Hashing the live objects first fills the prefix cache; the relaunched
  // history is new objects with the same content and must match on content.
  const checkpoint = await checkpointAcpTranscript(varied, [{ type: 'text', text: 'go' }])
  const afterTurn: LLMMessage[] = [
    ...varied,
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: 'went' },
  ]
  assert.deepEqual(await unseenAcpTranscript(afterTurn, checkpoint), [])
  assert.deepEqual(await unseenAcpTranscript(reloaded(afterTurn), checkpoint), [])
})

test('a remembered prefix never hides a message replaced since it was hashed', async () => {
  const live = reloaded(varied)
  const checkpoint = await checkpointAcpTranscript(live, 'continue')
  const unchanged: LLMMessage[] = [...live, { role: 'user', content: 'continue' }]
  assert.deepEqual(await unseenAcpTranscript(unchanged, checkpoint), [])
  // Same objects everywhere but one: an edit swaps the message, never mutates it.
  const edited: LLMMessage[] = [...unchanged]
  edited[1] = { role: 'user', content: 'edited prompt' }
  assert.deepEqual(await unseenAcpTranscript(edited, checkpoint), edited)
})

test('hashing a large history lets other work run between slices', async () => {
  // About 24 MB of prompt images, as a thread that generated images carries.
  const image = `data:image/png;base64,${'A'.repeat(2 << 20)}`
  const large: LLMMessage[] = []
  for (let turn = 0; turn < 12; turn++) {
    large.push({ role: 'user', content: [{ type: 'image', dataUrl: `${image}${String(turn)}` }] })
    large.push({ role: 'assistant', content: `answer ${String(turn)}` })
  }
  let turns = 0
  let ticking = true
  const tick = (): void => {
    turns++
    if (ticking) setImmediate(tick)
  }
  setImmediate(tick)
  const checkpoint = await checkpointAcpHistory(large)
  ticking = false
  assert.equal(checkpoint.prefixHash, storedHash(large))
  assert.ok(turns >= 4, `expected the event loop to turn while hashing, saw ${String(turns)}`)
})
