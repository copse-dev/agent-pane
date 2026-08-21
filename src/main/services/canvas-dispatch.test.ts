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
