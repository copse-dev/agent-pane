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
import { browserSelectionShare } from '../services/browser/browser-share.ts'

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
  saveImageAs: (srcURL: string) => void | Promise<void>
  inspectElement: (x: number, y: number) => void
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
        clipboard.writeText(text)
      },
      openTab: (url) => {
        getMainWindow()?.webContents.send('browser:open-tab', url)
      },
      shareSelection: (text, pageUrl) => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        win.webContents.send('browser:share-text', browserSelectionShare(contents, text, pageUrl))
      },
      saveImageAs: (srcURL) => saveImageAs(contents, srcURL),
      inspectElement: (x, y) => {
        contents.inspectElement(x, y)
      },
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup()
  })
}
