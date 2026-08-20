import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  splitCursorAcpTransportNoise,
  stripCursorAcpTransportNoise,
} from './acp-cursor-transport-noise.ts'

describe('splitCursorAcpTransportNoise', () => {
  it('splits a trailing WritableIterable RetriableError from a useful answer', () => {
    const text = [
      'https://github.com/copse-dev/agent-pane/pull/1818',
      '',
      'Error: RetriableError: WritableIterable is closed',
    ].join('\n')
    const { body, noise } = splitCursorAcpTransportNoise(text)
    assert.equal(body, 'https://github.com/copse-dev/agent-pane/pull/1818')
    assert.equal(noise, 'Error: RetriableError: WritableIterable is closed')
  })

  it('splits a trailing http/2 CANCEL RetriableError', () => {
    const text =
      'Browser tab is open.\n\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'
    const { body, noise } = splitCursorAcpTransportNoise(text)
    assert.equal(body, 'Browser tab is open.')
    assert.match(noise ?? '', /http\/2 stream closed/)
  })

  it('strips multiple trailing RetriableError lines', () => {
    const text = [
      'Done.',
      '',
      'Error: RetriableError: WritableIterable is closed',
      'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)',
    ].join('\n')
    const { body, noise } = splitCursorAcpTransportNoise(text)
    assert.equal(body, 'Done.')
    assert.match(noise ?? '', /WritableIterable/)
    assert.match(noise ?? '', /http\/2/)
  })

  it('leaves an error-only message intact', () => {
    const text = 'Error: RetriableError: WritableIterable is closed'
    assert.deepEqual(splitCursorAcpTransportNoise(text), { body: text, noise: null })
  })

  it('does not strip a mid-message RetriableError line', () => {
    const text = [
      'Saw Error: RetriableError: WritableIterable is closed while debugging.',
      '',
      'Fix applied.',
    ].join('\n')
    assert.deepEqual(splitCursorAcpTransportNoise(text), { body: text, noise: null })
  })

  it('does not strip Copse classifyAgentError wording', () => {
    const text = 'Answer.\n\nAn error occurred: RetriableError: WritableIterable is closed'
    assert.deepEqual(splitCursorAcpTransportNoise(text), { body: text, noise: null })
  })
})

describe('stripCursorAcpTransportNoise', () => {
  it('returns the primary body for history replay', () => {
    assert.equal(
      stripCursorAcpTransportNoise(
        'PR opened.\n\nError: RetriableError: WritableIterable is closed',
      ),
      'PR opened.',
    )
  })
})
