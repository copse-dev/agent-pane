import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachBrowserGuestShareShortcut,
  buildBrowserContextMenuTemplate,
  createBrowserGuestInspectionController,
  inspectBrowserGuestElement,
  isBrowserShareShortcutInput,
  suggestedImageFilename,
  type BrowserContextMenuActions,
  type BrowserContextMenuParams,
  type BrowserGuestInspector,
  type BrowserGuestShortcutContents,
  type BrowserGuestShortcutWindow,
} from './browser-context-menu.ts'

function keyInput(overrides: Partial<Electron.Input> = {}): Electron.Input {
  return {
    type: 'keyDown',
    key: 'l',
    code: 'KeyL',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...overrides,
  }
}

function baseParams(overrides: Partial<BrowserContextMenuParams> = {}): BrowserContextMenuParams {
  const params: BrowserContextMenuParams = {
    x: 10,
    y: 20,
    pageURL: 'https://example.com/current',
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    hasImageContents: false,
    isEditable: false,
    selectionText: '',
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    },
    ...overrides,
  }
  return params
}

function recordingActions(): BrowserContextMenuActions & {
  calls: string[]
} {
  const calls: string[] = []
  const actions: BrowserContextMenuActions & { calls: string[] } = {
    calls,
    cut: (): void => {
      calls.push('cut')
    },
    copy: (): void => {
      calls.push('copy')
    },
    paste: (): void => {
      calls.push('paste')
    },
    selectAll: (): void => {
      calls.push('selectAll')
    },
    copyImageAt: (x: number, y: number): void => {
      calls.push(`copyImageAt:${String(x)},${String(y)}`)
    },
    writeClipboardText: (text: string): void => {
      calls.push(`clipboard:${text}`)
    },
    openTab: (url: string): void => {
      calls.push(`openTab:${url}`)
    },
    shareSelection: (text: string, pageUrl: string): void => {
      calls.push(`shareSelection:${pageUrl}:${text}`)
    },
    shareScreenshot: (): void => {
      calls.push('shareScreenshot')
    },
    saveImageAs: (srcURL: string): void => {
      calls.push(`saveImageAs:${srcURL}`)
    },
    inspectElement: (x: number, y: number): void => {
      calls.push(`inspect:${String(x)},${String(y)}`)
    },
  }
  return actions
}

function labels(template: Electron.MenuItemConstructorOptions[]): string[] {
  return template
    .filter((item) => item.type !== 'separator')
    .map((item) => item.label)
    .filter((label): label is string => typeof label === 'string')
}

function invokeItemClick(template: Electron.MenuItemConstructorOptions[], label: string): void {
  const item = template.find((entry) => entry.label === label)
  assert.ok(item)
  const click = item.click
  assert.ok(click)
  Reflect.apply(click, undefined, [])
}

