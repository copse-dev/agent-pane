import { createStore } from '@shared/store/store.ts'
import { openAppRunDialog } from '../../../src/renderer/views/app-run-dialog.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import type { AppRunOperation, AppRunPlatform } from '@shared/types/app-run.ts'

const mode = new URLSearchParams(location.search).get('mode') ?? 'android'
const platform: AppRunPlatform = mode === 'apple' ? 'apple' : 'android'
const owner = { projectId: 'sample', threadId: 'thread' }
const api = createFakeApi()
const app = {
  id: 'sample-app',
  platform,
  name: 'Fieldnotes',
  location: platform === 'apple' ? 'Fieldnotes.xcodeproj' : 'android/app',
  variants: platform === 'apple' ? ['Fieldnotes'] : ['Debug', 'DemoDebug'],
}
let operation: AppRunOperation | undefined
api.appRun.discover = async () => ({ apps: [app], devices: [], issues: [], preferred: null })
api.appRun.devices = async () =>
  mode === 'setup'
    ? []
    : [
        {
          id: 'phone',
          platform,
          name: platform === 'apple' ? 'iPhone 17 Pro' : 'Pixel 9',
          runtime: platform === 'apple' ? 'iOS 26.5' : 'Android Emulator',
          state: 'stopped',
        },
      ]
api.appRun.operations = async () => (operation ? [operation] : [])
api.appRun.execute = async (_owner, _selection, action) => {
  operation = {
    id: 'fixture-operation',
    owner,
    action,
    stage: 'building',
    appName: 'Fieldnotes',
    deviceName: 'Pixel 9',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: '> :app:compileDebugKotlin\n> :app:mergeDebugResources\nCompiling app sources…',
    error: null,
    desktopId: null,
    appSessionId: null,
  }
  return operation
}
api.appRun.cancel = async () => {
  if (operation) operation = { ...operation, stage: 'cancelled' }
}
api.appRun.setupOptions = async () => ({
  runtimes: [
    { id: 'android-35', name: 'Android 15 · Google APIs · arm64', installed: true },
    { id: 'android-36', name: 'Android 16 · Google APIs · arm64', installed: false },
  ],
  deviceTypes: [{ id: 'pixel_9', name: 'Pixel 9' }],
})
const store = createStore({
  projects: [{ id: 'sample', path: '/workspace/fieldnotes', name: 'Fieldnotes' }],
  activeProjectId: 'sample',
  activeThreadId: 'thread',
  workspaceRoot: '/workspace/fieldnotes',
})
openAppRunDialog(store, api)
