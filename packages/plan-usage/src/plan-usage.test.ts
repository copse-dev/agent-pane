import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fetchClaudePlanUsage, fetchClaudePlanUsageFromCandidates } from './claude.ts'
import { fetchCodexPlanUsage } from './codex.ts'
import {
  orderClaudeTokenCandidates,
  parseClaudeCredentialsJson,
  parseCodexAuthJson,
  parseHuggingFaceToken,
} from './credentials.ts'
import {
  buildCursorSessionCookie,
  fetchCursorPlanUsage,
  formatCursorCents,
  parseCursorUsage,
} from './cursor.ts'
import {
  fetchHuggingFacePlanUsage,
  formatNanoUsd,
  huggingFaceMonthBoundsUnix,
  parseHuggingFaceUsage,
} from './huggingface.ts'
import { getPlanUsageSnapshot } from './snapshot.ts'
import type { FetchLike } from './types.ts'

function jsonFetch(body: unknown, status = 200): FetchLike {
  const text = JSON.stringify(body)
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
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

  it('parses Keychain JSON string payloads', () => {
    assert.equal(
      parseClaudeCredentialsJson(
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-kc' } }),
      ),
      'sk-ant-oat01-kc',
    )
  })

  it('returns null for missing oauth block', () => {
    assert.equal(parseClaudeCredentialsJson({}), null)
    assert.equal(parseClaudeCredentialsJson(null), null)
  })
})

