import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import {
  discoverPlanUsageCredentials,
  invalidatePlanUsageCache,
  loadPlanUsageSnapshot,
  PLAN_USAGE_CACHE_TTL_MS,
  setPlanUsageSnapshotFetcherForTest,
} from './plan-usage-bridge.ts'

const noKeychain = async (): Promise<string | null> => null
const noStoredHf = (): string | null => null
const noCursorKeychain = async (): Promise<string | null> => null
const noCursorDb = async (): Promise<string | null> => null

describe('discoverPlanUsageCredentials', () => {
  it('reads Claude, Codex, Hugging Face, and Cursor credentials under a fake home', async () => {
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

    const creds = await discoverPlanUsageCredentials(
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

  it('carries the expiry, never the refresh token, into claudeCredentials', async () => {
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
    const creds = await discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    // Only Claude Code may spend the refresh token; see plan-usage `claude.ts`.
    assert.deepEqual(creds.claudeCredentials, [
      { accessToken: 'sk-ant-oat01-acc', expiresAt: 1_800_000_000_000 },
    ])
  })

  it('orders keychain before credentials.json before env setup-token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }),
    )
    const keychainJson = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-keychain' },
    })
    const creds = await discoverPlanUsageCredentials(
      home,
      { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' },
      async () => keychainJson,
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

  it('reads the credentials file from CLAUDE_CONFIG_DIR when set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-configdir-'))
    const configDir = mkdtempSync(join(tmpdir(), 'copse-claude-config-'))
    // A decoy at the default location: picking it up would mean the override
    // was ignored, which is the bug this guards.
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-default-dir' } }),
    )
    // The override replaces `~/.claude` — the file sits directly under it.
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-config-dir' } }),
    )

    const creds = await discoverPlanUsageCredentials(
      home,
      { CLAUDE_CONFIG_DIR: configDir },
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeOAuthTokens, ['sk-ant-oat01-config-dir'])
  })

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is blank', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-blankdir-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-default-dir' } }),
    )
    const creds = await discoverPlanUsageCredentials(
      home,
      { CLAUDE_CONFIG_DIR: '   ' },
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )
    assert.deepEqual(creds.claudeOAuthTokens, ['sk-ant-oat01-default-dir'])
  })

  it('prefers Settings/stored HF token over env and token file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true })
    writeFileSync(join(home, '.cache', 'huggingface', 'token'), 'hf_file')
    const creds = await discoverPlanUsageCredentials(
      home,
      { HF_TOKEN: 'hf_env' },
      noKeychain,
      () => 'hf_stored',
      noCursorKeychain,
      noCursorDb,
    )
    assert.equal(creds.huggingfaceToken, 'hf_stored')
  })

  it('reads Cursor session from injected state.vscdb reader', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    const creds = await discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      async () => 'user_01::jwt.from.db',
    )
    assert.equal(creds.cursorSessionToken, 'user_01::jwt.from.db')
  })

  it('returns empty credentials when nothing is present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-empty-'))
    const creds = await discoverPlanUsageCredentials(
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

  it('keeps scanning asynchronous file sources when optional credential files are malformed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-malformed-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), '{not-json')
    writeFileSync(join(home, '.codex', 'auth.json'), '[not-an-object]')
    writeFileSync(join(home, '.cache', 'huggingface', 'token'), 'hf_after_bad_files\n')

    const creds = await discoverPlanUsageCredentials(
      home,
      {},
      noKeychain,
      noStoredHf,
      noCursorKeychain,
      noCursorDb,
    )

    assert.deepEqual(creds.claudeOAuthTokens, [])
    assert.equal(creds.codex, undefined)
    assert.equal(creds.huggingfaceToken, 'hf_after_bad_files')
  })
})

describe('loadPlanUsageSnapshot', () => {
  const snapshot = (checkedAt: string): PlanUsageSnapshot => ({ checkedAt, providers: [] })

  const deferredSnapshot = (): {
    promise: Promise<PlanUsageSnapshot>
    resolve: (snapshot: PlanUsageSnapshot) => void
  } => {
    let resolvePromise: ((snapshot: PlanUsageSnapshot) => void) | undefined
    const promise = new Promise<PlanUsageSnapshot>((resolve) => {
      resolvePromise = resolve
    })
    return {
      promise,
      resolve: (value): void => {
        if (!resolvePromise) assert.fail('Deferred snapshot resolver was not initialized')
        resolvePromise(value)
      },
    }
  }

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

  it('returns the lapsed-token fixture when COPSE_PLAN_USAGE_MOCK=claude-token-expired', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = 'claude-token-expired'
    invalidatePlanUsageCache()
    try {
      const snap = await loadPlanUsageSnapshot()
      const claude = snap.providers.find((provider) => provider.provider === 'claude')
      if (!claude || claude.status !== 'unavailable') assert.fail('Expected Claude unavailable')
      assert.match(claude.reason, /access token has expired/i)
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

  it('keeps an older request from replacing a newer forced refresh', async () => {
    const older = deferredSnapshot()
    const newer = deferredSnapshot()
    let calls = 0
    setPlanUsageSnapshotFetcherForTest(() => {
      calls += 1
      return calls === 1 ? older.promise : newer.promise
    })
    try {
      const olderLoad = loadPlanUsageSnapshot()
      const newerLoad = loadPlanUsageSnapshot({ force: true })
      newer.resolve(snapshot('newer'))
      assert.equal((await newerLoad).checkedAt, 'newer')
      older.resolve(snapshot('older'))
      assert.equal((await olderLoad).checkedAt, 'older')

      assert.equal((await loadPlanUsageSnapshot()).checkedAt, 'newer')
      assert.equal(calls, 2)
    } finally {
      setPlanUsageSnapshotFetcherForTest(null)
    }
  })

  it('keeps newer refresh ownership when an older request finishes first', async () => {
    const older = deferredSnapshot()
    const newer = deferredSnapshot()
    let calls = 0
    setPlanUsageSnapshotFetcherForTest(() => {
      calls += 1
      return calls === 1 ? older.promise : newer.promise
    })
    try {
      const olderLoad = loadPlanUsageSnapshot()
      const newerLoad = loadPlanUsageSnapshot({ force: true })
      older.resolve(snapshot('older'))
      assert.equal((await olderLoad).checkedAt, 'older')

      const joinedLoad = loadPlanUsageSnapshot()
      assert.equal(calls, 2)
      newer.resolve(snapshot('newer'))
      assert.equal((await newerLoad).checkedAt, 'newer')
      assert.equal((await joinedLoad).checkedAt, 'newer')
    } finally {
      setPlanUsageSnapshotFetcherForTest(null)
    }
  })

  it('does not let an invalidated request repopulate the cache', async () => {
    const stale = deferredSnapshot()
    let calls = 0
    setPlanUsageSnapshotFetcherForTest(() => {
      calls += 1
      return calls === 1 ? stale.promise : Promise.resolve(snapshot('fresh'))
    })
    try {
      const staleLoad = loadPlanUsageSnapshot()
      invalidatePlanUsageCache()
      stale.resolve(snapshot('stale'))
      assert.equal((await staleLoad).checkedAt, 'stale')

      assert.equal((await loadPlanUsageSnapshot()).checkedAt, 'fresh')
      assert.equal(calls, 2)
    } finally {
      setPlanUsageSnapshotFetcherForTest(null)
    }
  })
})
