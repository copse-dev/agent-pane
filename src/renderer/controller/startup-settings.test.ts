import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import { loadStartupSettings } from './startup-settings.ts'

test('loads every first-paint setting concurrently', async () => {
  const calls: string[] = []
  const releases: Array<() => void> = []
  const settings = {
    get: (key: string): Promise<unknown> => {
      calls.push(key)
      return new Promise((resolve) => {
        releases.push(() => {
          resolve(key)
        })
      })
    },
  } satisfies Pick<ApiClient['settings'], 'get'>

  const pending = loadStartupSettings(settings)

  assert.deepEqual(calls, [
    'model',
    'layout',
    'autoPortraitRightPanel',
    'rightPanelPosition',
    'openLinksInBuiltInBrowser',
    'theme',
    'fontSize',
    'uiScale',
    'uiAccentColor',
    'uiTintColor',
    'uiTintStrength',
    'developerMode',
  ])

  for (const release of releases) release()
  const loaded = await pending
  assert.equal(loaded.model, 'model')
  assert.equal(loaded.uiTintStrength, 'uiTintStrength')
  assert.equal(loaded.developerMode, 'developerMode')
})
