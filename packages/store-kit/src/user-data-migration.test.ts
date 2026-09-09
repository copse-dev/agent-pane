import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveUserDataDir } from './user-data-migration.ts'

const created: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-user-data-'))
  created.push(dir)
  return dir
}

/** A legacy profile with the two files that actually matter. */
function seedLegacyProfile(dir: string, marker = 'legacy'): string {
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ projects: [marker] }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ marker }))
  writeFileSync(join(dir, 'tools', 'custom.json'), marker)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveUserDataDir', () => {
  it('moves a legacy Electron profile under the Copse data root', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))

    const result = resolveUserDataDir(legacy, { COPSE_DIR: join(root, 'copse') })

    assert.equal(result.outcome, 'moved')
    assert.equal(result.dir, join(root, 'copse', 'user-data'))
    assert.equal(existsSync(legacy), false, 'legacy directory should be gone')
    assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'config.json'), 'utf8')), {
      projects: ['legacy'],
    })
    assert.equal(readFileSync(join(result.dir, 'tools', 'custom.json'), 'utf8'), 'legacy')
  })

  it('is a no-op on the second launch', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))
    const env = { COPSE_DIR: join(root, 'copse') }

    const first = resolveUserDataDir(legacy, env)
    const second = resolveUserDataDir(legacy, env)

    assert.equal(first.outcome, 'moved')
    assert.equal(second.outcome, 'no-legacy-profile')
    assert.equal(second.dir, first.dir)
    assert.deepEqual(JSON.parse(readFileSync(join(second.dir, 'config.json'), 'utf8')), {
      projects: ['legacy'],
    })
  })

  it('never consumes the legacy profile for an explicit COPSE_PANEL_USER_DATA run', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))
    const throwaway = join(root, 'e2e-profile')

    const result = resolveUserDataDir(legacy, {
      COPSE_DIR: join(root, 'copse'),
      COPSE_PANEL_USER_DATA: throwaway,
    })

    assert.equal(result.outcome, 'explicit-profile')
    assert.equal(result.dir, throwaway)
    assert.equal(existsSync(join(legacy, 'config.json')), true, 'legacy profile must be untouched')
    assert.equal(existsSync(throwaway), false, 'no data should be seeded into the e2e profile')
  })

  it('keeps the migrated profile when both directories hold data', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'), 'legacy')
    const target = seedLegacyProfile(join(root, 'copse', 'user-data'), 'migrated')

    const result = resolveUserDataDir(legacy, { COPSE_DIR: join(root, 'copse') })

    assert.equal(result.outcome, 'target-in-use')
    assert.equal(result.dir, target)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'config.json'), 'utf8')), {
      projects: ['migrated'],
    })
    assert.equal(existsSync(join(legacy, 'config.json')), true, 'legacy data must be preserved')
  })

  it('claims an empty target directory rather than refusing to migrate', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))
    const target = join(root, 'copse', 'user-data')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, '.DS_Store'), '')

    const result = resolveUserDataDir(legacy, { COPSE_DIR: join(root, 'copse') })

    assert.equal(result.outcome, 'moved')
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'config.json'), 'utf8')), {
      projects: ['legacy'],
    })
  })

  it('refuses to delete a non-directory sitting at the target path', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))
    const target = join(root, 'copse', 'user-data')
    mkdirSync(join(root, 'copse'), { recursive: true })
    writeFileSync(target, 'someone put a file here')

    const result = resolveUserDataDir(legacy, { COPSE_DIR: join(root, 'copse') })

    assert.equal(result.outcome, 'failed')
    assert.equal(result.dir, legacy)
    assert.equal(readFileSync(target, 'utf8'), 'someone put a file here')
  })

  it('reports no legacy profile for a fresh install', () => {
    const root = tempRoot()

    const result = resolveUserDataDir(join(root, 'appData', 'copse-panel'), {
      COPSE_DIR: join(root, 'copse'),
    })

    assert.equal(result.outcome, 'no-legacy-profile')
    assert.equal(result.dir, join(root, 'copse', 'user-data'))
  })

  it('keeps using the legacy directory when the move cannot complete', () => {
    const root = tempRoot()
    const legacy = seedLegacyProfile(join(root, 'appData', 'copse-panel'))
    // A regular file where the data root must be: mkdir of the parent fails, so
    // the migration cannot proceed and must not strand the app on an empty profile.
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory')

    const result = resolveUserDataDir(legacy, { COPSE_DIR: join(blocked, 'copse') })

    assert.equal(result.outcome, 'failed')
    assert.equal(result.dir, legacy)
    assert.deepEqual(JSON.parse(readFileSync(join(legacy, 'config.json'), 'utf8')), {
      projects: ['legacy'],
    })
  })
})
