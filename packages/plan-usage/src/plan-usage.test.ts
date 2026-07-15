import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchClaudePlanUsage } from './claude.ts'
import { fetchCodexPlanUsage } from './codex.ts'
import { parseClaudeCredentialsJson, parseCodexAuthJson } from './credentials.ts'
import { getPlanUsageSnapshot } from './snapshot.ts'
import type { FetchLike } from './types.ts'

function jsonFetch(body: unknown, status = 200): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })
}

describe('parseClaudeCredentialsJson', () => {
  it('reads claudeAiOauth.accessToken', () => {
    assert.equal(
      parseClaudeCredentialsJson({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-abc' },
      }),
      'sk-ant-oat01-abc',
    )
  })

  it('returns null for missing oauth block', () => {
    assert.equal(parseClaudeCredentialsJson({}), null)
    assert.equal(parseClaudeCredentialsJson(null), null)
  })
})

describe('parseCodexAuthJson', () => {
  it('reads tokens.access_token and account_id', () => {
    assert.deepEqual(
      parseCodexAuthJson({
        tokens: { access_token: 'tok', account_id: 'acct-1' },
      }),
      { accessToken: 'tok', accountId: 'acct-1' },
    )
  })

  it('returns null without access token', () => {
    assert.equal(parseCodexAuthJson({ tokens: {} }), null)
  })
})

describe('fetchClaudePlanUsage', () => {
  it('returns unavailable without a token', async () => {
    const result = await fetchClaudePlanUsage(null)
    assert.equal(result.status, 'unavailable')
  })

  it('returns unavailable for console API keys', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-api03-xyz')
    assert.equal(result.status, 'unavailable')
  })

  it('parses five_hour and seven_day windows', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({
        five_hour: { utilization: 42, resets_at: '2026-07-15T12:00:00Z' },
        seven_day: { utilization: 10, resets_at: '2026-07-20T12:00:00Z' },
        seven_day_opus: null,
      }),
      now: () => Date.parse('2026-07-15T08:00:00Z'),
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.windows.length, 2)
    const fiveHour = result.usage.windows[0]
    const weekly = result.usage.windows[1]
    assert.ok(fiveHour)
    assert.ok(weekly)
    assert.equal(fiveHour.id, 'five_hour')
    assert.equal(fiveHour.usedPercent, 42)
    assert.equal(weekly.label, 'Weekly')
  })

  it('returns error on HTTP failure without throwing', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({ error: { message: 'nope' } }, 401),
    })
    assert.equal(result.status, 'error')
  })
})

describe('fetchCodexPlanUsage', () => {
  it('parses primary/secondary windows and plan_type', async () => {
    const result = await fetchCodexPlanUsage(
      { accessToken: 'tok', accountId: 'acct' },
      {
        fetch: jsonFetch({
          plan_type: 'plus',
          rate_limit: {
            primary_window: {
              used_percent: 25,
              limit_window_seconds: 18_000,
              reset_at: 1_784_000_000,
            },
            secondary_window: {
              used_percent: 8,
              limit_window_seconds: 604_800,
              reset_at: 1_784_500_000,
            },
          },
        }),
        now: () => 1_783_000_000_000,
      },
    )
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.plan, 'plus')
    const primary = result.usage.windows[0]
    const secondary = result.usage.windows[1]
    assert.ok(primary)
    assert.ok(secondary)
    assert.equal(primary.label, '5-hour')
    assert.equal(secondary.label, 'Weekly')
    assert.equal(primary.usedPercent, 25)
  })

  it('returns unavailable without token', async () => {
    const result = await fetchCodexPlanUsage({ accessToken: null })
    assert.equal(result.status, 'unavailable')
  })
})

describe('getPlanUsageSnapshot', () => {
  it('never throws when both providers fail hard', async () => {
    const boom: FetchLike = async () => {
      throw new Error('network down')
    }
    const snap = await getPlanUsageSnapshot(
      {
        claudeOAuthToken: 'sk-ant-oat01-x',
        codex: { accessToken: 'tok' },
      },
      { fetch: boom },
    )
    assert.equal(snap.providers.length, 2)
    assert.ok(snap.providers.every((p) => p.status === 'error'))
  })

  it('reports unavailable when no credentials are supplied', async () => {
    const snap = await getPlanUsageSnapshot({})
    assert.equal(snap.providers.length, 2)
    assert.ok(snap.providers.every((p) => p.status === 'unavailable'))
  })
})
