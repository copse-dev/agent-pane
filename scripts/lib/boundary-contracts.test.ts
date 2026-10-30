import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyWaivers,
  classifyExpectedFailure,
  classifyFailure,
  ContractTimeout,
  ContractViolation,
  createRedactor,
  effectiveStatus,
  exitCodeFor,
  MAX_WAIVER_DAYS,
  renderAnnotations,
  renderMarkdown,
  staleWaivers,
  validateWaivers,
  type ContractResult,
  type Waiver,
} from './boundary-contracts.mts'

const NOW = new Date('2026-10-30T12:00:00Z')
const ISSUE = 'https://github.com/copse-dev/agent-pane/issues/1370'
const MATRIX = new Map([
  ['anthropic', ['generation', 'invalid-key']],
  ['github', ['rest-read']],
])

function withStatus(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status })
}

function result(overrides: Partial<ContractResult>): ContractResult {
  return {
    target: 'anthropic',
    contract: 'generation',
    outcome: 'pass',
    detail: 'ok',
    durationMs: 1200,
    ...overrides,
  }
}

function waiver(overrides: Partial<Waiver>): Waiver {
  return {
    target: 'anthropic',
    contract: 'generation',
    issue: ISSUE,
    reason: 'vendor incident under investigation',
    expires: '2026-11-10',
    ...overrides,
  }
}

describe('classifyFailure', () => {
  it('separates a product regression from third-party trouble', () => {
    assert.equal(classifyFailure(new ContractViolation('shape changed')).outcome, 'regression')
    assert.equal(classifyFailure(withStatus(401)).outcome, 'regression')
    assert.equal(classifyFailure(withStatus(404)).outcome, 'regression')
    assert.equal(classifyFailure(new Error('no status at all')).outcome, 'regression')

    assert.equal(classifyFailure(withStatus(429)).outcome, 'rate-limited')
    assert.equal(classifyFailure(withStatus(500)).outcome, 'outage')
    assert.equal(classifyFailure(withStatus(529)).outcome, 'outage')
    assert.equal(classifyFailure(withStatus(408)).outcome, 'outage')
    assert.equal(classifyFailure(new ContractTimeout('slow')).outcome, 'outage')
  })

  it('treats transport failures as outages, including ones only visible in the cause', () => {
    assert.equal(classifyFailure(new TypeError('fetch failed')).outcome, 'outage')
    const wrapped = new Error('request failed', { cause: new Error('read ECONNRESET') })
    assert.equal(classifyFailure(wrapped).outcome, 'outage')
    const sdk = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })
    assert.equal(classifyFailure(sdk).outcome, 'outage')
  })
})

describe('effectiveStatus', () => {
  it("reads GitHub's 403 rate-limit shapes as 429", () => {
    assert.equal(effectiveStatus(403, new Headers({ 'x-ratelimit-remaining': '0' })), 429)
    assert.equal(effectiveStatus(403, new Headers({ 'retry-after': '60' })), 429)
    assert.equal(effectiveStatus(403, new Headers({ 'x-ratelimit-remaining': '12' })), 403)
    assert.equal(effectiveStatus(401, new Headers({ 'x-ratelimit-remaining': '0' })), 401)
  })
})

describe('classifyExpectedFailure', () => {
  it('passes only the statuses the product handles for the degraded case', () => {
    assert.equal(classifyExpectedFailure(401, [401, 403], 'invalid key').outcome, 'pass')
    assert.equal(classifyExpectedFailure(400, [401, 403], 'invalid key').outcome, 'regression')
    assert.equal(classifyExpectedFailure(undefined, [401], 'invalid key').outcome, 'regression')
    assert.equal(classifyExpectedFailure(429, [401], 'invalid key').outcome, 'rate-limited')
    assert.equal(classifyExpectedFailure(503, [401], 'invalid key').outcome, 'outage')
  })
})

