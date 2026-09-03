import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installE2eProfileCleanup } from '../tests/e2e/helpers/profile-cleanup.ts'

const tempPaths: string[] = []

function makeProfile(): string {
  const path = mkdtempSync(join(tmpdir(), 'copse-wdio-profile-cleanup-'))
  tempPaths.push(path)
  mkdirSync(join(path, 'workspace'))
  writeFileSync(join(path, 'workspace', 'state.json'), '{}')
  return path
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('WebdriverIO profile cleanup', () => {
  it('removes a worker-owned profile eagerly after the session', () => {
    const profile = makeProfile()
    const cleanup = installE2eProfileCleanup(profile, { once: () => undefined })

    cleanup()
    cleanup()

    assert.equal(existsSync(profile), false)
  })

  it('removes the profile on worker exit when session creation never finishes', () => {
    const profile = makeProfile()
    let onExit = (): void => {}
    installE2eProfileCleanup(profile, {
      once: (_event, listener) => {
        onExit = listener
      },
    })

    onExit()

    assert.equal(existsSync(profile), false)
  })
})
