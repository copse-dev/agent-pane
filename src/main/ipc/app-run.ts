import { ipcMain, shell, type BrowserWindow, type WebContents } from 'electron'
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
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import type { AppRunOwner } from '@shared/types/app-run.ts'

export function initAppRun(win: BrowserWindow): () => void {
  const service = getAppRunService()
  const channels: string[] = []
  function handle<T>(
    channel: string,
    schema: z.ZodType<T>,
    run: (input: T, sender: WebContents) => unknown,
  ): void {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...raw: unknown[]) => {
      assertMainFrameSender(event, win)
      return run(parseIpcArgs(schema, raw), event.sender)
    })
  }
  async function confirmHostAction(
    sender: WebContents,
    owner: AppRunOwner,
    action: string,
  ): Promise<void> {
    const root = await service.confirmationRoot(owner)
    const confirmed = await confirmNativeAction(sender, {
      title: 'Run app tooling outside the sandbox?',
      detail: `${action}\n\nCheckout: ${JSON.stringify(root)}\n\nApp tooling may run project build scripts with your account's access.`,
      approveLabel: 'Continue',
    })
    if (!confirmed) throw new Error('App operation was not confirmed')
    if ((await service.confirmationRoot(owner)) !== root) {
      throw new Error('The app checkout changed during confirmation')
    }
  }
  handle('app-run:detect', appRunOwnerSchema, (owner) => service.detect(owner))
  handle('app-run:discover', appRunOwnerSchema, async (owner, sender) => {
    await confirmHostAction(sender, owner, 'Discover app targets')
    return service.discover(owner)
  })
  handle('app-run:cancel-discovery', appRunOwnerSchema, (owner) => {
    service.cancelDiscovery(owner)
  })
  handle(
    'app-run:devices',
    z.tuple([appRunOwnerSchema, z.string().max(2048), z.string().max(256)]),
    async ([owner, appId, variant], sender) => {
      await confirmHostAction(
        sender,
        owner,
        `Find devices for ${JSON.stringify(appId)} (${variant})`,
      )
      return service.devices(owner, appId, variant)
    },
  )
  handle('app-run:operations', appRunOwnerSchema, (owner) => service.operations(owner))
  handle(
    'app-run:execute',
    z.tuple([appRunOwnerSchema, appRunSelectionSchema, appRunActionSchema]),
    async ([owner, selection, action], sender) => {
      await confirmHostAction(
        sender,
        owner,
        `${action} ${JSON.stringify(selection.appId)} for ${JSON.stringify(selection.deviceId)} (${selection.variant})`,
      )
      return service.execute(owner, selection, action)
    },
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
    async ([owner, platform], sender) => {
      await confirmHostAction(sender, owner, `Find ${platform} setup options`)
      return service.setupOptions(owner, platform)
    },
  )
  handle(
    'app-run:setup',
    z.tuple([appRunOwnerSchema, appRunSetupInputSchema]),
    async ([owner, input], sender) => {
      // Validate the owner even for fixed external setup destinations.
      await confirmHostAction(sender, owner, `Set up ${input.platform}: ${input.action}`)
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
