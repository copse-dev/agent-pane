import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { VaultError } from '@copse/store-kit/profile-vault-crypto.ts'
import type { AppProfileVault } from '../services/storage/profile-vault.ts'
import type { ProfileVaultResult } from '@shared/types/profile-vault.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'

const actionSchema = z.union([
  z.strictObject({ action: z.literal('enable'), backup: z.boolean() }),
  z.strictObject({ action: z.enum(['unlock', 'backup', 'recover']) }),
])
export function registerProfileVaultIpc(win: BrowserWindow, vault: AppProfileVault): void {
  ipcMain.handle('profile-vault:status', (event) => {
    assertMainFrameSender(event, win)
    return vault.status()
  })
  ipcMain.handle('profile-vault:run', async (event, raw: unknown): Promise<ProfileVaultResult> => {
    assertMainFrameSender(event, win)
    const request = parseIpcArgs(actionSchema, [raw])
    try {
      switch (request.action) {
        case 'enable':
          await vault.enable(request.backup)
          break
        case 'unlock':
          await vault.unlock()
          break
        case 'backup':
          await vault.backup()
          break
        case 'recover':
          await vault.recover()
          break
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof VaultError
            ? error.reason
            : 'Could not complete the change. Stop running tasks and check that this profile is writable.',
      }
    }
  })
  win.once('closed', () => {
    ipcMain.removeHandler('profile-vault:status')
    ipcMain.removeHandler('profile-vault:run')
  })
}
