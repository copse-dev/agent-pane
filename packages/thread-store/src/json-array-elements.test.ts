import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { jsonArrayElements } from './json-array-elements.ts'

/**
 * Parse a JSON array the way the history loader does: split it, then parse
 * every element on its own. Null when either step fails, or anything but
 * whitespace follows the array.
 */
function parseBySlices(text: string): unknown[] | null {
  const bytes = Buffer.from(text)
  const open = bytes.indexOf('[')
  if (open < 0 || bytes.subarray(0, open).toString().trim() !== '') return null
  const array = jsonArrayElements(bytes, open)
  if (array === null || bytes.subarray(array.end).toString().trim() !== '') return null
  const values: unknown[] = []
  for (const [start, end] of array.elements) {
    try {
      values.push(JSON.parse(bytes.toString('utf8', start, end)))
    } catch {
      return null
    }
  }
  return values
}

/** One `JSON.parse` of the same bytes, decoded whole as the old loader did. */
function parseWhole(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(text).toString('utf8'))
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

const PIECES = ['"', '\\', '\\"', '\\\\', '{', '}', '[', ']', ',', ':', ' ', 'a', 'é', '🌲', '\n']

function randomString(next: () => number): string {
  let text = ''
  const length = Math.floor(next() * 8)
  for (let index = 0; index < length; index++) {
    text += PIECES[Math.floor(next() * PIECES.length)] ?? ''
  }
  return text
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 3 ? 4 : 6))
  if (pick === 0) return randomString(next)
  if (pick === 1) return Math.floor(next() * 1000) / 7
  if (pick === 2) return next() < 0.5
  if (pick === 3) return null
  if (pick === 4) {
    return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1))
  }
  const value: Record<string, unknown> = {}
  for (let index = 0; index < Math.floor(next() * 4); index++) {
    value[randomString(next)] = randomValue(next, depth + 1)
  }
  return value
}

describe('jsonArrayElements', () => {
  it('splits only at top-level commas, skipping strings and nested values', () => {
    const tricky = [
      'a,b]c',
      'quote " inside',
      'backslash at end \\',
      'many \\\\" slashes',
      { nested: ['x,y', { deeper: '}]' }], 'k,]': 1 },
      [[], {}, [[]]],
      '🌲 é “smart” \u0000 \ud800',
      123.5e-3,
      null,
      true,
    ]
    const text = JSON.stringify(tricky)
    assert.deepEqual(parseBySlices(text), JSON.parse(text))
    assert.equal(jsonArrayElements(Buffer.from(text), 0)?.elements.length, tricky.length)
  })

  it('treats an empty array as no elements and rejects a missing one', () => {
    assert.deepEqual(jsonArrayElements(Buffer.from('[]'), 0)?.elements, [])
    assert.deepEqual(jsonArrayElements(Buffer.from('[ \n ]'), 0)?.elements, [])
    assert.equal(parseBySlices('[,]'), null)
    assert.equal(parseBySlices('[1,]'), null)
    assert.equal(parseBySlices('[,1]'), null)
  })

  it('reports where the array ends and fails on one that never closes', () => {
    assert.equal(jsonArrayElements(Buffer.from('{"a":[1,2]}'), 5)?.end, 10)
    assert.equal(jsonArrayElements(Buffer.from('[1,2'), 0), null)
    assert.equal(jsonArrayElements(Buffer.from('["open string]'), 0), null)
    assert.equal(jsonArrayElements(Buffer.from('[1}'), 0), null)
    assert.equal(jsonArrayElements(Buffer.from('x[1]'), 0), null)
  })

  it('agrees with one JSON.parse on random arrays and on random corruptions of them', () => {
    const next = random(42)
    for (let round = 0; round < 2_000; round++) {
      const values = Array.from({ length: Math.floor(next() * 6) }, () => randomValue(next, 0))
      const text = next() < 0.5 ? JSON.stringify(values) : JSON.stringify(values, null, 2)
      assert.deepEqual(parseBySlices(text), JSON.parse(text), text)
      // Drop, duplicate or swap in one character: wherever the whole parse
      // fails the split one must too, and wherever it succeeds they agree.
      const at = Math.floor(next() * text.length)
      const insert = PIECES[Math.floor(next() * PIECES.length)] ?? ''
      for (const corrupted of [
        text.slice(0, at) + text.slice(at + 1),
        text.slice(0, at) + insert + text.slice(at),
        text.slice(0, at) + insert + text.slice(at + 1),
      ]) {
        assert.deepEqual(parseBySlices(corrupted), parseWhole(corrupted), corrupted)
      }
    }
  })
})