describe('buildBrowserContextMenuTemplate', () => {
  it('always includes Share Screenshot and Inspect Element', () => {
    const actions = recordingActions()
    const template = buildBrowserContextMenuTemplate(baseParams(), actions)
    assert.deepEqual(labels(template), ['Share Screenshot with Thread', 'Inspect Element'])

    invokeItemClick(template, 'Share Screenshot with Thread')
    assert.deepEqual(actions.calls, ['shareScreenshot'])
  })

  it('offers open/copy for http(s) links', () => {
    const actions = recordingActions()
    const template = buildBrowserContextMenuTemplate(
      baseParams({ linkURL: 'https://example.com/docs' }),
      actions,
    )
    assert.deepEqual(labels(template), [
      'Open Link in New Tab',
      'Copy Link Address',
      'Share Screenshot with Thread',
      'Inspect Element',
    ])

    invokeItemClick(template, 'Open Link in New Tab')
    invokeItemClick(template, 'Copy Link Address')
    assert.deepEqual(actions.calls, [
      'openTab:https://example.com/docs',
      'clipboard:https://example.com/docs',
    ])
  })

  it('ignores non-http link URLs', () => {
    const template = buildBrowserContextMenuTemplate(
      baseParams({ linkURL: 'javascript:alert(1)' }),
      recordingActions(),
    )
    assert.deepEqual(labels(template), ['Share Screenshot with Thread', 'Inspect Element'])
  })

  it('offers copy/save image actions for images', () => {
    const actions = recordingActions()
    const template = buildBrowserContextMenuTemplate(
      baseParams({
        mediaType: 'image',
        hasImageContents: true,
        srcURL: 'https://cdn.example.com/photo.png',
        x: 4,
        y: 8,
      }),
      actions,
    )
    assert.deepEqual(labels(template), [
      'Copy Image',
      'Copy Image Address',
      'Save Image As…',
      'Share Screenshot with Thread',
      'Inspect Element',
    ])

    invokeItemClick(template, 'Copy Image')
    invokeItemClick(template, 'Copy Image Address')
    invokeItemClick(template, 'Save Image As…')
    assert.deepEqual(actions.calls, [
      'copyImageAt:4,8',
      'clipboard:https://cdn.example.com/photo.png',
      'saveImageAs:https://cdn.example.com/photo.png',
    ])
  })

  it('shows cut/copy/paste in editable fields', () => {
    const template = buildBrowserContextMenuTemplate(
      baseParams({
        isEditable: true,
        editFlags: {
          canCut: true,
          canCopy: true,
          canPaste: true,
          canSelectAll: true,
        },
      }),
      recordingActions(),
    )
    assert.deepEqual(labels(template), [
      'Cut',
      'Copy',
      'Paste',
      'Select All',
      'Share Screenshot with Thread',
      'Inspect Element',
    ])
  })

  it('shows Copy for a non-editable text selection', () => {
    const actions = recordingActions()
    const template = buildBrowserContextMenuTemplate(
      baseParams({
        selectionText: 'hello',
        editFlags: {
          canCut: false,
          canCopy: true,
          canPaste: false,
          canSelectAll: true,
        },
      }),
      actions,
    )
    assert.deepEqual(labels(template), [
      'Copy',
      'Share Selection with Thread',
      'Select All',
      'Share Screenshot with Thread',
      'Inspect Element',
    ])

    invokeItemClick(template, 'Share Selection with Thread')
    assert.deepEqual(actions.calls, ['shareSelection:https://example.com/current:hello'])
  })
})

describe('inspectBrowserGuestElement', () => {
  function recordingInspector(initiallyOpen = false): {
    inspector: BrowserGuestInspector
    calls: string[]
    announceOpened: () => void
    destroy: () => void
  } {
    const calls: string[] = []
    let destroyed = false
    let opened = initiallyOpen
    let openedListener: (() => void) | undefined
    const inspector: BrowserGuestInspector = {
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => opened,
      onceDevToolsOpened: (listener) => {
        openedListener = listener
      },
      openDevTools: () => {
        calls.push('open')
      },
      inspectElement: (x, y) => {
        calls.push(`inspect:${String(x)},${String(y)}`)
      },
    }
    return {
      inspector,
      calls,
      announceOpened: (): void => {
        opened = true
        openedListener?.()
      },
      destroy: (): void => {
        destroyed = true
      },
    }
  }

  it('waits for the native menu to close before opening and targeting DevTools', () => {
    const recording = recordingInspector()
    const controller = createBrowserGuestInspectionController(recording.inspector)

    controller.selectElement(10, 20)
    assert.deepEqual(recording.calls, [])

    controller.menuClosed()
    assert.deepEqual(recording.calls, ['open'])

    recording.announceOpened()
    assert.deepEqual(recording.calls, ['open', 'inspect:10,20'])
  })

  it('does nothing when the native menu closes without selecting Inspect Element', () => {
    const recording = recordingInspector()
    const controller = createBrowserGuestInspectionController(recording.inspector)

    controller.menuClosed()

    assert.deepEqual(recording.calls, [])
  })

  it('inspects immediately when DevTools are already open', () => {
    const recording = recordingInspector(true)

    inspectBrowserGuestElement(recording.inspector, 4, 8)

    assert.deepEqual(recording.calls, ['inspect:4,8'])
  })

  it('does not inspect a guest destroyed while DevTools open', () => {
    const recording = recordingInspector()

    inspectBrowserGuestElement(recording.inspector, 2, 6)
    recording.destroy()
    recording.announceOpened()

    assert.deepEqual(recording.calls, ['open'])
  })
})

