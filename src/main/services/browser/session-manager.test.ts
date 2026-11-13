import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import {
  BrowserSessionManager,
  capturePreviewDataUrl,
  resizeBrowserViewport,
} from './session-manager.ts'

interface ViewportFixture {
  window: Parameters<typeof resizeBrowserViewport>[0]
  size: () => number[]
  polls: () => number
}

function viewportFixture(
  capture?: () => Promise<unknown>,
  maxWidth = 2560,
  maxHeight = 1600,
): ViewportFixture {
  let width = 1280
  let height = 800
  let rendererWidth = width
  let rendererHeight = height
  let rendererZoom = 1
  let polls = 0
  const tab = contents(capture)
  tab.executeJavaScript = async (code): Promise<unknown> => {
    const result: unknown = runInNewContext(code, {
      window: {
        get innerWidth(): number {
          return Math.round(rendererWidth / rendererZoom)
        },
        get innerHeight(): number {
          return Math.round(rendererHeight / rendererZoom)
        },
      },
      performance: { now: () => 0 },
      setTimeout: (callback: () => void) => {
        polls += 1
        queueMicrotask(() => {
          rendererWidth = width
          rendererHeight = height
          rendererZoom = tab.zoom()
          callback()
        })
      },
    })
    return await result
  }
  const window: ViewportFixture['window'] = {
    setContentSize: (w, h) => {
      width = Math.min(w, maxWidth)
      height = Math.min(h, maxHeight)
    },
    getContentSize: () => [width, height],
    webContents: tab,
  }
  return { window, size: window.getContentSize, polls: () => polls }
}

describe('browser viewport validation', () => {
  it('rejects invalid sizes before creating a native window', async () => {
    const manager = new BrowserSessionManager()
    await assert.rejects(manager.resize({ width: 0, height: 844 }, 'tab-1'), /240/)
    assert.deepEqual(manager.listTabs(), [])
  })

  it('refuses an unknown tab instead of resizing another one', async () => {
    const manager = new BrowserSessionManager()
    await assert.rejects(
      manager.resize({ width: 390, height: 844 }, 'missing'),
      /unknown browser tab/,
    )
    assert.deepEqual(manager.listTabs(), [])
  })

  it('refuses an empty tab id before resolving or creating a tab', async () => {
    const manager = new BrowserSessionManager()
    await assert.rejects(manager.resize({ width: 390, height: 844 }, ''), /explicit tab id/)
    assert.deepEqual(manager.listTabs(), [])
  })

  it('waits for renderer acknowledgement and restores desktop bounds', async () => {
    const fixture = viewportFixture()
    assert.deepEqual(await resizeBrowserViewport(fixture.window, { width: 390, height: 844 }), {
      width: 390,
      height: 844,
    })
    assert.equal(fixture.polls(), 1)
    assert.deepEqual(await resizeBrowserViewport(fixture.window, { width: 1280, height: 800 }), {
      width: 1280,
      height: 800,
    })
  })

  it('reports measured dimensions when native bounds are clamped', async () => {
    const fixture = viewportFixture(undefined, 1000, 700)
    assert.deepEqual(await resizeBrowserViewport(fixture.window, { width: 2560, height: 1600 }), {
      width: 1000,
      height: 700,
    })
    assert.equal(fixture.polls(), 1)
  })

  it('serializes preview A, resize, preview B and reads B bounds when it starts', async () => {
    const captured = Promise.withResolvers<undefined>()
    const deliver = Promise.withResolvers<unknown>()
    const widths: number[] = []
    const fixture = viewportFixture(() => {
      const width = fixture.size()[0] ?? 0
      widths.push(width / fixture.window.webContents.getZoomFactor())
      if (widths.length === 1) {
        captured.resolve(undefined)
        return deliver.promise
      }
      return Promise.resolve({ data: String(width) })
    })
    const wc = fixture.window.webContents
    const getWidth = (): number => fixture.size()[0] ?? 0
    const first = capturePreviewDataUrl(wc, decodeImage, 1280, getWidth)
    await captured.promise
    const resize = resizeBrowserViewport(fixture.window, { width: 390, height: 844 })
    const second = capturePreviewDataUrl(wc, decodeImage, 1280, getWidth)
    assert.deepEqual(fixture.size(), [1280, 800])
    assert.equal(wc.getZoomFactor(), 2)
    deliver.resolve({ data: '1280' })
    assert.equal(await first, 'data:image/png;base64,1280')
    assert.deepEqual(await resize, { width: 390, height: 844 })
    assert.equal(await second, 'data:image/png;base64,390')
    assert.deepEqual(widths, [640, 195])
    assert.equal(wc.getZoomFactor(), 1)
    assert.equal(wc.debugger.isAttached(), false)
  })

  it('serializes two resizes until each renderer acknowledgement completes', async () => {
    const fixture = viewportFixture()
    const wc = fixture.window.webContents
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const execute = wc.executeJavaScript.bind(wc)
    let calls = 0
    wc.executeJavaScript = async (code): Promise<unknown> => {
      if (++calls === 1) {
        entered.resolve(undefined)
        await release.promise
      }
      return execute(code)
    }
    const first = resizeBrowserViewport(fixture.window, { width: 390, height: 844 })
    await entered.promise
    const second = resizeBrowserViewport(fixture.window, { width: 1280, height: 800 })
    assert.deepEqual(fixture.size(), [390, 844])
    release.resolve(undefined)
    assert.deepEqual(await first, { width: 390, height: 844 })
    assert.deepEqual(await second, { width: 1280, height: 800 })
  })

  it('releases the queue after a timed-out resize so the next preview can complete', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = viewportFixture()
    const wc = fixture.window.webContents
    const execute = wc.executeJavaScript.bind(wc)
    const entered = Promise.withResolvers<undefined>()
    wc.executeJavaScript = (): Promise<unknown> => {
      entered.resolve(undefined)
      return new Promise(() => {})
    }
    const resize = resizeBrowserViewport(fixture.window, { width: 390, height: 844 })
    const rejected = assert.rejects(resize, /Browser resize timed out/)
    await entered.promise
    wc.executeJavaScript = execute
    const capture = capturePreviewDataUrl(wc, decodeImage, 1280, () => fixture.size()[0] ?? 0)
    t.mock.timers.tick(5000)
    await rejected
    assert.equal(await capture, 'data:image/png;base64,1280')
    assert.equal(wc.getZoomFactor(), 1)
    assert.equal(wc.debugger.isAttached(), false)
  })
})

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
        await capturePreviewDataUrl(tab, decodeImage, 1280, () => viewportWidth),
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
