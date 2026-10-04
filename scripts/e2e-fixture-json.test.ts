import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseFixtureJsonObject } from '../tests/e2e/helpers/fixture-json.ts'

describe('fixture JSON boundaries', () => {
  it('retains unknown fields for explicit decoding by the caller', () => {
    assert.deepEqual(parseFixtureJsonObject('{"id":"thread","nested":{"future":true}}'), {
      id: 'thread',
      nested: { future: true },
    })
  })
  it('rejects malformed and non-object JSON with the fixture context', () => {
    for (const input of ['{', 'null', '[]', '3', '"object"']) {
      assert.throws(
        () => parseFixtureJsonObject(input, 'run config'),
        /run config must contain a JSON object/,
      )
    }
  })
})
