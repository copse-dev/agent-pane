import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { derInteger, positiveSerial } from './der.ts'

const hex = (bytes: number[]): string => derInteger(Buffer.from(bytes)).toString('hex')

describe('derInteger', () => {
  it('encodes a minimal positive INTEGER', () => {
    assert.equal(hex([0x7f]), '02017f')
    assert.equal(hex([0x01, 0x02]), '02020102')
  })

  it('adds one sign octet only when the high bit is set', () => {
    assert.equal(hex([0x80]), '02020080')
    assert.equal(hex([0xff, 0x01]), '020300ff01')
  })

  it('drops redundant leading zero octets (a random serial starting 0x00)', () => {
    // 00 12 ... is padding; OpenSSL rejects it as ASN1 illegal padding.
    assert.equal(hex([0x00, 0x12, 0x34]), '02021234')
    assert.equal(hex([0x00, 0x00, 0x7f]), '02017f')
    // 00 80 needs its zero because 0x80 has the high bit set.
    assert.equal(hex([0x00, 0x80, 0x01]), '0203008001')
  })

  it('encodes zero as a single octet', () => {
    assert.equal(hex([0x00]), '020100')
    assert.equal(hex([0x00, 0x00]), '020100')
  })
})

describe('positiveSerial', () => {
  it('returns a nonzero draw unchanged', () => {
    const draw = Buffer.from([0x00, 0x01])
    assert.equal(
      positiveSerial(() => draw),
      draw,
    )
  })

  it('redraws an all-zero serial', () => {
    const draws = [Buffer.alloc(16), Buffer.alloc(16), Buffer.from([0x00, 0x00, 0x05])]
    let calls = 0
    const serial = positiveSerial(() => draws[calls++] ?? Buffer.alloc(16))
    assert.equal(serial.toString('hex'), '000005')
    assert.equal(calls, 3)
  })

  it('throws when the generator only ever returns zero', () => {
    assert.throws(() => positiveSerial(() => Buffer.alloc(16)), /only zero octets/)
  })
})
