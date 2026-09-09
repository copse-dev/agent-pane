import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { decodeWorkerPhase, encodeWorkerPhase } from './worker-events.ts'

describe('worker phase protocol', () => {
  it('decodes progress independently of diagnostic wording', () => {
    for (const phase of ['installing', 'running', 'collecting'] as const) {
      assert.equal(decodeWorkerPhase(encodeWorkerPhase(phase).trimEnd()), phase)
    }
    for (const log of [
      '[worker] installing dependencies',
      '[worker] done: completed',
      'wall-clock budget reached',
    ]) {
      assert.equal(decodeWorkerPhase(log), null)
    }
  })
  it('does not accept terminal state, malformed JSON or oversized records', () => {
    for (const value of [
      '\u001eCOPSE:{"type":"phase","phase":"finished"}',
      '\u001eCOPSE:{',
      '\u001eCOPSE:{"type":"log","phase":"running"}',
      '\u001eCOPSE:' + 'x'.repeat(129),
    ])
      assert.equal(decodeWorkerPhase(value), null)
  })
  it('survives arbitrary pipe chunk boundaries with interleaved diagnostics', async () => {
    const input = new PassThrough()
    const lines = createInterface({ input })
    const phases: string[] = []
    const done = new Promise<void>((resolve) => lines.once('close', resolve))
    lines.on('line', (line) => {
      const phase = decodeWorkerPhase(line)
      if (phase) phases.push(phase)
    })
    const wire =
      'some log\n' +
      encodeWorkerPhase('installing') +
      'different wording\n' +
      encodeWorkerPhase('running')
    for (const byte of Buffer.from(wire)) input.write(Buffer.from([byte]))
    input.end()
    await done
    assert.deepEqual(phases, ['installing', 'running'])
  })
})
