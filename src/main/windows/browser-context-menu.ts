import { browserPartitionForContents } from './browser-web-contents.ts'
import {
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { basename, extname } from 'node:path'
import { getMainWindow } from './create-main-window.ts'
import { isExternalHttpUrl } from './web-contents-lockdown.ts'
import {
  browserSelectionShare,
  captureBrowserScreenshot,
  shareBrowserGuestContent,
} from '../services/browser/browser-share.ts'

/**
 * Subset of Electron's context-menu params that decide which browser-guest items
 * to show. Kept narrow so the template builder stays unit-testable without a
 * full ContextMenuParams mock.
 */
export type BrowserContextMenuParams = {
  x: number
  y: number
  pageURL: string
  linkURL: string
  srcURL: string
  mediaType: Electron.ContextMenuParams['mediaType']
  hasImageContents: boolean
  isEditable: boolean
  selectionText: string
  editFlags: Pick<Electron.EditFlags, 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll'>
}

export type BrowserContextMenuActions = {
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
  copyImageAt: (x: number, y: number) => void
  writeClipboardText: (text: string) => void
  openTab: (url: string) => void
  shareSelection: (text: string, pageUrl: string) => void
  shareScreenshot: () => Promise<void>
  saveImageAs: (srcURL: string) => void | Promise<void>
  inspectElement: (x: number, y: number) => void
}

export type BrowserGuestInspector = {
  isDestroyed: () => boolean
  isDevToolsOpened: () => boolean
  onceDevToolsOpened: (listener: () => void) => void
  openDevTools: () => void
  inspectElement: (x: number, y: number) => void
}

/** Open a guest's DevTools first, then target the element once the tools are ready. */
export function inspectBrowserGuestElement(
  inspector: BrowserGuestInspector,
  x: number,
  y: number,
): void {
  if (inspector.isDestroyed()) return
  if (inspector.isDevToolsOpened()) {
    inspector.inspectElement(x, y)
    return
  }
  inspector.onceDevToolsOpened(() => {
    if (!inspector.isDestroyed()) inspector.inspectElement(x, y)
  })
  inspector.openDevTools()
}

export type BrowserGuestInspectionController = {
  selectElement: (x: number, y: number) => void
  menuClosed: () => void
}

/**
 * Keep the selected point while Electron's native context menu owns its modal
 * loop, then open and target DevTools only after Menu.popup reports it closed.
 */
export function createBrowserGuestInspectionController(
  inspector: BrowserGuestInspector,
): BrowserGuestInspectionController {
  let selectedPoint: { x: number; y: number } | null = null
  return {
    selectElement: (x, y): void => {
      selectedPoint = { x, y }
    },
    menuClosed: (): void => {
      const point = selectedPoint
      selectedPoint = null
      if (point) inspectBrowserGuestElement(inspector, point.x, point.y)
    },
  }
}

function pushGroup(
  template: MenuItemConstructorOptions[],
  items: MenuItemConstructorOptions[],
): void {
  if (items.length === 0) return
  if (template.length > 0) template.push({ type: 'separator' })
  template.push(...items)
}

function hasLink(params: BrowserContextMenuParams): boolean {
  return params.linkURL.length > 0 && isExternalHttpUrl(params.linkURL)
}

function hasImage(params: BrowserContextMenuParams): boolean {
  return params.mediaType === 'image' || params.hasImageContents
}

function hasImageAddress(params: BrowserContextMenuParams): boolean {
  return hasImage(params) && params.srcURL.length > 0
}

/**
 * Build the standard in-app browser right-click menu — the Electron-common set
 * (edit roles, copy link, copy/save image) plus Open Link in New Tab so link
 * opens stay inside Copse's tabbed browser rather than spawning a popup.
 */
export function buildBrowserContextMenuTemplate(
  params: BrowserContextMenuParams,
  actions: BrowserContextMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  const linkItems: MenuItemConstructorOptions[] = []
  if (hasLink(params)) {
    linkItems.push(
      {
        label: 'Open Link in New Tab',
        click: (): void => {
          actions.openTab(params.linkURL)
        },
      },
      {
        label: 'Copy Link Address',
        click: (): void => {
          actions.writeClipboardText(params.linkURL)
        },
      },
    )
  }
  pushGroup(template, linkItems)

  const imageItems: MenuItemConstructorOptions[] = []
  if (hasImage(params)) {
    imageItems.push({
      label: 'Copy Image',
      click: (): void => {
        actions.copyImageAt(params.x, params.y)
      },
    })
  }
  if (hasImageAddress(params)) {
    imageItems.push(
      {
        label: 'Copy Image Address',
        click: (): void => {
          actions.writeClipboardText(params.srcURL)
        },
      },
      {
        label: 'Save Image As…',
        click: (): void => {
          void actions.saveImageAs(params.srcURL)
        },
      },
    )
  }
  pushGroup(template, imageItems)

  const editItems: MenuItemConstructorOptions[] = []
  if (params.isEditable) {
    editItems.push(
      {
        label: 'Cut',
        enabled: params.editFlags.canCut,
        click: (): void => {
          actions.cut()
        },
      },
      {
        label: 'Copy',
        enabled: params.editFlags.canCopy,
        click: (): void => {
          actions.copy()
        },
      },
      {
        label: 'Paste',
        enabled: params.editFlags.canPaste,
        click: (): void => {
          actions.paste()
        },
      },
    )
  } else if (params.selectionText.length > 0 && params.editFlags.canCopy) {
    editItems.push(
      {
        label: 'Copy',
        click: (): void => {
          actions.copy()
        },
      },
      {
        label: 'Share Selection with Thread',
        click: (): void => {
          actions.shareSelection(params.selectionText, params.pageURL)
        },
      },
    )
  }
  if (params.editFlags.canSelectAll && (params.isEditable || params.selectionText.length > 0)) {
    editItems.push({
      label: 'Select All',
      click: (): void => {
        actions.selectAll()
      },
    })
  }
  pushGroup(template, editItems)

  pushGroup(template, [
    {
      label: 'Share Screenshot with Thread',
      click: (): void => {
        void actions.shareScreenshot().catch(reportBrowserShareFailure)
      },
    },
  ])

  pushGroup(template, [
    {
      label: 'Inspect Element',
      click: (): void => {
        actions.inspectElement(params.x, params.y)
      },
    },
  ])

  return template
}

/** Filename hint for Save Image As… — basename of the image URL path when sensible. */
export function suggestedImageFilename(srcURL: string): string {
  try {
    const pathPart = new URL(srcURL).pathname
    const base = basename(pathPart)
    if (base && extname(base)) return base
  } catch {
    // fall through
  }
  return 'image.png'
}

async function saveImageAs(contents: WebContents, srcURL: string): Promise<void> {
  const owner = BrowserWindow.fromWebContents(contents) ?? getMainWindow()
  const options: Electron.SaveDialogOptions = {
    title: 'Save Image',
    defaultPath: suggestedImageFilename(srcURL),
  }
  const result = owner
    ? await dialog.showSaveDialog(owner, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return

  const savePath = result.filePath
  const sess = contents.session
  const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
    // Only claim the download we just started for this image URL.
    if (item.getURL() !== srcURL) return
    sess.removeListener('will-download', onWillDownload)
    item.setSavePath(savePath)
  }
  sess.on('will-download', onWillDownload)
  try {
    contents.downloadURL(srcURL)
  } catch (err) {
    sess.removeListener('will-download', onWillDownload)
    throw err
  }
}

/**
 * Attach a native Chromium-style context menu to an in-app browser guest
 * (`<webview>` on the persist:copse-browser session). Not used for headless
 * agent automation windows — those have no user-facing right-click surface.
 */
export function attachBrowserGuestContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const inspection = createBrowserGuestInspectionController({
      isDestroyed: () => contents.isDestroyed(),
      isDevToolsOpened: () => contents.isDevToolsOpened(),
      onceDevToolsOpened: (listener) => {
        contents.once('devtools-opened', listener)
      },
      openDevTools: () => {
        contents.openDevTools({ mode: 'detach', activate: true })
      },
      inspectElement: (x, y) => {
        contents.inspectElement(x, y)
      },
    })
    const template = buildBrowserContextMenuTemplate(params, {
      cut: () => {
        contents.cut()
      },
      copy: () => {
        contents.copy()
      },
      paste: () => {
        contents.paste()
      },
      selectAll: () => {
        contents.selectAll()
      },
      copyImageAt: (x, y) => {
        contents.copyImageAt(x, y)
      },
      writeClipboardText: (text) => {
        // Electron 44 aligned `clipboard` with the W3C Clipboard API: writeText
        // now returns a Promise. A failed write is not actionable here.
        void clipboard.writeText(text).catch(() => {})
      },
      openTab: (url) => {
        getMainWindow()?.webContents.send(
          'browser:open-tab',
          url,
          browserPartitionForContents(contents),
        )
      },
      shareSelection: (text, pageUrl) => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send('browser:share-text', browserSelectionShare(contents, text, pageUrl))
      },
      shareScreenshot: async () => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        const share = await captureBrowserScreenshot(contents)
        if (!win.isDestroyed()) win.webContents.send('browser:share-image', share)
      },
      saveImageAs: (srcURL) => saveImageAs(contents, srcURL),
      inspectElement: inspection.selectElement,
    })
    if (template.length === 0) return

    const owner = BrowserWindow.fromWebContents(contents) ?? getMainWindow()
    const popupOptions: Electron.PopupOptions = {
      sourceType: params.menuSourceType,
      callback: inspection.menuClosed,
    }
    if (params.frame) popupOptions.frame = params.frame
    if (owner && !owner.isDestroyed()) popupOptions.window = owner
    Menu.buildFromTemplate(template).popup(popupOptions)
  })
}

