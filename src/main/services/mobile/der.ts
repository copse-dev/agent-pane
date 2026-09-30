// DER encoding helpers for the fixed-shape certificates in mobile-certificate.ts.
// No untrusted ASN.1 is decoded or re-encoded here.
export function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts)
  const length =
    value.length < 128
      ? Buffer.from([value.length])
      : value.length < 256
        ? Buffer.from([0x81, value.length])
        : Buffer.from([0x82, value.length >> 8, value.length & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, value])
}

/**
 * DER INTEGER for a non-negative big-endian magnitude. DER requires the minimal
 * encoding: redundant leading zero octets are dropped, and a single 0x00 is
 * added only when the high bit would otherwise make the value negative. A random
 * serial whose first octet is 0x00 is otherwise rejected by OpenSSL as illegal
 * padding.
 */
export function derInteger(magnitude: Buffer): Buffer {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++
  const value = magnitude.subarray(start)
  const needsSignPad = ((value[0] ?? 0) & 0x80) !== 0
  return der(0x02, ...(needsSignPad ? [Buffer.from([0])] : []), value)
}
