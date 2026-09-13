import { ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  appRunActionSchema,
  appRunOwnerSchema,
  appRunPlatformSchema,
  appRunSelectionSchema,
  appRunSetupInputSchema,
} from '@shared/types/app-run.ts'
import { getAppRunService } from '../services/app-run/app-run-service.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import { runAppProcess } from '../services/app-run/app-run-process.ts'
import { homedir } from 'node:os'

export function initAppRun(win: BrowserWindow): () => void {
  const service = getAppRunService()
  const channels: string[] = []
  function handle<T>(channel: string, schema: z.ZodType<T>, run: (input: T) => unknown): void {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...raw: unknown[]) => {
      assertMainFrameSender(event, win)
      return run(parseIpcArgs(schema, raw))
    })
  }
  handle('app-run:detect', appRunOwnerSchema, (owner) => service.detect(owner))
  handle('app-run:discover', appRunOwnerSchema, (owner) => service.discover(owner))
  handle('app-run:cancel-discovery', appRunOwnerSchema, (owner) => {
    service.cancelDiscovery(owner)
  })
  handle(
    'app-run:devices',
    z.tuple([appRunOwnerSchema, z.string().max(2048), z.string().max(256)]),
    ([owner, appId, variant]) => service.devices(owner, appId, variant),
  )
  handle('app-run:operations', appRunOwnerSchema, (owner) => service.operations(owner))
  handle(
    'app-run:execute',
    z.tuple([appRunOwnerSchema, appRunSelectionSchema, appRunActionSchema]),
    ([owner, selection, action]) => service.execute(owner, selection, action),
  )
  handle('app-run:cancel', z.tuple([appRunOwnerSchema, z.uuid()]), ([owner, id]) =>
    service.cancel(owner, id),
  )
  handle('app-run:stop', z.tuple([appRunOwnerSchema, z.uuid()]), ([owner, id]) =>
    service.stop(owner, id),
  )
  handle(
    'app-run:setup-options',
    z.tuple([appRunOwnerSchema, appRunPlatformSchema]),
    ([owner, platform]) => service.setupOptions(owner, platform),
  )
  handle(
    'app-run:setup',
    z.tuple([appRunOwnerSchema, appRunSetupInputSchema]),
    async ([owner, input]) => {
      // Validate the owner even for fixed external setup destinations.
      await service.operations(owner)
      if (input.action === 'open-xcode' || input.action === 'open-android-studio') {
        const app = input.action === 'open-xcode' ? 'Xcode' : 'Android Studio'
        try {
          await runAppProcess('/usr/bin/open', ['-a', app], homedir(), AbortSignal.timeout(10_000))
        } catch {
          await shell.openExternal(
            input.action === 'open-xcode'
              ? 'https://developer.apple.com/xcode/'
              : 'https://developer.android.com/studio',
          )
        }
        return null
      }
      return service.setup(owner, input)
    },
  )
  return () => {
    service.dispose()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
