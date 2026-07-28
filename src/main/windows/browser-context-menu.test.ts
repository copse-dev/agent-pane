import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBrowserContextMenuTemplate,
  suggestedImageFilename,
  type BrowserContextMenuActions,
  type BrowserContextMenuParams,
} from './browser-context-menu.ts'

function baseParams(overrides: Partial<BrowserContextMenuParams> = {}): BrowserContextMenuParams {
  const params: BrowserContextMenuParams = {
    x: 10,
    y: 20,
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
  it('always includes Inspect Element', () => {
    const template = buildBrowserContextMenuTemplate(baseParams(), recordingActions())
    assert.deepEqual(labels(template), ['Inspect Element'])
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
    assert.deepEqual(labels(template), ['Inspect Element'])
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
    assert.deepEqual(labels(template), ['Cut', 'Copy', 'Paste', 'Select All', 'Inspect Element'])
  })

  it('shows Copy for a non-editable text selection', () => {
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
      recordingActions(),
    )
    assert.deepEqual(labels(template), ['Copy', 'Select All', 'Inspect Element'])
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