describe('isBrowserShareShortcutInput', () => {
  it('matches a plain Ctrl+L keydown', () => {
    assert.equal(isBrowserShareShortcutInput(keyInput({ control: true })), true)
  })

  it('matches Cmd (meta)+L too, for macOS', () => {
    assert.equal(isBrowserShareShortcutInput(keyInput({ meta: true })), true)
  })

  it('ignores keyup — only the keydown fires the share', () => {
    assert.equal(isBrowserShareShortcutInput(keyInput({ control: true, type: 'keyUp' })), false)
  })

  it('ignores L without a modifier', () => {
    assert.equal(isBrowserShareShortcutInput(keyInput()), false)
  })

  it('ignores Ctrl+Shift+L and Ctrl+Alt+L', () => {
    assert.equal(isBrowserShareShortcutInput(keyInput({ control: true, shift: true })), false)
    assert.equal(isBrowserShareShortcutInput(keyInput({ control: true, alt: true })), false)
  })

  it('ignores a different key entirely', () => {
    assert.equal(
      isBrowserShareShortcutInput(keyInput({ control: true, code: 'KeyK', key: 'k' })),
      false,
    )
  })
})

function fakeShortcutContents(selection: string): {
  contents: BrowserGuestShortcutContents
  fire: (input: Electron.Input) => { prevented: boolean }
} {
  let handler: ((event: Electron.Event, input: Electron.Input) => void) | null = null
  const contents: BrowserGuestShortcutContents = {
    on: (_event, listener): void => {
      handler = listener
    },
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(selection),
    capturePage: () => Promise.resolve({ toDataURL: () => 'data:image/png;base64,SHOT' }),
    getTitle: () => 'Guest page',
    getURL: () => 'https://example.com/guest',
  }
  return {
    contents,
    fire: (input): { prevented: boolean } => {
      let prevented = false
      assert.ok(
        handler,
        'attachBrowserGuestShareShortcut must register a before-input-event listener',
      )
      const event: Electron.Event = {
        preventDefault: (): void => {
          prevented = true
        },
        defaultPrevented: false,
      }
      handler(event, input)
      return { prevented }
    },
  }
}

function fakeWindow(sent: [string, unknown][]): BrowserGuestShortcutWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload): void => {
        sent.push([channel, payload])
      },
    },
  }
}

describe('attachBrowserGuestShareShortcut', () => {
  it('shares the selection and suppresses the menu accelerator when the guest has one', async () => {
    const sent: [string, unknown][] = []
    const { contents, fire } = fakeShortcutContents('the selected sentence')
    attachBrowserGuestShareShortcut(contents, () => fakeWindow(sent))

    const { prevented } = fire(keyInput({ control: true }))
    assert.equal(prevented, true)
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(sent, [
      [
        'browser:share-text',
        {
          label: 'Browser selection — Guest page',
          content: 'Source: https://example.com/guest\n\nthe selected sentence',
        },
      ],
    ])
  })

  it('shares a screenshot when the guest has no selection', async () => {
    const sent: [string, unknown][] = []
    const { contents, fire } = fakeShortcutContents('')
    attachBrowserGuestShareShortcut(contents, () => fakeWindow(sent))

    fire(keyInput({ meta: true }))
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(sent, [
      ['browser:share-image', { dataUrl: 'data:image/png;base64,SHOT', mimeType: 'image/png' }],
    ])
  })

  it('ignores non-matching input — the global accelerator keeps it', () => {
    const { contents, fire } = fakeShortcutContents('irrelevant')
    attachBrowserGuestShareShortcut(contents, () => {
      assert.fail('must not resolve a window for input that does not match the shortcut')
    })

    const { prevented } = fire(keyInput())
    assert.equal(prevented, false)
  })
})

describe('suggestedImageFilename', () => {
  it('uses the URL path basename when it has an extension', () => {
    assert.equal(
      suggestedImageFilename('https://cdn.example.com/assets/hero.webp?w=800'),
      'hero.webp',
    )
  })

  it('falls back to image.png when the path has no filename extension', () => {
    assert.equal(suggestedImageFilename('https://cdn.example.com/img/42'), 'image.png')
    assert.equal(suggestedImageFilename('not a url'), 'image.png')
  })
})