/**
 * Cmd/Ctrl+L (no alt/shift) on a keydown — matches the terminal and Monaco
 * selection-to-chat shortcut. `code` rather than `key` so a non-US keyboard
 * layout still matches the physical L key.
 */
export function isBrowserShareShortcutInput(
  input: Pick<
    Electron.Input,
    'alt' | 'code' | 'control' | 'isAutoRepeat' | 'meta' | 'shift' | 'type'
  >,
): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false
  const modifier = input.control || input.meta
  if (!modifier || input.alt || input.shift) return false
  return input.code === 'KeyL'
}

/**
 * The slice of a browser guest's `WebContents` that the share shortcut needs —
 * narrow enough that a test double can implement it directly instead of
 * casting past the real, much larger `WebContents` type.
 */
export interface BrowserGuestShortcutContents {
  on(
    event: 'before-input-event',
    listener: (event: Electron.Event, input: Electron.Input) => void,
  ): void
  isDestroyed(): boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<{ toDataURL(): string }>
  getTitle(): string
  getURL(): string
}

/**
 * The slice of the main `BrowserWindow` the share shortcut needs, for the same
 * reason as `BrowserGuestShortcutContents` above.
 */
export interface BrowserGuestShortcutWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

function reportBrowserShareFailure(error: unknown): void {
  console.warn('[browser] failed to share content with thread', error)
}