describe('orderClaudeTokenCandidates', () => {
  it('orders keychain → credentials.json → env and dedupes', () => {
    const ordered = orderClaudeTokenCandidates({
      keychainJson: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-kc' } }),
      credentialsJson: { claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } },
      envToken: 'sk-ant-oat01-env',
    })
    assert.deepEqual(
      ordered.map((c) => ({ source: c.source, token: c.token })),
      [
        { source: 'keychain', token: 'sk-ant-oat01-kc' },
        { source: 'credentials.json', token: 'sk-ant-oat01-file' },
        { source: 'env', token: 'sk-ant-oat01-env' },
      ],
    )
  })

  it('dedupes identical tokens across sources', () => {
    const ordered = orderClaudeTokenCandidates({
      keychainJson: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-same' } }),
      credentialsJson: { claudeAiOauth: { accessToken: 'sk-ant-oat01-same' } },
      envToken: 'sk-ant-oat01-same',
    })
    assert.equal(ordered.length, 1)
    assert.equal(ordered[0]?.source, 'keychain')
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

  it('maps user:profile scope 403 to an actionable unavailable reason', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch(
        {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'OAuth token does not meet scope requirement user:profile',
          },
          request_id: 'req_test',
        },
        403,
      ),
    })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /claude \/login/i)
    assert.match(result.reason, /user:profile/)
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

  it('prefers limits[] so Fable (and other scoped models) appear', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({
        // Legacy keys present but null / stale — live data is in limits[].
        five_hour: null,
        seven_day: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        limits: [
          {
            kind: 'session',
            percent: 12,
            resets_at: '2026-07-15T12:00:00Z',
          },
          {
            kind: 'weekly_all',
            percent: 40,
            resets_at: '2026-07-20T12:00:00Z',
          },
          {
            kind: 'weekly_scoped',
            percent: 55,
            resets_at: '2026-07-18T12:00:00Z',
            scope: { model: { display_name: 'Fable' } },
          },
          {
            kind: 'weekly_scoped',
            percent: 8,
            resets_at: '2026-07-19T12:00:00Z',
            scope: { model: { display_name: 'Opus' } },
          },
        ],
      }),
      now: () => Date.parse('2026-07-15T08:00:00Z'),
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(
      result.usage.windows.map((w) => ({ id: w.id, label: w.label, usedPercent: w.usedPercent })),
      [
        { id: 'five_hour', label: '5-hour', usedPercent: 12 },
        { id: 'seven_day', label: 'Weekly', usedPercent: 40 },
        { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 55 },
        { id: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 8 },
      ],
    )
  })

  it('skips inactive zero-percent limits but keeps inactive non-zero (Fable)', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({
        limits: [
          { kind: 'session', percent: 0, is_active: false, severity: 'normal' },
          {
            kind: 'weekly_all',
            percent: 99,
            is_active: true,
            severity: 'critical',
            resets_at: '2026-07-17T02:00:00Z',
          },
          {
            kind: 'weekly_scoped',
            percent: 89,
            is_active: false,
            severity: 'warning',
            scope: { model: { display_name: 'Fable' } },
            resets_at: '2026-07-17T02:00:00Z',
          },
        ],
      }),
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(
      result.usage.windows.map((w) => ({
        id: w.id,
        label: w.label,
        usedPercent: w.usedPercent,
        severity: w.severity,
      })),
      [
        {
          id: 'seven_day',
          label: 'Weekly',
          usedPercent: 99,
          severity: 'critical',
        },
        {
          id: 'seven_day_fable',
          label: 'Weekly Fable (inactive)',
          usedPercent: 89,
          severity: 'warning',
        },
      ],
    )
  })

  it('labels plan from spend credits when dollar windows are null', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({
        five_hour: { utilization: 0, resets_at: '2026-07-15T14:30:00Z' },
        seven_day: { utilization: 99, resets_at: '2026-07-17T02:00:00Z' },
        spend: {
          used: { amount_minor: 5525, currency: 'GBP', exponent: 2 },
          limit: { amount_minor: 5000, currency: 'GBP', exponent: 2 },
          percent: 100,
          severity: 'critical',
          enabled: false,
        },
        limits: [
          {
            kind: 'weekly_all',
            percent: 99,
            severity: 'critical',
            is_active: true,
            resets_at: '2026-07-17T02:00:00Z',
          },
        ],
      }),
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.plan, 'Extra usage £55.25 / £50 (disabled)')
  })

  it('fills five_hour from dollar fields when limits[] only has weekly', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({
        five_hour: {
          utilization: null,
          resets_at: '2026-07-15T14:00:00Z',
          limit_dollars: 20,
          used_dollars: 5,
          remaining_dollars: 15,
        },
        seven_day: {
          utilization: 99,
          resets_at: '2026-07-17T02:00:00.200Z',
          limit_dollars: 100,
          used_dollars: 99,
          remaining_dollars: 1,
        },
        limits: [
          {
            kind: 'weekly_all',
            percent: 99,
            group: 'weekly',
            cardinality: 'all',
            resets_at: '2026-07-17T02:00:00.200Z',
          },
        ],
      }),
      now: () => Date.parse('2026-07-15T08:00:00Z'),
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.plan, 'Weekly $99 / $100')
    assert.deepEqual(
      result.usage.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent })),
      [
        { id: 'five_hour', usedPercent: 25 },
        { id: 'seven_day', usedPercent: 99 },
      ],
    )
  })

  it('returns error on HTTP failure without throwing', async () => {
    const result = await fetchClaudePlanUsage('sk-ant-oat01-x', {
      fetch: jsonFetch({ error: { message: 'nope' } }, 401),
    })
    assert.equal(result.status, 'error')
  })
})

