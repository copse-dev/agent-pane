import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  CONCISE_THREADS_DEFAULT_MIGRATION_SETTING,
  loadStartupSettings,
} from './startup-settings.ts'

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
    'sidebarThreadSort',
    'sidebarThreadSortReverse',
    'sidebarThreadGroup',
    'openLinksInBuiltInBrowser',
    'theme',
    'fontSize',
    'animateAgentAvatars',
    'conciseThreadsEnabled',
    'uiScale',
    'uiAccentColor',
    'uiTintColor',
    'uiTintStrength',
    'developerMode',
    'appearanceDefaultsMigrationVersion',
    'conciseThreadsDefaultMigrated',
  ])

  for (const release of releases) release()
  const loaded = await pending
  assert.equal(loaded.model, 'model')
  assert.equal(loaded.animateAgentAvatars, 'animateAgentAvatars')
  assert.equal(loaded.conciseThreadsEnabled, 'conciseThreadsEnabled')
  assert.equal(loaded.uiTintStrength, 'uiTintStrength')
  assert.equal(loaded.developerMode, 'developerMode')
})

test('persists and applies the exact legacy Appearance default migration', async () => {
  const legacy: Record<string, unknown> = {
    theme: 'system',
    uiAccentColor: '#20FD85',
    uiTintColor: '#002E2B',
    uiTintStrength: 'subtle',
    appearanceDefaultsMigrationVersion: null,
    conciseThreadsDefaultMigrated: true,
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
    appearanceDefaultsMigrationVersion: 1,
  })
  assert.equal(loaded.theme, 'dark')
  assert.equal(loaded.uiAccentColor, '#FF93D0')
  assert.equal(loaded.uiTintColor, '#244C25')
  assert.equal(loaded.uiTintStrength, 'subtle')
})

test('marks a customised Appearance combination as evaluated without rewriting it', async () => {
  const values: Record<string, unknown> = {
    theme: 'light',
    uiAccentColor: '#20FD85',
    uiTintColor: '#002E2B',
    uiTintStrength: 'subtle',
    appearanceDefaultsMigrationVersion: null,
    conciseThreadsDefaultMigrated: true,
  }
  const writes = new Map<string, unknown>()
  const settings = {
    get: (key: string): Promise<unknown> => Promise.resolve(values[key] ?? null),
    set: (key: string, value: unknown): Promise<void> => {
      writes.set(key, value)
      return Promise.resolve()
    },
  } satisfies Pick<ApiClient['settings'], 'get' | 'set'>

  const loaded = await loadStartupSettings(settings)

  assert.deepEqual(Object.fromEntries(writes), { appearanceDefaultsMigrationVersion: 1 })
  assert.equal(loaded.theme, 'light')
  assert.equal(loaded.uiAccentColor, '#20FD85')
})

test('does not migrate an exact legacy tuple after the one-time marker is set', async () => {
  const values: Record<string, unknown> = {
    theme: 'system',
    uiAccentColor: '#20FD85',
    uiTintColor: '#002E2B',
    uiTintStrength: 'subtle',
    appearanceDefaultsMigrationVersion: 1,
    conciseThreadsDefaultMigrated: true,
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
  assert.equal(loaded.theme, 'system')
  assert.equal(loaded.uiAccentColor, '#20FD85')
})

function recordingSettings(values: Record<string, unknown>): {
  settings: Pick<ApiClient['settings'], 'get' | 'set'>
  writes: Map<string, unknown>
} {
  const writes = new Map<string, unknown>()
  return {
    writes,
    settings: {
      get: (key: string): Promise<unknown> => Promise.resolve(values[key] ?? null),
      set: (key: string, value: unknown): Promise<void> => {
        writes.set(key, value)
        return Promise.resolve()
      },
    },
  }
}

// Appearance is marked migrated in these so only the concise writes show.
const APPEARANCE_DONE = { appearanceDefaultsMigrationVersion: 1 }

test('clears a stored concise-threads false once when the default turns on', async () => {
  const { settings, writes } = recordingSettings({
    ...APPEARANCE_DONE,
    conciseThreadsEnabled: false,
  })

  const loaded = await loadStartupSettings(settings)

  assert.deepEqual(Object.fromEntries(writes), {
    conciseThreadsEnabled: true,
    [CONCISE_THREADS_DEFAULT_MIGRATION_SETTING]: true,
  })
  assert.equal(loaded.conciseThreadsEnabled, true)
})

test('only marks a fresh profile as evaluated, leaving concise threads on the default', async () => {
  const { settings, writes } = recordingSettings(APPEARANCE_DONE)

  const loaded = await loadStartupSettings(settings)

  assert.deepEqual(Object.fromEntries(writes), {
    [CONCISE_THREADS_DEFAULT_MIGRATION_SETTING]: true,
  })
  assert.equal(loaded.conciseThreadsEnabled, null)
})

test('keeps a concise-threads opt-out made after the migration', async () => {
  const { settings, writes } = recordingSettings({
    ...APPEARANCE_DONE,
    conciseThreadsEnabled: false,
    [CONCISE_THREADS_DEFAULT_MIGRATION_SETTING]: true,
  })

  const loaded = await loadStartupSettings(settings)

  assert.equal(writes.size, 0)
  assert.equal(loaded.conciseThreadsEnabled, false)
})
