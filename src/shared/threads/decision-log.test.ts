import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_LOG_CONFORMANCE,
  DECISION_LOG_MEDIA_TYPE,
  DECISION_LOG_SCHEMA_VERSION,
  decisionLogManifest,
  makeDecisionEvent,
  parseDecisionLine,
  parseDecisionLog,
  redactSecrets,
  serializeDecisionLine,
  serializeDecisionLog,
  type DecisionInput,
} from './decision-log.ts'

const baseInput: DecisionInput = {
  kind: 'shell',
  actor: 'user',
  verdict: 'approved',
  subject: 'echo hi',
}

describe('decision-log schema', () => {
  it('stamps v/type/id/at and preserves fields', () => {
    const e = makeDecisionEvent(
      { ...baseInput, scope: 'sandbox', remembered: true, threadId: 't1' },
      'id-1',
      1234,
    )
    assert.equal(e.v, DECISION_LOG_SCHEMA_VERSION)
    assert.equal(e.type, 'decision')
    assert.equal(e.id, 'id-1')
    assert.equal(e.at, 1234)
    assert.equal(e.kind, 'shell')
    assert.equal(e.actor, 'user')
    assert.equal(e.verdict, 'approved')
    assert.equal(e.subject, 'echo hi')
    assert.equal(e.scope, 'sandbox')
    assert.equal(e.remembered, true)
    assert.equal(e.threadId, 't1')
  })

  it('omits absent optional fields (no undefined keys)', () => {
    const e = makeDecisionEvent(baseInput, 'id', 1)
    assert.deepEqual(
      Object.keys(e).sort(),
      ['actor', 'at', 'id', 'kind', 'subject', 'type', 'v', 'verdict'].sort(),
    )
  })

  it('drops an empty reasons array', () => {
    const e = makeDecisionEvent({ ...baseInput, reasons: [] }, 'id', 1)
    assert.equal('reasons' in e, false)
  })

  it('round-trips through serialize/parse', () => {
    const e = makeDecisionEvent(
      { ...baseInput, actor: 'classifier', verdict: 'blocked', scope: 'external', confidence: 0.9 },
      'id-2',
      99,
    )
    const parsed = parseDecisionLine(serializeDecisionLine(e))
    assert.deepEqual(parsed, e)
  })

  it('parseDecisionLine rejects malformed / non-decision lines', () => {
    assert.equal(parseDecisionLine('not json'), null)
    assert.equal(parseDecisionLine('{"type":"message","id":"x"}'), null)
    assert.equal(parseDecisionLine('{"type":"decision"}'), null) // no id/kind
    assert.equal(parseDecisionLine('null'), null)
  })

  it('parseDecisionLog skips blank and malformed lines', () => {
    const good = serializeDecisionLine(makeDecisionEvent(baseInput, 'a', 1))
    const raw = ['', good, 'garbage', '   ', good].join('\n')
    const events = parseDecisionLog(raw)
    assert.equal(events.length, 2)
  })

  it('serializeDecisionLog produces one line per event with a trailing newline', () => {
    const events = [makeDecisionEvent(baseInput, 'a', 1), makeDecisionEvent(baseInput, 'b', 2)]
    const body = serializeDecisionLog(events)
    assert.equal(body.endsWith('\n'), true)
    assert.equal(body.trim().split('\n').length, 2)
    assert.deepEqual(parseDecisionLog(body), events)
  })

  it('serializeDecisionLog of an empty list is the empty string', () => {
    assert.equal(serializeDecisionLog([]), '')
  })

  it('manifest declares media type, version, and conformance target', () => {
    const m = decisionLogManifest(3, 42)
    assert.equal(m.type, 'decision-log-manifest')
    assert.equal(m.mediaType, DECISION_LOG_MEDIA_TYPE)
    assert.equal(m.schemaVersion, DECISION_LOG_SCHEMA_VERSION)
    assert.equal(m.conformance, DECISION_LOG_CONFORMANCE)
    assert.equal(m.count, 3)
    assert.equal(m.exportedAt, 42)
  })
})

describe('redactSecrets', () => {
  it('redacts secret-ish env assignments in a command', () => {
    const out = redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr view')
    assert.equal(out.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), false)
    assert.equal(out.includes('<redacted>'), true)
    assert.equal(out.includes('gh pr view'), true)
  })

  it('redacts secret command flags', () => {
    const out = redactSecrets('mysql --password hunter2 --host db')
    assert.equal(out.includes('hunter2'), false)
    assert.equal(out.includes('--host db'), true)
  })

  it('redacts --token=value form', () => {
    assert.equal(redactSecrets('deploy --token=SEKRET123456').includes('SEKRET123456'), false)
  })

  it('redacts known provider token shapes anywhere', () => {
    assert.equal(
      redactSecrets('curl -H x sk-ABCDEFGHIJKLMNOP1234').includes('sk-ABCDEFGHIJKLMNOP1234'),
      false,
    )
  })

  it('redacts Bearer header values', () => {
    const out = redactSecrets('curl -H "Authorization: Bearer abcdef123456789"')
    assert.equal(out.includes('abcdef123456789'), false)
  })

  it('redacts url userinfo credentials', () => {
    const out = redactSecrets('git clone https://user:s3cr3t@example.com/repo.git')
    assert.equal(out.includes('s3cr3t'), false)
    assert.equal(out.includes('example.com/repo.git'), true)
  })

  it('leaves an ordinary command untouched', () => {
    const cmd = 'npm run build && ls -la src/'
    assert.equal(redactSecrets(cmd), cmd)
  })

  it('applies redaction through makeDecisionEvent', () => {
    const e = makeDecisionEvent(
      { ...baseInput, subject: 'export API_KEY=sk-verysecretvalue123 && run' },
      'id',
      1,
    )
    assert.equal(e.subject.includes('sk-verysecretvalue123'), false)
  })

  it('clamps an overly long subject', () => {
    const e = makeDecisionEvent({ ...baseInput, subject: 'x'.repeat(9000) }, 'id', 1)
    assert.ok(e.subject.length <= 4001)
    assert.equal(e.subject.endsWith('…'), true)
  })
})
