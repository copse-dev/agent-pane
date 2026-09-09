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
 * The sign-in crossing, both directions, against real files. The properties
 * that matter: only the named files are copied and only those that exist — a
 * session transcript beside them never crosses — a device with no sign-in
 * refuses rather than starting an agent that cannot authenticate, the staged
 * copy is readable by a foreign uid for the run and gone afterwards, and the
 * guest's copy is private to the worker.
 */
const CODEX_FILES = ['.codex/auth.json']
const GEMINI_FILES = [
  '.gemini/oauth_creds.json',
  '.gemini/google_accounts.json',
  '.gemini/settings.json',
]

describe('agent sign-in carry-in', () => {
  it('stages only the sign-in files that exist, world-readable, and removes them after', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      mkdirSync(join(home, '.codex', 'sessions'), { recursive: true, mode: 0o700 })
      writeFileSync(join(home, '.codex', 'auth.json'), '{"token":"t"}', { mode: 0o600 })
      // The bulk beside the sign-in: never copied.
      writeFileSync(join(home, '.codex', 'sessions', 'rollout.jsonl'), 'x'.repeat(4096))
      const staged = await stageAgentLogin(home, CODEX_FILES, runDir, 'Codex')
      assert.deepEqual(staged, ['.codex/auth.json'])
      const copy = join(runDir, 'login', '.codex', 'auth.json')
      assert.equal(readFileSync(copy, 'utf8'), '{"token":"t"}')
      assert.equal(statSync(copy).mode & 0o777, 0o644)
      assert.equal(existsSync(join(runDir, 'login', '.codex', 'sessions')), false)
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

  it('refuses a device with no sign-in for the agent, naming where it looked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      await assert.rejects(
        () => stageAgentLogin(home, GEMINI_FILES, runDir, 'Gemini CLI'),
        /No Gemini CLI sign-in was found on this device \(looked for ~\/\.gemini\/oauth_creds\.json/,
      )
      assert.equal(existsSync(join(runDir, 'login')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('restores the staged sign-in into the guest home, private to the worker', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-login-home-'))
    const guestHome = mkdtempSync(join(tmpdir(), 'copse-login-guest-'))
    const runDir = mkdtempSync(join(tmpdir(), 'copse-login-run-'))
    try {
      mkdirSync(join(home, '.gemini'))
      writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"refresh":"r"}')
      writeFileSync(join(home, '.gemini', 'settings.json'), '{"selectedAuthType":"oauth-personal"}')
      const staged = await stageAgentLogin(home, GEMINI_FILES, runDir, 'Gemini CLI')
      assert.deepEqual(staged, ['.gemini/oauth_creds.json', '.gemini/settings.json'])
      const restored = restoreAgentLogin(runDir, guestHome, GEMINI_FILES)
      assert.deepEqual(restored, staged)
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
