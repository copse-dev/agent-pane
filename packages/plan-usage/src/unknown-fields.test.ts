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

  it('flags unknown top-level keys and unknown limit kinds', () => {
    const findings = findUnknownFields(
      {
        five_hour: { utilization: 1, resets_at: 'x' },
        brand_new_bucket: { utilization: 9 },
        limits: [{ kind: 'monthly_mythos', percent: 1 }],
      },
      CLAUDE_USAGE_SCHEMA,
    )
    assert.ok(findings.some((f) => f.path === 'brand_new_bucket' && f.kind === 'unknown_key'))
    assert.ok(findings.some((f) => f.path === 'limits[0].kind' && f.kind === 'unknown_enum'))
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
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_at: 1_784_000_000,
          },
          secondary_window: {
            used_percent: 5,
            limit_window_seconds: 604_800,
            reset_at: 1_784_500_000,
          },
          credits: { has_credits: false, unlimited: false, balance: '0' },
        },
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
