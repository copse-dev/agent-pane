import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  discoverPlanUsageCredentials,
  invalidatePlanUsageCache,
  loadPlanUsageSnapshot,
  PLAN_USAGE_CACHE_TTL_MS,
  persistRefreshedClaudeToken,
  updateClaudeOAuthJson,
} from './plan-usage-bridge.ts'

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

  it('carries the refresh token and expiry into claudeCredentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-acc',
          refreshToken: 'sk-ant-ort01-ref',
          expiresAt: 1_800_000_000_000,
        },
      }),
    )
    const creds = discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeCredentials, [
      {
        accessToken: 'sk-ant-oat01-acc',
        refreshToken: 'sk-ant-ort01-ref',
        expiresAt: 1_800_000_000_000,
        source: 'credentials.json',
      },
    ])
    assert.equal(typeof creds.onClaudeTokenRefreshed, 'function')
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

describe('updateClaudeOAuthJson', () => {
  it('updates the token fields while preserving everything else', () => {
    const original = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-acc',
        refreshToken: 'old-ref',
        expiresAt: 1,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    })
    const updated = updateClaudeOAuthJson(original, {
      accessToken: 'new-acc',
      refreshToken: 'new-ref',
      expiresAt: 2,
    })
    assert.ok(updated)
    const parsed = JSON.parse(updated) as { claudeAiOauth: Record<string, unknown> }
    assert.equal(parsed.claudeAiOauth['accessToken'], 'new-acc')
    assert.equal(parsed.claudeAiOauth['refreshToken'], 'new-ref')
    assert.equal(parsed.claudeAiOauth['expiresAt'], 2)
    assert.deepEqual(parsed.claudeAiOauth['scopes'], ['user:inference', 'user:profile'])
    assert.equal(parsed.claudeAiOauth['subscriptionType'], 'max')
  })

  it('refuses to touch an unfamiliar payload', () => {
    assert.equal(
      updateClaudeOAuthJson(null, { accessToken: 'x', refreshToken: null, expiresAt: null }),
      null,
    )
    assert.equal(
      updateClaudeOAuthJson('not json', { accessToken: 'x', refreshToken: null, expiresAt: null }),
      null,
    )
    assert.equal(
      updateClaudeOAuthJson('{}', { accessToken: 'x', refreshToken: null, expiresAt: null }),
      null,
    )
  })
})

describe('persistRefreshedClaudeToken', () => {
  it('writes the rotated token back to ~/.claude/.credentials.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-persist-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    const path = join(home, '.claude', '.credentials.json')
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-acc',
          refreshToken: 'old-ref',
          expiresAt: 1,
          scopes: ['a'],
        },
      }),
    )
    persistRefreshedClaudeToken(
      'credentials.json',
      { accessToken: 'new-acc', refreshToken: 'new-ref', expiresAt: 999 },
      home,
      noKeychain,
    )
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth: Record<string, unknown>
    }
    assert.equal(parsed.claudeAiOauth['accessToken'], 'new-acc')
    assert.equal(parsed.claudeAiOauth['refreshToken'], 'new-ref')
    assert.equal(parsed.claudeAiOauth['expiresAt'], 999)
    assert.deepEqual(parsed.claudeAiOauth['scopes'], ['a'])
  })

  it('is a no-op for env-sourced tokens and never throws', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-persist-'))
    assert.doesNotThrow(() => {
      persistRefreshedClaudeToken(
        'env',
        { accessToken: 'x', refreshToken: null, expiresAt: null },
        home,
        noKeychain,
        () => {
          throw new Error('keychain writer should not be called for env')
        },
      )
    })
  })
})

describe('loadPlanUsageSnapshot', () => {
  it('returns the mock fixture when COPSE_PLAN_USAGE_MOCK=1', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = '1'
    invalidatePlanUsageCache()
    try {
      const snap = await loadPlanUsageSnapshot()
      assert.equal(snap.providers.length, 4)
      assert.ok(snap.providers.every((p) => p.status === 'ok'))
      assert.ok(snap.providers.some((p) => p.provider === 'cursor'))
    } finally {
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
      invalidatePlanUsageCache()
    }
  })

  it('returns the auth-error mock fixture when COPSE_PLAN_USAGE_MOCK=auth-errors', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = 'auth-errors'
    invalidatePlanUsageCache()
    try {
      const snap = await loadPlanUsageSnapshot()
      assert.equal(snap.providers.length, 4)
      const claude = snap.providers.find((provider) => provider.provider === 'claude')
      if (!claude || claude.status !== 'unavailable') assert.fail('Expected Claude unavailable')
      assert.match(claude.reason, /credentials were rejected/i)
      const codex = snap.providers.find((provider) => provider.provider === 'codex')
      if (!codex || codex.status !== 'ok') assert.fail('Expected Codex ok')
      const huggingface = snap.providers.find((provider) => provider.provider === 'huggingface')
      if (!huggingface || huggingface.status !== 'error') {
        assert.fail('Expected Hugging Face error')
      }
    } finally {
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
      invalidatePlanUsageCache()
    }
  })

  it('reuses cached snapshots within the TTL', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = '1'
    invalidatePlanUsageCache()
    try {
      const first = await loadPlanUsageSnapshot()
      const second = await loadPlanUsageSnapshot()
      assert.equal(first, second)

      invalidatePlanUsageCache()
      const third = await loadPlanUsageSnapshot({ force: true })
      assert.notEqual(first, third)
    } finally {
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
      invalidatePlanUsageCache()
    }
  })

  it('expires cached snapshots after the TTL', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = '1'
    invalidatePlanUsageCache()
    const { mock } = await import('node:test')
    mock.timers.enable({ apis: ['Date'], now: 0 })
    try {
      const first = await loadPlanUsageSnapshot()
      mock.timers.setTime(PLAN_USAGE_CACHE_TTL_MS + 1)
      const second = await loadPlanUsageSnapshot()
      assert.notEqual(first, second)
    } finally {
      mock.timers.reset()
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
      invalidatePlanUsageCache()
    }
  })
})
