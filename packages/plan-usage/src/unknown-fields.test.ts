import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLAUDE_USAGE_SCHEMA, CODEX_USAGE_SCHEMA, findUnknownFields } from './unknown-fields.ts'

describe('findUnknownFields (Claude)', () => {
  it('accepts a modern limits[] payload with Fable', () => {
    const findings = findUnknownFields(
      {
        five_hour: null,
        seven_day: null,
        seven_day_opus: null,
        limits: [
          { kind: 'session', percent: 10, resets_at: '2026-07-15T12:00:00Z' },
          { kind: 'weekly_all', percent: 20, resets_at: '2026-07-20T12:00:00Z' },
          {
            kind: 'weekly_scoped',
            percent: 30,
            scope: { model: { display_name: 'Fable' } },
          },
        ],
        extra_usage: {
          is_enabled: false,
          monthly_limit: null,
          used_credits: null,
          utilization: null,
        },
      },
      CLAUDE_USAGE_SCHEMA,
    )
    assert.deepEqual(findings, [])
  })

  it('accepts dollar fields, codename buckets, and limits metadata from Max probe', () => {
    const findings = findUnknownFields(
      {
        five_hour: {
          utilization: null,
          resets_at: '2026-07-15T12:00:00Z',
          limit_dollars: 20,
          used_dollars: 4,
          remaining_dollars: 16,
        },
        seven_day: {
          utilization: 99,
          resets_at: '2026-07-17T02:00:00.200Z',
          limit_dollars: 100,
          used_dollars: 99,
          remaining_dollars: 1,
        },
        tangelo: null,
        omelette_promotional: null,
        nimbus_quill: null,
        cinder_cove: null,
        amber_ladder: null,
        extra_usage: {
          is_enabled: false,
          currency: 'USD',
          decimal_places: 2,
          disabled_reason: null,
          daily: null,
          weekly: null,
        },
        spend: { something: true },
        member_dashboard_available: true,
        limits: [
          {
            kind: 'weekly_all',
            percent: 99,
            group: 'weekly',
            cardinality: 'all',
            resets_at: '2026-07-17T02:00:00.200Z',
          },
          {
            kind: 'weekly_scoped',
            percent: 10,
            group: 'weekly',
            cardinality: 'scoped',
            scope: { model: { display_name: 'Fable' }, surface: 'claude_code' },
          },
        ],
      },
      CLAUDE_USAGE_SCHEMA,
    )
    assert.deepEqual(findings, [])
  })

  it('flags unknown top-level keys and unknown limit kinds', () => {
    const findings = findUnknownFields(
      {
        five_hour: { utilization: 1, resets_at: 'x' },
        brand_new_bucket: { utilization: 9, resets_at: 'y' },
        limits: [{ kind: 'monthly_mythos', percent: 1 }],
      },
      CLAUDE_USAGE_SCHEMA,
    )
    assert.ok(findings.some((f) => f.path === 'brand_new_bucket' && f.kind === 'unknown_key'))
    assert.ok(findings.some((f) => f.path === 'limits[0].kind' && f.kind === 'unknown_enum'))
    const bucket = findings.find((f) => f.path === 'brand_new_bucket')
    assert.ok(bucket)
    assert.match(bucket.sample ?? '', /utilization/)
  })

  it('includes a JSON sample for opaque unknown keys', () => {
    const findings = findUnknownFields(
      {
        tangelo_mystery: {
          utilization: 12,
          limit_dollars: 40,
          used_dollars: 4.8,
          remaining_dollars: 35.2,
          resets_at: '2026-07-20T00:00:00Z',
        },
      },
      CLAUDE_USAGE_SCHEMA,
    )
    const hit = findings.find((f) => f.path === 'tangelo_mystery')
    assert.ok(hit)
    assert.equal(hit.kind, 'unknown_key')
    assert.ok(hit.sample)
    assert.match(hit.sample, /limit_dollars/)
    assert.match(hit.sample, /4\.8/)
  })

  it('flags unknown nested model fields (how Fable would have shown up early)', () => {
    const findings = findUnknownFields(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            percent: 1,
            scope: { model: { display_name: 'Fable', family: 'claude-5' } },
          },
        ],
      },
      CLAUDE_USAGE_SCHEMA,
    )
    assert.ok(
      findings.some((f) => f.path === 'limits[0].scope.model.family' && f.kind === 'unknown_key'),
    )
  })
})

describe('findUnknownFields (Codex)', () => {
  it('accepts a typical wham/usage payload', () => {
    const findings = findUnknownFields(
      {
        user_id: 'u',
        account_id: 'a',
        email: 'x@y.z',
        plan_type: 'prolite',
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 604_800,
            reset_at: 1_784_000_000,
            reset_after_seconds: 99,
          },
          credits: {
            has_credits: false,
            unlimited: false,
            balance: '0',
            overage_limit_reached: false,
            approx_local_messages: 0,
            approx_cloud_messages: 0,
          },
        },
        additional_rate_limits: [
          {
            metered_feature: 'codex_spark',
            rate_limit: {
              primary_window: {
                used_percent: 1,
                limit_window_seconds: 18_000,
                reset_at: 1,
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
        spend_control: null,
        promo: null,
        rate_limit_reset_credits: null,
      },
      CODEX_USAGE_SCHEMA,
    )
    assert.deepEqual(findings, [])
  })

  it('flags unknown window fields', () => {
    const findings = findUnknownFields(
      {
        rate_limit: {
          primary_window: { used_percent: 1, spark_bonus: true },
        },
      },
      CODEX_USAGE_SCHEMA,
    )
    assert.ok(
      findings.some(
        (f) => f.path === 'rate_limit.primary_window.spark_bonus' && f.kind === 'unknown_key',
      ),
    )
  })
})