describe('waivers', () => {
  it('accepts a live waiver for a known contract', () => {
    assert.deepEqual(validateWaivers([waiver({})], MATRIX, NOW), [])
    assert.deepEqual(validateWaivers([waiver({ contract: '*' })], MATRIX, NOW), [])
  })

  it('reports unknown, expired and over-long waivers as regressions', () => {
    const problems = validateWaivers(
      [
        waiver({ target: 'nope' }),
        waiver({ contract: 'nope' }),
        waiver({ expires: '2026-10-29' }),
        waiver({ expires: '2027-06-01' }),
      ],
      MATRIX,
      NOW,
    )
    assert.equal(problems.length, 4)
    assert.ok(problems.every((p) => p.outcome === 'regression'))
    assert.match(problems[0]?.detail ?? '', /unknown target/)
    assert.match(problems[1]?.detail ?? '', /unknown contract/)
    assert.match(problems[2]?.detail ?? '', /expired on 2026-10-29/)
    assert.match(problems[3]?.detail ?? '', new RegExp(`more than ${String(MAX_WAIVER_DAYS)} days`))
  })

  it('a waiver expiring today still applies; the day after it does not', () => {
    const failing = [result({ outcome: 'regression', detail: 'HTTP 400' })]
    const today = applyWaivers(failing, [waiver({ expires: '2026-10-30' })], NOW)
    assert.equal(today[0]?.outcome, 'waived')
    assert.match(today[0]?.detail ?? '', /regression waived until 2026-10-30/)
    const tomorrow = new Date('2026-10-31T00:00:01Z')
    assert.equal(
      applyWaivers(failing, [waiver({ expires: '2026-10-30' })], tomorrow)[0]?.outcome,
      'regression',
    )
  })

  it('waives outages and wildcards, but never rewrites a pass or a skip', () => {
    const results = [
      result({ outcome: 'outage' }),
      result({ contract: 'invalid-key', outcome: 'pass' }),
      result({ target: 'github', contract: 'rest-read', outcome: 'skipped' }),
    ]
    const applied = applyWaivers(results, [waiver({ contract: '*' })], NOW)
    assert.deepEqual(
      applied.map((r) => r.outcome),
      ['waived', 'pass', 'skipped'],
    )
  })

  it('lists live waivers whose contracts all pass, so they get deleted', () => {
    const passing = [result({}), result({ contract: 'invalid-key' })]
    assert.equal(staleWaivers(passing, [waiver({ contract: '*' })], NOW).length, 1)
    assert.equal(
      staleWaivers([result({ outcome: 'outage' })], [waiver({})], NOW).length,
      0,
      'a waiver still covering a failure is not stale',
    )
  })
})

describe('createRedactor', () => {
  it('removes literal secret values and credential-shaped tokens', () => {
    const redact = createRedactor(['sk-ant-api03-REALSECRETVALUE1234567890', ''])
    const out = redact(
      'key sk-ant-api03-REALSECRETVALUE1234567890 rejected; token ghp_0123456789abcdefghijABCDEFGHIJ012345',
    )
    assert.doesNotMatch(out, /REALSECRETVALUE/)
    assert.doesNotMatch(out, /ghp_0123456789/)
    assert.match(out, /REDACTED/)
  })
})

describe('reporting', () => {
  it('fails the run only on a regression', () => {
    assert.equal(exitCodeFor([result({ outcome: 'outage' }), result({ outcome: 'waived' })]), 0)
    assert.equal(
      exitCodeFor([result({ outcome: 'rate-limited' }), result({ outcome: 'skipped' })]),
      0,
    )
    assert.equal(exitCodeFor([result({ outcome: 'regression' })]), 1)
  })

  it('annotates regressions as errors and vendor trouble as warnings, escaping newlines', () => {
    const lines = renderAnnotations([
      result({ outcome: 'regression', detail: 'line one\nline two 100%' }),
      result({ contract: 'invalid-key', outcome: 'outage' }),
      result({ contract: 'x', outcome: 'pass' }),
    ])
    assert.equal(lines.length, 2)
    assert.match(lines[0] ?? '', /^::error title=[^:]+::line one%0Aline two 100%25$/)
    assert.match(lines[1] ?? '', /^::warning /)
  })

  it('renders a summary table that survives pipes in details and names stale waivers', () => {
    const md = renderMarkdown({
      startedAt: '2026-10-30T12:00:00.000Z',
      finishedAt: '2026-10-30T12:01:00.000Z',
      sha: '0123456789abcdef',
      runUrl: 'https://github.com/copse-dev/agent-pane/actions/runs/1',
      results: [result({ detail: 'a | b' })],
      staleWaivers: [waiver({})],
    })
    assert.match(md, /\| PASS \| anthropic \| generation \| 1\.2s \| a \\\| b \|/)
    assert.match(md, /at `0123456789ab`/)
    assert.match(md, /delete them/)
    assert.match(md, /- anthropic\/generation/)
  })
})
