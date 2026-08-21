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
    set: (): Promise<void> => Promise.resolve(),
  } satisfies Pick<ApiClient['settings'], 'get' | 'set'>

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

test('persists and applies the exact legacy Appearance default migration', async () => {
  const legacy: Record<string, unknown> = {
    theme: 'system',
    uiAccentColor: '#20FD85',
    uiTintColor: '#002E2B',
    uiTintStrength: 'subtle',
  }
  const writes = new Map<string, unknown>()
  const settings = {
    get: (key: string): Promise<unknown> => Promise.resolve(legacy[key] ?? null),
    set: (key: string, value: unknown): Promise<void> => {
      writes.set(key, value)
      return Promise.resolve()
    },
  } satisfies Pick<ApiClient['settings'], 'get' | 'set'>

  const loaded = await loadStartupSettings(settings)

  assert.deepEqual(Object.fromEntries(writes), {
    theme: 'dark',
    uiAccentColor: '#FF93D0',
    uiTintColor: '#244C25',
    uiTintStrength: 'subtle',
  })
  assert.equal(loaded.theme, 'dark')
  assert.equal(loaded.uiAccentColor, '#FF93D0')
  assert.equal(loaded.uiTintColor, '#244C25')
  assert.equal(loaded.uiTintStrength, 'subtle')
})

test('does not rewrite a customised Appearance combination', async () => {
  const values: Record<string, unknown> = {
    theme: 'light',
    uiAccentColor: '#20FD85',
    uiTintColor: '#002E2B',
    uiTintStrength: 'subtle',
  }
  const writes: string[] = []
  const settings = {
    get: (key: string): Promise<unknown> => Promise.resolve(values[key] ?? null),
    set: (key: string): Promise<void> => {
      writes.push(key)
      return Promise.resolve()
    },
  } satisfies Pick<ApiClient['settings'], 'get' | 'set'>

  const loaded = await loadStartupSettings(settings)

  assert.deepEqual(writes, [])
  assert.equal(loaded.theme, 'light')
  assert.equal(loaded.uiAccentColor, '#20FD85')
})
