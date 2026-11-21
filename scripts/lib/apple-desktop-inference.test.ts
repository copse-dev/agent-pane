import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { initializeDesktopGuestSettings } from './apple-desktop-inference.mts'
import { DESKTOP_PARENT_MODEL } from '../../src/main/services/isolated-desktop/guest-provider.ts'
import { loadStartupSettings } from '../../src/renderer/controller/startup-settings.ts'
import { resolveRoutedModel } from '../../src/main/services/providers/role-models.ts'
import { normalizeRoleModelSelection } from '../../src/main/services/providers/provider-selection.ts'

it('opens the preconfigured guest without onboarding replacing its approved model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copse-desktop-settings-'))
  try {
    await initializeDesktopGuestSettings(root)
    const file = join(root, 'user-data', 'settings.json')
    const values = safeJsonParse(
      await readFile(file, 'utf8'),
      decodeWithSchema(z.record(z.string(), z.unknown())),
    )
    assert.ok(values)
    const settings = {
      get: async (key: string): Promise<unknown> => values[key] ?? null,
      set: async (key: string, value: unknown): Promise<void> => {
        values[key] = value
      },
    }
    assert.equal(await settings.get('onboardingCompleted'), true)
    assert.equal((await loadStartupSettings(settings)).model, DESKTOP_PARENT_MODEL)
    for (const key of ['smallTasksModel', 'subagentModel', 'advisorModel', 'reviewModel']) {
      const selection = resolveRoutedModel(key, 'lmstudio:unavailable-default', {
        roleModels: {},
        legacy: (name, fallback) => {
          const value = values[name]
          return typeof value === 'string' ? value : fallback
        },
      })
      assert.equal(normalizeRoleModelSelection(selection), DESKTOP_PARENT_MODEL)
    }
    assert.deepEqual(values['extraProviders'], [
      {
        slug: 'isolated-parent',
        label: 'Approved parent session model',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: [{ id: 'session', contextWindow: 128_000 }],
      },
    ])
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
