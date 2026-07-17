import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCheckupReport,
  formatCheckupReport,
  type CheckupCheck,
  type CheckupReport,
  type CheckupSnapshot,
} from './checkup-report.ts'

function baseSnapshot(overrides: Partial<CheckupSnapshot> = {}): CheckupSnapshot {
  return {
    version: '1.2.3',
    platform: 'linux',
    mockLlm: false,
    workspace: { root: '/repo', trusted: true },
    git: { available: true, branch: 'main' },
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic',
        configured: true,
        source: 'env',
        encrypted: null,
        local: false,
      },
    ],
    context: { hasDecentChatDefault: true, minimum: 200_000, bestAvailableContext: 200_000 },
    mcp: [],
    skills: { total: 3, bySource: { bundled: 2, project: 1 } },
    customTools: [],
    semantic: { available: true, backend: 'gortex', bundled: true },
    permissions: { autoRun: true, mcpAutoAllowReadOnly: false, trustedCommandCount: 2 },
    spawnHelperExecutable: true,
    ...overrides,
  }
}

/** Fetch a check by id, asserting it exists so callers get a non-nullable value. */
function getCheck(report: CheckupReport, id: string): CheckupCheck {
  const check = report.checks.find((c) => c.id === id)
  assert.ok(check, `expected a "${id}" check`)
  return check
}

function hasCheck(report: CheckupReport, id: string): boolean {
  return report.checks.some((c) => c.id === id)
}

describe('buildCheckupReport', () => {
  it('reports a healthy setup with no errors or warnings', () => {
    const report = buildCheckupReport(baseSnapshot())
    assert.equal(report.counts.error, 0)
    assert.equal(report.counts.warn, 0)
    assert.ok(report.counts.ok > 0)
    assert.equal(getCheck(report, 'providers').status, 'ok')
  })

  it('errors when no provider is configured and no model context is available', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            configured: false,
            source: null,
            encrypted: null,
            local: false,
          },
        ],
        context: { hasDecentChatDefault: false, minimum: 200_000, bestAvailableContext: null },
      }),
    )
    const providers = getCheck(report, 'providers')
    assert.equal(providers.status, 'error')
    assert.ok(providers.fix)
    assert.equal(report.counts.error, 1)
  })

  it('treats the mock LLM as a healthy provider', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        mockLlm: true,
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            configured: false,
            source: null,
            encrypted: null,
            local: false,
          },
        ],
        context: { hasDecentChatDefault: true, minimum: 200_000, bestAvailableContext: null },
      }),
    )
    assert.equal(getCheck(report, 'providers').status, 'ok')
    assert.equal(report.counts.error, 0)
  })

  it('warns when a stored key is saved as plaintext', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            configured: true,
            source: 'stored',
            encrypted: false,
            local: false,
          },
        ],
      }),
    )
    const warn = getCheck(report, 'key-plaintext-openai')
    assert.equal(warn.status, 'warn')
    assert.match(warn.detail, /plaintext/)
  })

  it('does not warn when a stored key is encrypted', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            configured: true,
            source: 'stored',
            encrypted: true,
            local: false,
          },
        ],
      }),
    )
    assert.equal(hasCheck(report, 'key-plaintext-openai'), false)
  })

  it('warns about a low context window when a real model is reachable', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        context: { hasDecentChatDefault: false, minimum: 200_000, bestAvailableContext: 8000 },
      }),
    )
    const ctx = getCheck(report, 'context')
    assert.equal(ctx.status, 'warn')
    assert.match(ctx.detail, /8K/)
  })

  it('surfaces a failed MCP server as an error with its message', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        mcp: [
          { name: 'gh', state: 'error', toolCount: 0, error: 'spawn failed' },
          { name: 'fs', state: 'connected', toolCount: 4 },
        ],
      }),
    )
    const err = getCheck(report, 'mcp-gh')
    assert.equal(err.status, 'error')
    assert.match(err.detail, /spawn failed/)
    assert.equal(getCheck(report, 'mcp-summary').status, 'ok')
  })

  it('warns about MCP servers blocked by workspace trust instead of reporting healthy', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        mcp: [{ name: 'proj', state: 'untrusted', toolCount: 0, error: 'workspace not trusted' }],
      }),
    )
    const blocked = getCheck(report, 'mcp-proj')
    assert.equal(blocked.status, 'warn')
    assert.match(blocked.detail, /not trusted/)
    // The summary must not read as healthy when nothing connected and one is blocked.
    const summary = getCheck(report, 'mcp-summary')
    assert.equal(summary.status, 'warn')
    assert.match(summary.detail, /blocked \(untrusted\)/)
  })

  it('warns when semantic search is unavailable', () => {
    const report = buildCheckupReport(
      baseSnapshot({ semantic: { available: false, backend: null, bundled: false } }),
    )
    assert.equal(getCheck(report, 'semantic').status, 'warn')
  })

  it('flags a non-executable spawn-helper as an error', () => {
    const report = buildCheckupReport(baseSnapshot({ spawnHelperExecutable: false }))
    const term = getCheck(report, 'terminal')
    assert.equal(term.status, 'error')
    assert.ok(term.fix)
  })

  it('omits the terminal check when the helper state is indeterminate', () => {
    const report = buildCheckupReport(baseSnapshot({ spawnHelperExecutable: null }))
    assert.equal(hasCheck(report, 'terminal'), false)
  })

  it('warns when no folder is open', () => {
    const report = buildCheckupReport(baseSnapshot({ workspace: { root: null, trusted: false } }))
    assert.equal(getCheck(report, 'workspace').status, 'warn')
  })
})

describe('formatCheckupReport', () => {
  it('renders a summary line and severity sections', () => {
    const report = buildCheckupReport(
      baseSnapshot({
        providers: [
          {
            id: 'anthropic',
            label: 'Anthropic',
            configured: false,
            source: null,
            encrypted: null,
            local: false,
          },
        ],
        context: { hasDecentChatDefault: false, minimum: 200_000, bestAvailableContext: null },
        semantic: { available: false, backend: null, bundled: false },
      }),
    )
    const text = formatCheckupReport(report)
    assert.match(text, /^Copse checkup — 1 error\(s\), 1 warning\(s\)/)
    assert.match(text, /\nERRORS\n/)
    assert.match(text, /\nWARNINGS\n/)
    assert.match(text, /\nHEALTHY\n/)
    // Errors/warnings carry a Fix line; healthy rows do not.
    assert.match(text, /Fix:/)
  })

  it('omits empty sections', () => {
    const text = formatCheckupReport(buildCheckupReport(baseSnapshot()))
    assert.doesNotMatch(text, /\nERRORS\n/)
    assert.doesNotMatch(text, /\nWARNINGS\n/)
    assert.match(text, /\nHEALTHY\n/)
  })
})