describe('fetchClaudePlanUsageFromCandidates', () => {
  it('skips setup-token profile-scope 403 and succeeds with the next token', async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      const auth = init?.headers?.['Authorization'] ?? ''
      if (auth.includes('sk-ant-oat01-setup')) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              type: 'error',
              error: {
                type: 'permission_error',
                message: 'OAuth token does not meet scope requirement user:profile',
              },
            }),
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            five_hour: { utilization: 5, resets_at: '2026-07-15T12:00:00Z' },
          }),
      }
    }

    const result = await fetchClaudePlanUsageFromCandidates(
      ['sk-ant-oat01-setup', 'sk-ant-oat01-login'],
      { fetch: fetchImpl },
    )
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.windows[0]?.usedPercent, 5)
  })

  it('surfaces the profile-scope hint when every candidate lacks user:profile', async () => {
    const result = await fetchClaudePlanUsageFromCandidates(['sk-ant-oat01-a', 'sk-ant-oat01-b'], {
      fetch: jsonFetch(
        {
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'OAuth token does not meet scope requirement user:profile',
          },
        },
        403,
      ),
    })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /Keychain/i)
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

  it('parses additional_rate_limits metered features', async () => {
    const result = await fetchCodexPlanUsage(
      { accessToken: 'tok' },
      {
        fetch: jsonFetch({
          plan_type: 'prolite',
          rate_limit: {
            primary_window: {
              used_percent: 1,
              limit_window_seconds: 604_800,
              reset_at: 1_784_000_000,
              reset_after_seconds: 100,
            },
          },
          additional_rate_limits: [
            {
              metered_feature: 'codex_spark',
              rate_limit: {
                primary_window: {
                  used_percent: 40,
                  limit_window_seconds: 18_000,
                  reset_at: 1_784_100_000,
                },
              },
            },
          ],
          credits: {
            has_credits: false,
            unlimited: false,
            balance: '0',
            overage_limit_reached: false,
            approx_local_messages: 0,
            approx_cloud_messages: 0,
          },
          user_id: 'u',
          account_id: 'a',
          email: 'x@y.z',
          spend_control: null,
          promo: null,
          rate_limit_reset_credits: null,
        }),
        now: () => 1_783_000_000_000,
      },
    )
    assert.equal(result.status, 'ok')
    assert.equal(result.usage.plan, 'prolite')
    assert.ok(result.usage.windows.some((w) => w.id === 'primary'))
    const spark = result.usage.windows.find((w) => w.id === 'codex-spark_primary')
    assert.ok(spark)
    assert.equal(spark.usedPercent, 40)
    assert.match(spark.label, /codex_spark/i)
  })

  it('returns unavailable without token', async () => {
    const result = await fetchCodexPlanUsage({ accessToken: null })
    assert.equal(result.status, 'unavailable')
  })
})

describe('parseHuggingFaceToken', () => {
  it('trims bare tokens and rejects JSON', () => {
    assert.equal(parseHuggingFaceToken('  hf_abc  '), 'hf_abc')
    assert.equal(parseHuggingFaceToken('{"token":"x"}'), null)
    assert.equal(parseHuggingFaceToken(''), null)
  })
})

describe('fetchHuggingFacePlanUsage', () => {
  it('maps inferenceProviders nanoUSD into a monthly window', async () => {
    const result = await fetchHuggingFacePlanUsage('hf_test', {
      fetch: jsonFetch({
        usage: {
          Spaces: [],
          Endpoints: [],
          inferenceProviders: {
            includedNanoUsd: 2_000_000_000,
            limitNanoUsd: 302_000_000_000,
            usedNanoUsd: 1_164_299_880,
            numRequests: 55,
            providerDetails: [
              {
                provider: 'novita',
                numRequests: 53,
                totalCostNanoUsd: 1_164_299_880,
                totalDurationMs: 0,
              },
            ],
            periodEnd: '2026-08-01T00:00:00.000Z',
            periodStart: '2026-07-01T00:00:00.000Z',
          },
          jobs: { totalMinutes: 0, usedMicroUsd: 0, hardwareFlavorBreakdown: [] },
          privateStorage: {
            totalTB: 0,
            includedTB: 0,
            totalCents: 0,
            amountDueCents: 0,
          },
          zeroGpu: { billedSeconds: 0 },
        },
      }),
      now: () => Date.parse('2026-07-15T12:00:00Z'),
    })
    assert.equal(result.status, 'ok')
    assert.match(result.usage.plan ?? '', /\$302/)
    assert.match(result.usage.plan ?? '', /\$2\.00/)
    const window = result.usage.windows[0]
    assert.ok(window)
    assert.equal(window.id, 'inference_providers')
    assert.equal(window.label, 'Monthly inference')
    assert.ok(window.usedPercent > 0.3 && window.usedPercent < 0.5)
    assert.equal(window.resetsAt, '2026-08-01T00:00:00.000Z')
  })

  it('computes UTC month bounds used by the billing query', () => {
    assert.deepEqual(huggingFaceMonthBoundsUnix(Date.parse('2026-07-15T12:00:00Z')), {
      start: 1_782_864_000,
      end: 1_785_542_400,
    })
    assert.equal(formatNanoUsd(2_000_000_000), '$2.00')
  })

  it('returns unavailable without a token', async () => {
    const result = await fetchHuggingFacePlanUsage(null)
    assert.equal(result.status, 'unavailable')
  })

  it('maps 403 to an actionable unavailable reason', async () => {
    const result = await fetchHuggingFacePlanUsage('hf_bad', {
      fetch: jsonFetch({ error: 'forbidden' }, 403),
    })
    assert.equal(result.status, 'unavailable')
    assert.match(result.reason, /billing/i)
  })

  it('parseHuggingFaceUsage tolerates a bare usage object', () => {
    const usage = parseHuggingFaceUsage(
      {
        inferenceProviders: {
          includedNanoUsd: 1,
          limitNanoUsd: 100,
          usedNanoUsd: 50,
          periodEnd: '2026-08-01T00:00:00.000Z',
        },
      },
      Date.parse('2026-07-15T12:00:00Z'),
    )
    assert.equal(usage.windows[0]?.usedPercent, 50)
  })
})

