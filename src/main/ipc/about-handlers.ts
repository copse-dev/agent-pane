import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { LICENSE_FILE_KINDS, type AboutInfo } from '@shared/third-party-licenses.mts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import {
  chromiumLicensePath,
  openableLicenseFile,
  readThirdPartyLicenseReport,
} from '../services/about/third-party-licenses.ts'
import { getElectronAppVersion } from '../services/electron-app-runtime.ts'

export function registerAboutHandlers(win: BrowserWindow): void {
  ipcMain.handle('about:get-info', async (event): Promise<AboutInfo> => {
    assertMainFrameSender(event, win)
    return { version: getElectronAppVersion(), report: await readThirdPartyLicenseReport() }
  })
  ipcMain.handle('about:open-license-file', async (event, kind: unknown) => {
    assertMainFrameSender(event, win)
    const file = openableLicenseFile(
      parseIpcArgs(z.enum(LICENSE_FILE_KINDS), [kind]),
      undefined,
      chromiumLicensePath({
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        isPackaged: app.isPackaged,
      }),
    )
    // openPath resolves to an error message rather than rejecting.
    const error = await shell.openPath(file)
    if (error) throw new Error(`Could not open ${file}: ${error}`)
  })
}
