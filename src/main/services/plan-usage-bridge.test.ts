import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { discoverPlanUsageCredentials, loadPlanUsageSnapshot } from './plan-usage-bridge.ts'

describe('discoverPlanUsageCredentials', () => {
  it('reads Claude and Codex credential files under a fake home', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test' } }),
    )
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'codex-tok', account_id: 'acct' } }),
    )

    const creds = discoverPlanUsageCredentials(home, {})
    assert.equal(creds.claudeOAuthToken, 'sk-ant-oat01-test')
    assert.ok(creds.codex)
    assert.equal(creds.codex.accessToken, 'codex-tok')
    assert.equal(creds.codex.accountId, 'acct')
  })

  it('prefers credentials file over CLAUDE_CODE_OAUTH_TOKEN (setup-token lacks user:profile)', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }),
    )
    const creds = discoverPlanUsageCredentials(home, {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env',
    })
    assert.equal(creds.claudeOAuthToken, 'sk-ant-oat01-file')
  })

  it('returns empty credentials when nothing is present', () => {
    const home = mkdtempSync(join(tmpdir(), 'copse-plan-usage-empty-'))
    const creds = discoverPlanUsageCredentials(home, {})
    assert.equal(creds.claudeOAuthToken, undefined)
    assert.equal(creds.codex, undefined)
  })
})

describe('loadPlanUsageSnapshot', () => {
  it('returns the mock fixture when COPSE_PLAN_USAGE_MOCK=1', async () => {
    const prev = process.env['COPSE_PLAN_USAGE_MOCK']
    process.env['COPSE_PLAN_USAGE_MOCK'] = '1'
    try {
      const snap = await loadPlanUsageSnapshot()
      assert.equal(snap.providers.length, 2)
      assert.ok(snap.providers.every((p) => p.status === 'ok'))
    } finally {
      if (prev === undefined) delete process.env['COPSE_PLAN_USAGE_MOCK']
      else process.env['COPSE_PLAN_USAGE_MOCK'] = prev
    }
  })
})
