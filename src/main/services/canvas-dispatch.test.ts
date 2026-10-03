import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  dispatchCanvasArtefacts,
  setCanvasArtefactMirror,
  setCanvasArtefactSink,
} from './canvas-dispatch.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'

function uiResult(title = 'sales-dashboard', html = '<h1>v1</h1>'): unknown {
  return [
    {
      type: 'resource',
      resource: { uri: `ui://canvas/${title}`, mimeType: 'text/html', text: html },
    },
  ]
}

afterEach(() => {
  setCanvasArtefactSink(null)
  setCanvasArtefactMirror(null)
})

describe('dispatchCanvasArtefacts', () => {
  it('sends each UI resource to the renderer sink', async () => {
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((a) => seen.push(a))

    await dispatchCanvasArtefacts(uiResult())

    assert.equal(seen.length, 1)
    const [first] = seen
    assert.ok(first)
    assert.equal(first.title, 'Sales Dashboard')
    assert.equal(first.preview, undefined)
  })

  it('attaches the preview the mirror captured', async () => {
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((a) => seen.push(a))
    setCanvasArtefactMirror(() => Promise.resolve('data:image/png;base64,AAA'))

    await dispatchCanvasArtefacts(uiResult())

    const [withPreview] = seen
    assert.ok(withPreview)
    assert.equal(withPreview.preview, 'data:image/png;base64,AAA')
  })

  it('carries the running thread into the mirror and renderer', async () => {
    const mirrored: CanvasArtefact[] = []
    const seen: CanvasArtefact[] = []
    setCanvasArtefactMirror((artefact) => {
      mirrored.push(artefact)
      return Promise.resolve(null)
    })
    setCanvasArtefactSink((artefact) => seen.push(artefact))

    await dispatchCanvasArtefacts(uiResult(), 'thread-a')

    assert.equal(mirrored[0]?.threadId, 'thread-a')
    assert.equal(seen[0]?.threadId, 'thread-a')
  })

  it('awaits the mirror before handing the artefact on', async () => {
    // The tool result returns straight after this resolves, so the artefact must
    // already be loaded in an agent tab — otherwise the model's very next call,
    // browser_screenshot, captures a blank page.
    const order: string[] = []
    setCanvasArtefactSink(() => order.push('sink'))
    setCanvasArtefactMirror(async () => {
      await Promise.resolve()
      order.push('mirror')
      return null
    })

    await dispatchCanvasArtefacts(uiResult())

    assert.deepEqual(order, ['mirror', 'sink'])
  })

  it('still reaches the canvas when the mirror rejects', async () => {
    // Being unable to inspect an artefact must not stop the user seeing it.
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((a) => seen.push(a))
    setCanvasArtefactMirror(() => Promise.reject(new Error('no platform')))

    await dispatchCanvasArtefacts(uiResult())

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.preview, undefined)
  })

  it('does nothing for a result carrying no UI resource', async () => {
    let calls = 0
    setCanvasArtefactSink(() => (calls += 1))
    setCanvasArtefactMirror(() => {
      calls += 1
      return Promise.resolve(null)
    })

    await dispatchCanvasArtefacts([{ type: 'text', text: 'plain output' }])

    assert.equal(calls, 0)
  })
})

describe('inline explainer dispatch', () => {
  it('keeps a scoped explainer inline and emits its reference before completion', async () => {
    const { runWithInlineCanvas } = await import('./inline-canvas-context.ts')
    const seen: CanvasArtefact[] = []
    const types: string[] = []
    setCanvasArtefactSink((artefact) => seen.push(artefact))
    await runWithInlineCanvas(
      'a',
      { emit: (_id, chunk) => types.push(chunk.type) },
      async (host) => {
        await dispatchCanvasArtefacts(uiResult(), 'a', true)
        host.emit('a', { type: 'done' })
      },
    )
    assert.equal(seen[0]?.presentation, 'inline')
    assert.deepEqual(types, ['canvas_artefact', 'done'])
  })

  it('falls back to the ordinary canvas when no owning run can embed the card', async () => {
    const seen: CanvasArtefact[] = []
    setCanvasArtefactSink((artefact) => seen.push(artefact))
    await dispatchCanvasArtefacts(uiResult(), 'a', true)
    assert.equal(seen[0]?.presentation, undefined)
  })
})
