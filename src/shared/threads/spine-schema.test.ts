import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPINE_SCHEMA_VERSION,
  hookRunBlobRefs,
  parseSpine,
  parseSpineEntries,
  parseSpineLine,
  rebuildSpinePreservingNonMessageLines,
  serializeSpine,
  serializeSpineEntries,
  serializeSpineLine,
  toolsetBlobRef,
  type SpineHookRunLine,
  type SpineMessageLine,
} from './spine-schema.ts'

function messageLine(id: string): SpineMessageLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'message',
    id,
    role: 'user',
    createdAt: 1,
    content: { ref: `messages/${id}.md`, sha256: 'abc' },
    toolCalls: [],
  }
}

function hookRunLine(id: string, overrides: Partial<SpineHookRunLine> = {}): SpineHookRunLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id,
    event: 'beforeShellExecution',
    hookId: './audit.sh',
    executor: 'command',
    turnId: 'turn-1',
    step: 2,
    startedAt: 100,
    durationMs: 40,
    exitCode: 0,
    parseOk: true,
    decision: { permission: 'allow' },
    stdout: { ref: `blobs/${id}.stdout.txt`, sha256: 'out' },
    stderr: { ref: `blobs/${id}.stderr.txt`, sha256: 'err' },
    ...overrides,
  }
}

describe('spine-schema hook_run union (decision 6)', () => {
  it('round-trips a hook_run line through serialize/parse', () => {
    const line = hookRunLine('h1', { toolset: 'ts-hash' })
    const parsed = parseSpineLine(serializeSpineLine(line))
    assert.deepEqual(parsed, line)
  })

  it('parseSpine skips hook_run lines — old readers stay forward-tolerant', () => {
    const body = serializeSpine([messageLine('m1'), hookRunLine('h1'), messageLine('m2')])
    const messages = parseSpine(body)
    assert.deepEqual(
      messages.map((m) => m.id),
      ['m1', 'm2'],
    )
  })

  it('parseSpineEntries preserves unknown line types verbatim', () => {
    const unknown = '{"v":1,"type":"future_thing","id":"f1","payload":{"x":1}}'
    const body = `${serializeSpineLine(messageLine('m1'))}\n${unknown}\n`
    const entries = parseSpineEntries(body)
    assert.equal(entries.length, 2)
    const second = entries[1]
    assert.ok(second)
    assert.equal(second.line, null)
    assert.equal(second.raw, unknown)
    assert.equal(serializeSpineEntries(entries), body)
  })

  it('hookRunBlobRefs collects stdout, stderr, and the toolset blob', () => {
    const refs = hookRunBlobRefs(hookRunLine('h1', { toolset: 'cafe01' }))
    assert.deepEqual(refs, ['blobs/h1.stdout.txt', 'blobs/h1.stderr.txt', toolsetBlobRef('cafe01')])
  })
})

describe('rebuildSpinePreservingNonMessageLines (decision 6 full-save round-trip)', () => {
  it('keeps hook_run lines anchored after their preceding message', () => {
    const m1 = messageLine('m1')
    const m2 = messageLine('m2')
    const h1 = hookRunLine('h1')
    const existing = serializeSpine([m1, h1, m2])
    const { body, preservedRefs } = rebuildSpinePreservingNonMessageLines(existing, [m1, m2])
    const entries = parseSpineEntries(body)
    assert.deepEqual(
      entries.map((e) => e.line?.id),
      ['m1', 'h1', 'm2'],
    )
    assert.deepEqual(preservedRefs, ['blobs/h1.stdout.txt', 'blobs/h1.stderr.txt'])
  })

  it('keeps lines that precede any message at the start', () => {
    const m1 = messageLine('m1')
    const h1 = hookRunLine('h1')
    const existing = serializeSpine([h1, m1])
    const { body } = rebuildSpinePreservingNonMessageLines(existing, [m1])
    assert.deepEqual(
      parseSpineEntries(body).map((e) => e.line?.id),
      ['h1', 'm1'],
    )
  })

  it('keeps lines whose anchor message was deleted (at the end, never dropped)', () => {
    const m1 = messageLine('m1')
    const m2 = messageLine('m2')
    const h1 = hookRunLine('h1')
    const existing = serializeSpine([m1, m2, h1])
    const { body } = rebuildSpinePreservingNonMessageLines(existing, [m1])
    assert.deepEqual(
      parseSpineEntries(body).map((e) => e.line?.id),
      ['m1', 'h1'],
    )
  })

  it('preserves unknown future line types verbatim through a full rewrite', () => {
    const m1 = messageLine('m1')
    const unknown = '{"v":9,"type":"future_thing","id":"f1"}'
    const existing = `${serializeSpineLine(m1)}\n${unknown}\n`
    const { body } = rebuildSpinePreservingNonMessageLines(existing, [m1])
    assert.ok(body.includes(unknown))
  })

  it('is a plain rewrite when no non-message lines exist', () => {
    const m1 = messageLine('m1')
    const { body, preservedRefs } = rebuildSpinePreservingNonMessageLines(serializeSpine([m1]), [
      m1,
    ])
    assert.equal(body, serializeSpine([m1]))
    assert.deepEqual(preservedRefs, [])
  })
})
