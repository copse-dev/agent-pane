import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { mirrorArtefactToAgent, resetCanvasAgentMirrorForTest } from './canvas-agent-mirror.ts'
import type { CanvasMirrorSession } from './canvas-agent-mirror.ts'
import type { CanvasArtefact } from '@shared/types/canvas.ts'

function artefact(overrides: Partial<CanvasArtefact> = {}): CanvasArtefact {
  return { title: 'Sales Dashboard', mimeType: 'text/html', body: '<h1>v1</h1>', ...overrides }
}

interface Call {
  url: string
  opts?: { newTab?: boolean | undefined; viewId?: string | undefined } | undefined
}

function session(
  overrides: Partial<CanvasMirrorSession> = {},
): CanvasMirrorSession & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    navigate(url, opts): Promise<{ viewId: string }> {
      calls.push({ url, opts })
      return Promise.resolve({ viewId: 'tab-1' })
    },
    capturePreview: () => Promise.resolve('data:image/png;base64,AAA'),
    ...overrides,
  }
}

describe('mirrorArtefactToAgent', () => {
  beforeEach(() => {
    resetCanvasAgentMirrorForTest()
  })

  it('loads the artefact into a new agent tab and returns its preview', async () => {
    const s = session()
    const preview = await mirrorArtefactToAgent(artefact(), s)

    assert.equal(preview, 'data:image/png;base64,AAA')
    assert.equal(s.calls.length, 1)
    assert.deepEqual(s.calls[0]?.opts, { newTab: true })
    // The agent must load the same document the Browser pane renders, so a
    // screenshot is evidence about what the user sees.
    assert.match(s.calls[0].url, /^data:text\/html;charset=utf-8;base64,/)
  })

  it('reuses the tab for a re-render of the same title', async () => {
    const s = session()
    await mirrorArtefactToAgent(artefact(), s)
    await mirrorArtefactToAgent(artefact({ body: '<h1>v2</h1>' }), s)

    assert.equal(s.calls.length, 2)
    const [v1, v2] = s.calls
    assert.ok(v1 && v2)
    assert.deepEqual(v2.opts, { viewId: 'tab-1' })
    assert.notEqual(v1.url, v2.url)
  })

  it('gives a different title its own tab', async () => {
    const s = session()
    await mirrorArtefactToAgent(artefact(), s)
    await mirrorArtefactToAgent(artefact({ title: 'Pricing Page' }), s)

    assert.deepEqual(s.calls[1]?.opts, { newTab: true })
  })

  it('gives the same title in a different thread its own tab', async () => {
    const s = session()
    await mirrorArtefactToAgent(artefact({ threadId: 'thread-a' }), s)
    await mirrorArtefactToAgent(artefact({ threadId: 'thread-b' }), s)

    assert.deepEqual(s.calls[1]?.opts, { newTab: true })
  })

  it('does not navigate to an external URI-list artefact without origin approval', async () => {
    const s = session()
    const preview = await mirrorArtefactToAgent(
      artefact({ mimeType: 'text/uri-list', body: 'https://example.com/dashboard' }),
      s,
    )

    assert.equal(preview, null)
    assert.deepEqual(s.calls, [])
  })

  it('reopens in a fresh tab when the remembered one is gone', async () => {
    // The agent can close its own tabs with browser_tabs; without the retry a
    // single close would wedge the mirror for that title for the whole session.
    let first = true
    const s = session({
      navigate(url, opts): Promise<{ viewId: string }> {
        s.calls.push({ url, opts })
        if (opts?.viewId && first) {
          first = false
          return Promise.reject(new Error('unknown browser tab: tab-1'))
        }
        return Promise.resolve({ viewId: 'tab-9' })
      },
    })
    await mirrorArtefactToAgent(artefact(), s)
    const preview = await mirrorArtefactToAgent(artefact({ body: '<h1>v2</h1>' }), s)

    assert.equal(preview, 'data:image/png;base64,AAA')
    assert.equal(s.calls.length, 3)
    assert.deepEqual(s.calls[2]?.opts, { newTab: true })
  })

  it('returns null rather than throwing when the artefact cannot be loaded', async () => {
    // Being unable to inspect an artefact must never stop it reaching the canvas.
    const s = session({ navigate: () => Promise.reject(new Error('tab limit reached')) })
    assert.equal(await mirrorArtefactToAgent(artefact(), s), null)
  })

  it('returns null when the capture fails', async () => {
    const s = session({ capturePreview: () => Promise.reject(new Error('capture failed')) })
    assert.equal(await mirrorArtefactToAgent(artefact(), s), null)
  })

  it('returns null when the session reports no preview', async () => {
    const s = session({ capturePreview: () => Promise.resolve(null) })
    assert.equal(await mirrorArtefactToAgent(artefact(), s), null)
  })
})
