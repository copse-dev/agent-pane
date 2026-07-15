import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readXtermScrollback } from './xterm-scrollback.ts'

describe('readXtermScrollback', () => {
  it('joins the last N buffer lines', () => {
    const rows = ['one', 'two', 'three', 'four']
    const term = {
      buffer: {
        active: {
          length: rows.length,
          getLine(i: number): { translateToString: () => string } | undefined {
            const text = rows[i]
            return text === undefined ? undefined : { translateToString: (): string => text }
          },
        },
      },
    }
    assert.equal(readXtermScrollback(term, 2), 'three\nfour')
    assert.equal(readXtermScrollback(term, 10), 'one\ntwo\nthree\nfour')
  })
})
