import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { discoverPlanUsageCredentials, loadPlanUsageSnapshot } from './plan-usage-bridge.ts'

const noKeychain = (): string | null => null
const noStoredHf = (): string | null => null
const noCursorKeychain = (): string | null => null
const noCursorDb = (): string | null => null

describe('discoverPlanUsageCredentials', () => {
  it('reads Claude, Codex, Hugging Face, and Cursor credentials under a fake home', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } }),
    )
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'codex-tok', account_id: 'acct' } }),
    )
    writeFileSync(join(home, '.cache', 'huggingface', 'token'), 'hf_from_file\n')

    const creds = discoverPlanUsageCredentials(
      home,
      { CURSOR_SESSION_TOKEN: 'user_01%3A%3Ajwt.from.env' },
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeOAuthTokens, ['sk-ant-oat01-test'])
    assert.ok(creds.codex)
    assert.equal(creds.codex.accessToken, 'codex-tok')
    assert.equal(creds.codex.accountId, 'acct')
    assert.equal(creds.huggingfaceToken, 'hf_from_file')
    assert.equal(creds.cursorSessionToken, 'user_01%3A%3Ajwt.from.env')
  })

  it('orders keychain before credentials.json before env setup-token', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }),
    )
    const keychainJson = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-keychain' },
    })
    const creds = discoverPlanUsageCredentials(
      home,
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' },
      () => keychainJson,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeOAuthTokens, [
      'sk-ant-oat01-keychain',
      'sk-ant-oat01-file',
      'sk-ant-oat01-env',
    ])
  })

  it('prefers Settings/stored HF token over env and token file', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true })
    writeFileSync(join(home, '.cache', 'huggingface', 'token'), 'hf_file')
    const creds = discoverPlanUsageCredentials(
      home,
      { HF_TOKEN: 'hf_env' },
      noKeychain,
      () => 'hf_stored',
      noCursorKeychain,
      noCursorDb,
    )
    assert.equal(creds.huggingfaceToken, 'hf_stored')
  })

  it('reads Cursor session from injected state.vscdb reader', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    const creds = discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      () => 'user_01::jwt.from.db',
    )
    assert.equal(creds.cursorSessionToken, 'user_01::jwt.from.db')
  })

  it('returns empty credentials when nothing is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-empty-'))
    const creds = discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeOAuthTokens, [])
    assert.equal(creds.codex, undefined)
    assert.equal(creds.huggingfaceToken, undefined)
    assert.equal(creds.cursorSessionToken, undefined)
  })
})

describe('loadPlanUsageSnapshot', () => {
  it('returns the mock fixture when COPSE_PLAN_USAGE_MOCK=1', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = '1'
    try {
      const snap = await loadPlanUsageSnapshot()
      assert.equal(snap.providers.length, 4)
      assert.ok(snap.providers.every((p) => p.status === 'ok'))
      assert.ok(snap.providers.some((p) => p.provider === 'cursor'))
    } finally {
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
    }
  })
})
