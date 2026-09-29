import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertNever } from './assert-never.ts'

describe('assertNever', () => {
  it('includes the context and unexpected value in its runtime failure', () => {
    assert.throws(
      () => Reflect.apply(assertNever, undefined, [{ kind: 'future' }, 'format result']),
      /format result: unhandled value \{"kind":"future"\}/,
    )
  })
})
