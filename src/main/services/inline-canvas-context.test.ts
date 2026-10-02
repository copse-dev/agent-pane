import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { StreamChunk } from '@shared/types'
import { queueInlineCanvasReference, runWithInlineCanvas } from './inline-canvas-context.ts'

it('flushes references after the answer and before done, once', () => {
  const seen: StreamChunk[] = []
  runWithInlineCanvas('a', { emit: (_id, chunk) => seen.push(chunk) }, (host) => {
    assert.equal(queueInlineCanvasReference('b', 'Wrong thread'), false)
    assert.equal(queueInlineCanvasReference('a', 'Explainer'), true)
    host.emit('a', { type: 'tool_result', toolCallId: '1', result: 'created', isError: false })
    assert.equal(seen.length, 1)
    host.emit('a', { type: 'text', text: 'Here it is.' })
    host.emit('a', { type: 'done' })
  })
  assert.deepEqual(
    seen.map((chunk) => chunk.type),
    ['tool_result', 'text', 'canvas_artefact', 'done'],
  )
  assert.equal(queueInlineCanvasReference('a', 'Outside run'), false)
})

it('keeps concurrent runs isolated and supports visual-only answers', async () => {
  const first: StreamChunk[] = [],
    second: StreamChunk[] = []
  await Promise.all([
    runWithInlineCanvas('a', { emit: (_id, chunk) => first.push(chunk) }, async (host) => {
      queueInlineCanvasReference('a', 'First')
      await Promise.resolve()
      host.emit('a', { type: 'done' })
    }),
    runWithInlineCanvas('b', { emit: (_id, chunk) => second.push(chunk) }, async (host) => {
      queueInlineCanvasReference('b', 'Second')
      await Promise.resolve()
      host.emit('b', { type: 'done' })
    }),
  ])
  assert.deepEqual(first[0], { type: 'canvas_artefact', artefact: { title: 'First' } })
  assert.deepEqual(second[0], { type: 'canvas_artefact', artefact: { title: 'Second' } })
})

it('rebinds an external request to its captured run and rejects late publication', async () => {
  const { captureInlineCanvasScope } = await import('./inline-canvas-context.ts')
  const seen: StreamChunk[] = []
  let finish = (): void => {}
  const scope = runWithInlineCanvas('acp', { emit: (_id, chunk) => seen.push(chunk) }, (host) => {
    finish = (): void => {
      host.emit('acp', { type: 'done' })
    }
    return captureInlineCanvasScope()
  })
  assert.equal(
    scope(() => queueInlineCanvasReference('acp', 'Remote agent explanation')),
    true,
  )
  finish()
  assert.equal(
    scope(() => queueInlineCanvasReference('acp', 'Late result')),
    false,
  )
  assert.deepEqual(
    seen.map((chunk) => chunk.type),
    ['canvas_artefact', 'done'],
  )
})
