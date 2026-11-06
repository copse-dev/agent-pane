import { BrowserWindow, dialog, ipcMain, webContents, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { browserPartitionForContents } from '../windows/browser-web-contents.ts'
import { isVisibleBrowserSessionPartition } from '@shared/browser-session.ts'
import {
  captureBrowserPageText,
  exportBrowserPageHtml,
  captureBrowserScreenshot,
  captureBrowserScrollPosition,
  exportCanvasArtefact,
  exportBrowserPagePdf,
} from '../services/browser/browser-share.ts'
import { assertMainFrameSender, IpcValidationError, parseIpcArgs } from './ipc-guards.ts'

export function registerBrowserShareHandlers(win: BrowserWindow): void {
  function interactiveBrowserContents(
    event: Electron.IpcMainInvokeEvent,
    rawId: unknown,
  ): WebContents {
    assertMainFrameSender(event, win)
    const id = parseIpcArgs(z.number().int().positive(), [rawId])
    const contents = webContents.fromId(id)
    const partition = contents ? browserPartitionForContents(contents) : undefined
    if (
      !contents ||
      contents.isDestroyed() ||
      // The guest must belong to the window asking: the main window, a second
      // main window, or the pane pop-out — never another window's tab.
      contents.hostWebContents !== event.sender ||
      !partition ||
      !isVisibleBrowserSessionPartition(partition)
    ) {
      throw new IpcValidationError('Browser sharing rejected: unknown interactive browser tab')
    }
    return contents
  }

  ipcMain.handle('browser:share-page-text', async (event, rawId: unknown) => {
    const share = await captureBrowserPageText(interactiveBrowserContents(event, rawId))
    if (!event.sender.isDestroyed()) event.sender.send('browser:share-text', share)
  })

  ipcMain.handle('browser:share-screenshot', async (event, rawId: unknown) => {
    const share = await captureBrowserScreenshot(interactiveBrowserContents(event, rawId))
    if (!event.sender.isDestroyed()) event.sender.send('browser:share-image', share)
  })

  ipcMain.handle('browser:capture-screenshot', async (event, rawId: unknown) => {
    return await captureBrowserScreenshot(interactiveBrowserContents(event, rawId))
  })

  ipcMain.handle('browser:scroll-position', async (event, rawId: unknown) => {
    return await captureBrowserScrollPosition(interactiveBrowserContents(event, rawId))
  })

  ipcMain.handle('browser:export-pdf', async (event, rawId: unknown) => {
    const contents = interactiveBrowserContents(event, rawId)
    return await exportBrowserPagePdf(
      contents,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Export PDF',
          defaultPath: defaultFilename,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, data) => {
        await writeFile(filePath, data)
      },
    )
  })

  ipcMain.handle('browser:export-page', async (event, rawId: unknown) => {
    const contents = interactiveBrowserContents(event, rawId)
    return await exportBrowserPageHtml(
      contents,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Download page',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML document', extensions: ['html'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, body) => {
        await writeFile(filePath, body, 'utf8')
      },
    )
  })

  ipcMain.handle('browser:export-artefact', async (event, rawArtefact: unknown) => {
    assertMainFrameSender(event, win)
    const artefact = parseIpcArgs(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        mimeType: z.literal('text/html'),
        body: z
          .string()
          .min(1)
          .max(512 * 1024),
      }),
      [rawArtefact],
    )
    return await exportCanvasArtefact(
      artefact,
      async (defaultFilename) => {
        const result = await dialog.showSaveDialog(win, {
          title: 'Download canvas',
          defaultPath: defaultFilename,
          filters: [{ name: 'HTML document', extensions: ['html'] }],
        })
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async (filePath, body) => {
        await writeFile(filePath, body, 'utf8')
      },
    )
  })
}
