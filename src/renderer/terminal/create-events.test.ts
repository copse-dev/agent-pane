import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TerminalCreateEvents } from './create-events.ts'

test('retains a bounded tail and ignores output after an early exit', () => {
  const events = new TerminalCreateEvents()
  const finish = events.begin()
  events.output('owned', 'old'.repeat(30_000))
  events.output('owned', 'last')
  events.exit('owned', 3)
  events.output('owned', 'after exit')
  assert.deepEqual(events.take('owned'), {
    output: ('old'.repeat(30_000) + 'last').slice(-65_536),
    exitCode: 3,
  })
  assert.equal(events.take('owned'), undefined)
  finish()
})

test('evicts old unmatched streams at the pane-wide session bound', () => {
  const events = new TerminalCreateEvents()
  const finish = events.begin()
  for (let index = 0; index < 1000; index += 1) events.output(String(index), 'data')
  const retained = Array.from({ length: 1000 }, (_, index) => events.take(String(index)))
  assert.equal(retained.filter((value) => value !== undefined).length, 16)
  assert.deepEqual(retained.at(-1), { output: 'data', exitCode: null })
  finish()
})

test('ends the handoff window after the last concurrent create finishes', () => {
  const events = new TerminalCreateEvents()
  events.output('before', 'discard')
  const first = events.begin()
  const second = events.begin()
  events.output('first', 'first')
  events.output('second', 'second')
  assert.deepEqual(events.take('first'), { output: 'first', exitCode: null })
  first()
  first()
  assert.deepEqual(events.take('second'), { output: 'second', exitCode: null })
  events.output('unmatched', 'discard')
  second()
  events.output('after', 'discard')
  const next = events.begin()
  for (const id of ['before', 'unmatched', 'after']) assert.equal(events.take(id), undefined)
  next()
})
