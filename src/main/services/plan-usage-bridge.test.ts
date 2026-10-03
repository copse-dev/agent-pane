import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PlanUsageSnapshot, ProviderPlanResult } from '@copse/plan-usage'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import {
  confirmedPlanUsageProviders,
  discoverPlanUsageCredentials,
  invalidatePlanUsageCache,
  loadPlanUsageSnapshot,
  markUnconfirmedPlanProviders,
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

describe('discoverPlanUsageCredentials limited to confirmed providers', () => {
  function homeWithEverySignIn(): string {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-scoped-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.cache', 'huggingface'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }),
    )
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'codex-tok', account_id: 'acct' } }),
    )
    writeFileSync(join(home, '.cache', 'huggingface', 'token'), 'hf_from_file\n')
    return home
  }

  const everyEnvToken = {
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env',
    HF_TOKEN: 'hf_from_env',
    CURSOR_SESSION_TOKEN: 'user_01%3A%3Ajwt.from.env',
  }

  function recordingReaders(): {
    reads: string[]
    keychain: () => Promise<string | null>
    storedHf: () => string | null
    cursorKeychain: () => Promise<string | null>
    cursorDb: (dbPath: string) => Promise<string | null>
  } {
    const reads: string[] = []
    return {
      reads,
      keychain: async (): Promise<string | null> => {
        reads.push('claude-keychain')
        return null
      },
      storedHf: (): string | null => {
        reads.push('hf-stored')
        return null
      },
      cursorKeychain: async (): Promise<string | null> => {
        reads.push('cursor-keychain')
        return null
      },
      cursorDb: async (): Promise<string | null> => {
        reads.push('cursor-db')
        return null
      },
    }
  }

  it('reads no sign-in at all when nothing is confirmed', async () => {
    const readers = recordingReaders()
    const creds = await discoverPlanUsageCredentials(
      homeWithEverySignIn(),
      everyEnvToken,
      readers.keychain,
      readers.storedHf,
      readers.cursorKeychain,
      readers.cursorDb,
      new Set(),
    )
    assert.deepEqual(readers.reads, [])
    assert.deepEqual(creds.claudeOAuthTokens, [])
    assert.equal(creds.codex, undefined)
    assert.equal(creds.huggingfaceToken, undefined)
    assert.equal(creds.cursorSessionToken, undefined)
  })

  it('reads only the confirmed provider’s sign-in', async () => {
    const readers = recordingReaders()
    const creds = await discoverPlanUsageCredentials(
      homeWithEverySignIn(),
      everyEnvToken,
      readers.keychain,
      readers.storedHf,
      readers.cursorKeychain,
      readers.cursorDb,
      new Set(['codex']),
    )
    assert.deepEqual(readers.reads, [])
    assert.equal(creds.codex?.accessToken, 'codex-tok')
    assert.deepEqual(creds.claudeOAuthTokens, [])
    assert.equal(creds.huggingfaceToken, undefined)
    assert.equal(creds.cursorSessionToken, undefined)
  })

  it('reads the Claude Code Keychain item only once Claude is confirmed', async () => {
    const readers = recordingReaders()
    const creds = await discoverPlanUsageCredentials(
      homeWithEverySignIn(),
      everyEnvToken,
      readers.keychain,
      readers.storedHf,
      readers.cursorKeychain,
      readers.cursorDb,
      new Set(['claude']),
    )
    assert.deepEqual(readers.reads, ['claude-keychain'])
    assert.deepEqual(creds.claudeOAuthTokens, ['sk-ant-oat01-file', 'sk-ant-oat01-env'])
  })
})

describe('confirmedPlanUsageProviders', () => {
  const agent = (id: string): AcpAgentConfig => ({ id, title: id, command: id, enabled: true })
  const noStoredKeys = (): boolean => false

  it('confirms nothing for a fresh install, even with sign-ins on disk or in env', () => {
    assert.deepEqual([...confirmedPlanUsageProviders([], noStoredKeys)], [])
  })

  it('confirms Claude and Codex from their enabled agents', () => {
    const confirmed = confirmedPlanUsageProviders(
      [agent('claude-acp'), agent('codex-acp')],
      noStoredKeys,
    )
    assert.deepEqual([...confirmed].sort(), ['claude', 'codex'])
  })

  it('confirms Cursor from its agent or a saved key, and Hugging Face from a saved key', () => {
    assert.deepEqual([...confirmedPlanUsageProviders([agent('cursor')], noStoredKeys)], ['cursor'])
    const fromKeys = confirmedPlanUsageProviders([], (provider) =>
      ['cursor', 'huggingface'].includes(provider),
    )
    assert.deepEqual([...fromKeys].sort(), ['cursor', 'huggingface'])
  })

  it('ignores agents with no plan of their own', () => {
    assert.deepEqual([...confirmedPlanUsageProviders([agent('gemini')], noStoredKeys)], [])
  })
})

describe('markUnconfirmedPlanProviders', () => {
  it('points each unconfirmed provider at Settings → General and keeps confirmed rows', () => {
    const okCodex: ProviderPlanResult = {
      status: 'ok',
      provider: 'codex',
      usage: { provider: 'codex', plan: 'plus', windows: [], checkedAt: 'now' },
    }
    const snapshot: PlanUsageSnapshot = {
      checkedAt: 'now',
      providers: [
        { status: 'unavailable', provider: 'claude', reason: 'No Claude Code sign-in found.' },
        okCodex,
        { status: 'unavailable', provider: 'huggingface', reason: 'No token.' },
        { status: 'unavailable', provider: 'cursor', reason: 'No session.' },
      ],
    }
    const marked = markUnconfirmedPlanProviders(snapshot, new Set(['codex']))
    assert.deepEqual(marked.providers[1], okCodex)
    for (const index of [0, 2, 3]) {
      const row = marked.providers[index]
      assert.ok(row?.status === 'unavailable', `row ${String(index)} should be unavailable`)
      assert.match(row.reason, /in Settings → General/)
    }
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
