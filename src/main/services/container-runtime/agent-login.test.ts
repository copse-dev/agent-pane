import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeStagedLogin, restoreAgentLogin, stageAgentLogin } from './agent-login.ts'

/**
 * The sign-in crossing, both directions, against real directories. The
 * properties that matter: only what exists is copied, a device with no sign-in
 * refuses rather than starting an agent that cannot authenticate, the staged
 * copy is readable by a foreign uid for the run and gone afterwards, and the
 * guest's copy is private to the worker.
 */
describe('agent sign-in carry-in', () => {
  it('stages the sign-in directories that exist, world-readable, and removes them after', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      mkdirSync(join(home, '.codex'), { mode: 0o700 })
      writeFileSync(join(home, '.codex', 'auth.json'), '{"token":"t"}', { mode: 0o600 })
      const staged = stageAgentLogin(home, ['.codex', '.config/codex'], runDir, 'Codex')
      assert.deepEqual(staged, ['.codex'])
      const copy = join(runDir, 'login', '.codex', 'auth.json')
      assert.equal(readFileSync(copy, 'utf8'), '{"token":"t"}')
      assert.equal(statSync(copy).mode & 0o777, 0o644)
      assert.equal(statSync(join(runDir, 'login', '.codex')).mode & 0o777, 0o755)
      // The original is untouched.
      assert.equal(statSync(join(home, '.codex', 'auth.json')).mode & 0o777, 0o600)
      removeStagedLogin(runDir)
      assert.equal(existsSync(join(runDir, 'login')), false)
      // Removing again is a no-op, so a `finally` can always call it.
      removeStagedLogin(runDir)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('refuses a device with no sign-in for the agent, naming where it looked', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      assert.throws(
        () => stageAgentLogin(home, ['.gemini', '.config/gemini'], runDir, 'Gemini CLI'),
        /No Gemini CLI sign-in was found on this device \(looked in ~\/\.gemini, ~\/\.config\/gemini\)/,
      )
      assert.equal(existsSync(join(runDir, 'login')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('restores the staged sign-in into the guest home, private to the worker', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const guestHome = mkdtempSync(join(tmpdir(), 'copse-login-guest-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      mkdirSync(join(home, '.gemini'))
      writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"refresh":"r"}')
      stageAgentLogin(home, ['.gemini', '.config/gemini'], runDir, 'Gemini CLI')
      const restored = restoreAgentLogin(runDir, guestHome, ['.gemini', '.config/gemini'])
      assert.deepEqual(restored, ['.gemini'])
      const copy = join(guestHome, '.gemini', 'oauth_creds.json')
      assert.equal(readFileSync(copy, 'utf8'), '{"refresh":"r"}')
      assert.equal(statSync(copy).mode & 0o777, 0o600)
      assert.equal(statSync(join(guestHome, '.gemini')).mode & 0o777, 0o700)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(guestHome, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
