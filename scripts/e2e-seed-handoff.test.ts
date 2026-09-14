import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('restores the pending fixture after an old app overwrites config, then preserves later app writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-e2e-seed-'))
  const config = join(root, 'config.json')
  const pending = join(root, '.e2e-pending-config.json')
  const launcher = resolve('tests/e2e/electron-shell/apply-seed-config.cjs')
  const launch = (): Buffer =>
    execFileSync(process.execPath, [
      '-e',
      'require(process.argv[1]).applyPendingSeedConfig(process.argv[2])',
      launcher,
      root,
    ])
  try {
    const seeded = JSON.stringify({ projects: [{ id: 'seeded' }], activeProjectId: 'seeded' })
    writeFileSync(config, seeded)
    writeFileSync(pending, seeded)
    // The outgoing Electron process persists the empty project list it loaded.
    writeFileSync(config, JSON.stringify({ projects: [] }))
    launch()
    assert.equal(readFileSync(config, 'utf8'), seeded)
    assert.equal(existsSync(pending), false)

    // A subsequent reload without a new seed must preserve product persistence.
    const updated = JSON.stringify({ projects: [{ id: 'created-in-app' }] })
    writeFileSync(config, updated)
    launch()
    assert.equal(readFileSync(config, 'utf8'), updated)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
