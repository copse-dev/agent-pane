import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BrowserSessionManager,
  capturePreviewDataUrl,
  setBrowserSessionPlatform,
} from './session-manager.ts'
import { getStaticPreviewServer, shutdownStaticPreviewServers } from './static-preview-server.ts'

interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number }
  resize(options: { width: number; quality: 'best' }): FakeImage
  toDataURL(): string
}
function image(width: number): FakeImage {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width }),
    resize: ({ width: next }) => image(next),
    toDataURL: () => `data:image/png;base64,${String(width)}`,
  }
}
const decodeImage = (url: string): FakeImage => image(Number(url.split(',').at(-1)))
interface FakeTab {
  events: string[]
  zoom(): number
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<FakeImage>
  debugger: {
    isAttached(): boolean
    attach(version: string): void
    detach(): void
    sendCommand(method: string, params: Record<string, unknown>): Promise<unknown>
  }
}
function contents(
  capture: () => Promise<unknown> = () => Promise.resolve({ data: '1280' }),
  initialZoom = 1,
  existingDebugger = false,
): FakeTab {
  const events: string[] = []
  let zoom = initialZoom
  let attached = existingDebugger
  return {
    events,
    zoom: () => zoom,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor): void => {
      zoom = factor
      events.push(`zoom ${String(factor)}`)
    },
    executeJavaScript: (): Promise<unknown> => {
      events.push('layout')
      return Promise.resolve()
    },
    // Both calls to the old API could return this same stale frame.
    capturePage: (): Promise<FakeImage> => Promise.resolve(image(320)),
    debugger: {
      isAttached: () => attached,
      attach: (version): void => {
        assert.equal(version, '1.3')
        attached = true
        events.push('attach')
      },
      detach: (): void => {
        attached = false
        events.push('detach')
      },
      sendCommand: (method, params): Promise<unknown> => {
        assert.equal(method, 'Page.captureScreenshot')
        assert.deepEqual(params, { format: 'png', fromSurface: true, captureBeyondViewport: false })
        events.push(`capture at ${String(zoom)}`)
        return capture()
      },
    },
  }
}

describe('scoped preview promotion', () => {
  it('rejects preview creation without a task scope', async () => {
    await assert.rejects(
      new BrowserSessionManager().preview('http://localhost:43123/'),
      /scoped browser task/,
    )
  })

  it('does not turn a denied preview URL into a capability for another task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-preview-promotion-'))
    await writeFile(join(root, 'index.html'), '<h1>Private workspace</h1>')
    try {
      const preview = await getStaticPreviewServer(root)
      let shownUrl = ''
      setBrowserSessionPlatform({
        createWindow() {
          throw new Error('This test does not create a browser window')
        },
        getAgentSession() {
          throw new Error('This test does not create an agent session')
        },
        authorizePreview() {
          throw new Error('This test does not authorize a preview')
        },
        hasPreview() {
          return false
        },
        showUrl(url) {
          shownUrl = url
        },
        showArtefact() {},
      })

      await assert.rejects(
        new BrowserSessionManager('another-task').showUrl(preview.url),
        /not open in this browser task/,
      )

      assert.equal(shownUrl, '')
      assert.equal((await fetch(preview.url)).status, 403)
    } finally {
      setBrowserSessionPlatform(null)
      await shutdownStaticPreviewServers()
      await rm(root, { recursive: true })
    }
  })
})