describe('fetchCursorPlanUsage', () => {
  const periodFixture = {
    billingCycleStart: '1784073267000',
    billingCycleEnd: '1786751667000',
    planUsage: {
      totalSpend: 1575,
      includedSpend: 1575,
      remaining: 38425,
      limit: 40000,
      remainingBonus: false,
      bonusTooltip: 'bonus',
      autoPercentUsed: 1.575,
      apiPercentUsed: 0,
      totalPercentUsed: 1.05,
    },
    spendLimitUsage: {
      individualLimit: 5000,
      individualRemaining: 5000,
      limitType: 'user',
    },
    displayThreshold: 200,
    enabled: true,
    displayMessage: "You've used 4% of your included usage",
    autoModelSelectedDisplayMessage: 'auto',
    namedModelSelectedDisplayMessage: 'named',
    autoBucketModels: ['default'],
  }

  it('maps period usage cents into included + on-demand windows', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const body = input.includes('get-hard-limit') ? { hardLimit: 50 } : periodFixture
      return jsonFetch(body)(input)
    }
    const result = await fetchCursorPlanUsage('user_01ABC%3A%3Afake.jwt.token', {
      fetch: fetchImpl,
      now: () => Date.parse('2026-07-15T12:00:00Z'),
    })
    assert.equal(result.status, 'ok')
    assert.match(result.usage.plan ?? '', /4%/)
    assert.match(result.usage.plan ?? '', /Hard limit \$50/)
    assert.equal(result.usage.windows.length, 2)
    const plan = result.usage.windows.find((w) => w.id === 'plan')
    const spend = result.usage.windows.find((w) => w.id === 'spend_limit')
    assert.ok(plan)
    assert.ok(spend)
    assert.ok(plan.usedPercent > 3.9 && plan.usedPercent < 4.1)
    assert.equal(spend.usedPercent, 0)
    assert.equal(plan.resetsAt, '2026-08-14T23:54:27.000Z')
  })

  it('builds Workos cookie from a raw JWT sub claim', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'user_01TEST' })).toString('base64url')
    const jwt = `${header}.${payload}.sig`
    assert.equal(buildCursorSessionCookie(jwt), 'user_01TEST%3A%3A' + jwt)
    assert.equal(formatCursorCents(1575), '$15.75')
  })

  it('parseCursorUsage alone matches the captured dashboard payload', () => {
    const usage = parseCursorUsage(periodFixture, Date.parse('2026-07-15T12:00:00Z'), {
      hardLimit: 50,
    })
    assert.equal(usage.provider, 'cursor')
    assert.equal(usage.windows[0]?.id, 'plan')
  })

  it('returns unavailable without a session', async () => {
    const result = await fetchCursorPlanUsage(null)
    assert.equal(result.status, 'unavailable')
  })
})

describe('getPlanUsageSnapshot', () => {
  it('never throws when providers fail hard', async () => {
    const boom: FetchLike = async () => {
      throw new Error('network down')
    }
    const snap = await getPlanUsageSnapshot(
      {
        claudeOAuthToken: 'sk-ant-oat01-x',
        codex: { accessToken: 'tok' },
        huggingfaceToken: 'hf_x',
        cursorSessionToken: 'user_01::jwt',
      },
      { fetch: boom },
    )
    assert.equal(snap.providers.length, 4)
    assert.ok(snap.providers.every((p) => p.status === 'error'))
  })

  it('reports unavailable when no credentials are supplied', async () => {
    const snap = await getPlanUsageSnapshot({})
    assert.equal(snap.providers.length, 4)
    assert.ok(snap.providers.every((p) => p.status === 'unavailable'))
  })
})
