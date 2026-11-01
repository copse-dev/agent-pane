import { app, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { LICENSE_FILE_KINDS, type AboutInfo } from '@shared/third-party-licenses.mts'
import { defineHandler } from './define-handler.ts'
import {
  chromiumLicensePath,
  openableLicenseFile,
  readThirdPartyLicenseReport,
} from '../services/about/third-party-licenses.ts'
import { getElectronAppVersion } from '../services/electron-app-runtime.ts'

export function registerAboutHandlers(win: BrowserWindow): void {
  defineHandler(win, 'about:get-info', z.tuple([]), async (): Promise<AboutInfo> => ({
    version: getElectronAppVersion(),
    report: await readThirdPartyLicenseReport(),
  }))
  defineHandler(
    win,
    'about:open-license-file',
    z.tuple([z.enum(LICENSE_FILE_KINDS)]),
    async (kind) => {
      const file = openableLicenseFile(
        kind,
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
    },
  )
}