describe('capturePreviewDataUrl', () => {
  it('requests a fresh screenshot rather than copying a cached frame twice', async () => {
    const tab = contents()
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), 'data:image/png;base64,1280')
    assert.deepEqual(tab.events, ['attach', 'zoom 2', 'layout', 'capture at 2', 'zoom 1', 'detach'])
    assert.equal(tab.debugger.isAttached(), false)
  })

  for (const viewportWidth of [1280, 1000]) {
    it(`waits for renderer zoom acknowledgement for a ${String(viewportWidth)}px window`, async () => {
      let viewport = viewportWidth
      let polls = 0
      const tab = contents(() => {
        assert.equal(viewport, viewportWidth / 2, 'captured the stale desktop layout')
        return Promise.resolve({ data: '1280' })
      })
      tab.executeJavaScript = async (code): Promise<unknown> => {
        const result: unknown = runInNewContext(code, {
          window: {
            get innerWidth(): number {
              return viewport
            },
          },
          performance: { now: () => 0 },
          setTimeout: (callback: () => void) => {
            polls += 1
            queueMicrotask(() => {
              viewport = viewportWidth / 2
              callback()
            })
          },
        })
        return await result
      }
      assert.equal(
        await capturePreviewDataUrl(tab, decodeImage, 1280, viewportWidth),
        'data:image/png;base64,1280',
      )
      assert.equal(polls, 1)
      assert.equal(tab.zoom(), 1)
    })
  }

  it('bounds renderer readiness and restores zoom when it never arrives', async () => {
    let elapsed = 0
    const tab = contents(undefined, 1.25)
    tab.executeJavaScript = async (code): Promise<unknown> => {
      const result: unknown = runInNewContext(code, {
        window: { innerWidth: 1280 },
        performance: {
          now: () => {
            elapsed += 2500
            return elapsed
          },
        },
        setTimeout: (callback: () => void) => {
          queueMicrotask(callback)
        },
      })
      return await result
    }
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), null)
    assert.deepEqual(tab.events, ['attach', 'zoom 2', 'zoom 1.25', 'detach'])
  })

  it('keeps preview zoom until the fresh frame is delivered', async () => {
    let deliver: ((value: unknown) => void) | undefined
    let captureStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const frame = new Promise<unknown>((resolve) => {
      deliver = resolve
    })
    const tab = contents(() => {
      captureStarted?.()
      return frame
    })
    const capture = capturePreviewDataUrl(tab, decodeImage)
    await started
    assert.equal(tab.zoom(), 2)
    deliver?.({ data: '1280' })
    assert.equal(await capture, 'data:image/png;base64,1280')
    assert.equal(tab.zoom(), 1)
  })

  it('times out a stalled screenshot, restoring zoom and releasing its debugger', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let captureStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const tab = contents(() => {
      captureStarted?.()
      return new Promise<unknown>(() => {})
    })
    const capture = capturePreviewDataUrl(tab, decodeImage)
    await started
    t.mock.timers.tick(5000)
    assert.equal(await capture, null)
    assert.equal(tab.zoom(), 1)
    assert.equal(tab.debugger.isAttached(), false)
  })

  it('bounds a stalled readiness IPC and ignores its late acknowledgement', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let readinessStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      readinessStarted = resolve
    })
    let acknowledge: ((value: unknown) => void) | undefined
    const tab = contents(undefined, 1.25)
    tab.executeJavaScript = (): Promise<unknown> => {
      tab.events.push('stalled layout')
      readinessStarted?.()
      return new Promise<unknown>((resolve) => {
        acknowledge = resolve
      })
    }
    let outcome: string | null | undefined
    const capture = capturePreviewDataUrl(tab, decodeImage)
    void capture.then((value) => {
      outcome = value
    })
    await started
    t.mock.timers.tick(5000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(outcome, null, 'the main process must bound the readiness IPC')
    assert.equal(await capture, null)
    assert.deepEqual(tab.events, ['attach', 'zoom 2', 'stalled layout', 'zoom 1.25', 'detach'])
    acknowledge?.(undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      tab.events.some((event) => event.startsWith('capture at')),
      false,
    )
    tab.executeJavaScript = (): Promise<unknown> => Promise.resolve()
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), 'data:image/png;base64,1280')
    assert.equal(tab.zoom(), 1.25)
    assert.equal(tab.events.filter((event) => event.startsWith('capture at')).length, 1)
  })

  it('retains separate five-second budgets for readiness and the screenshot', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let readinessStarted: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      readinessStarted = resolve
    })
    let captureStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve
    })
    const tab = contents(() => {
      captureStarted?.()
      return new Promise<unknown>(() => {})
    })
    tab.executeJavaScript = (): Promise<unknown> => {
      readinessStarted?.()
      return new Promise<unknown>((resolve) => {
        setTimeout(() => {
          resolve(undefined)
        }, 4000)
      })
    }
    let settled = false
    const capture = capturePreviewDataUrl(tab, decodeImage)
    void capture.then(() => {
      settled = true
    })
    await ready
    t.mock.timers.tick(4000)
    await started
    t.mock.timers.tick(1000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'readiness must not consume the screenshot budget')
    t.mock.timers.tick(4000)
    assert.equal(await capture, null)
    assert.equal(tab.zoom(), 1)
    assert.equal(tab.debugger.isAttached(), false)
  })

  it('does not detach a debugger that was already attached', async () => {
    const tab = contents(undefined, 1, true)
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), 'data:image/png;base64,1280')
    assert.equal(tab.debugger.isAttached(), true)
    assert.deepEqual(tab.events, ['zoom 2', 'layout', 'capture at 2', 'zoom 1'])
  })

  it('serializes concurrent captures of one tab', async () => {
    const tab = contents()
    await Promise.all([
      capturePreviewDataUrl(tab, decodeImage),
      capturePreviewDataUrl(tab, decodeImage),
    ])
    assert.deepEqual(tab.events, [
      'attach',
      'zoom 2',
      'layout',
      'capture at 2',
      'zoom 1',
      'detach',
      'attach',
      'zoom 2',
      'layout',
      'capture at 2',
      'zoom 1',
      'detach',
    ])
  })

  it('restores a non-default zoom and downsizes a high-density bitmap', async () => {
    const tab = contents(() => Promise.resolve({ data: '2560' }), 1.25)
    assert.equal(await capturePreviewDataUrl(tab, decodeImage, 1280), 'data:image/png;base64,1280')
    assert.equal(tab.zoom(), 1.25)
  })

  it('rejects malformed screenshot responses, empty images and failed commands', async () => {
    for (const result of [{}, { data: 3 }, { data: '0' }]) {
      const tab = contents(() => Promise.resolve(result))
      assert.equal(await capturePreviewDataUrl(tab, decodeImage), null)
      assert.equal(tab.zoom(), 1)
      assert.equal(tab.debugger.isAttached(), false)
    }
    const tab = contents(() => Promise.reject(new Error('window closed')))
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), null)
    assert.equal(tab.zoom(), 1)
    assert.equal(tab.debugger.isAttached(), false)
  })

  it('handles a window destroyed before cleanup', async () => {
    const tab = contents(() => Promise.reject(new Error('Object has been destroyed')))
    let calls = 0
    tab.setZoomFactor = (): void => {
      if (++calls > 1) throw new Error('Object has been destroyed')
    }
    tab.debugger.detach = (): void => {
      throw new Error('Object has been destroyed')
    }
    assert.equal(await capturePreviewDataUrl(tab, decodeImage), null)
  })
})