/**
 * Attach the browser guest's own Cmd/Ctrl+L: share its current text selection
 * with the thread, or a screenshot when nothing is selected. Scoped to this
 * one guest's `WebContents`, so it only ever fires while that tab's page has
 * OS keyboard focus — the moment it doesn't (address bar, composer, another
 * pane), the key event never reaches here and the global "Focus Address Bar"
 * accelerator (`CmdOrCtrl+L` in app-menu.ts) still owns it, unchanged.
 *
 * `event.preventDefault()` on Electron's `before-input-event` suppresses both
 * the page's own keydown handling *and* the menu accelerator for that one
 * keystroke, which is what keeps the two bindings from firing together.
 *
 * `getWindow` defaults to the real main window and exists so a test can hand
 * in a fake one instead of reaching for module mocking.
 */
export function attachBrowserGuestShareShortcut(
  contents: BrowserGuestShortcutContents,
  getWindow: () => BrowserGuestShortcutWindow | null = getMainWindow,
): void {
  contents.on('before-input-event', (event, input) => {
    if (!isBrowserShareShortcutInput(input)) return
    event.preventDefault()
    void shareBrowserGuestContent(contents)
      .then((result) => {
        const win = getWindow()
        if (!win || win.isDestroyed() || contents.isDestroyed()) return
        win.webContents.send(result.channel, result.share)
      })
      .catch(reportBrowserShareFailure)
  })
}
