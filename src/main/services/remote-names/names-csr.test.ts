import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { certificateNameFor, createCertificateRequest } from './names-csr.ts'

interface Tlv {
  tag: number
  value: Buffer
  raw: Buffer
}

// A test-side DER reader, enough to walk the CSR the same way the names
// service's `checkCsr` does (remote-service names/src/x509.ts).
function read(bytes: Buffer, offset = 0): Tlv & { end: number } {
  const tag = bytes[offset] ?? -1
  let length = bytes[offset + 1] ?? 0
  let header = 2
  if (length & 0x80) {
    const count = length & 0x7f
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[offset + 2 + i] ?? 0)
    header += count
  }
  const end = offset + header + length
  return { tag, value: bytes.subarray(offset + header, end), raw: bytes.subarray(offset, end), end }
}

function children(tlv: Tlv): Tlv[] {
  const out: Tlv[] = []
  let offset = 0
  while (offset < tlv.value.length) {
    const child = read(tlv.value, offset)
    out.push(child)
    offset = child.end
  }
  return out
}

function only<T>(items: T[], index: number): T {
  const item = items[index]
  assert.ok(item !== undefined, `expected element ${String(index)}`)
  return item
}

describe('createCertificateRequest', () => {
  const label = 'abcdefgh2345'

  it('builds the one CSR shape the names service accepts', () => {
    const { csr, privateKeyPem } = createCertificateRequest(label)
    const outer = read(csr)
    assert.equal(outer.end, csr.length)
    const [info, algorithm, signature] = children(outer)
    assert.ok(info && algorithm && signature)
    const [version, subject, spki, attributes, ...extra] = children(info)
    assert.ok(version && subject && spki && attributes)
    assert.equal(extra.length, 0)
    assert.deepEqual([...version.raw], [0x02, 0x01, 0x00])
    assert.deepEqual([...subject.raw], [0x30, 0x00])
    assert.equal(attributes.tag, 0xa0)

    const attribute = only(children(attributes), 0)
    const [type, values] = children(attribute)
    assert.ok(type && values)
    assert.equal(type.value.toString('hex'), '2a864886f70d01090e')
    const extensions = children(only(children(values), 0))
    assert.equal(extensions.length, 1)
    const [extnId, extnValue] = children(only(extensions, 0))
    assert.ok(extnId && extnValue)
    assert.equal(extnId.value.toString('hex'), '551d11')
    const names = children(read(extnValue.value))
    assert.equal(names.length, 1)
    assert.equal(only(names, 0).tag, 0x82)
    assert.equal(only(names, 0).value.toString('ascii'), `*.${label}.u.copse.me`)

    const publicKey = createPublicKey({ key: spki.raw, format: 'der', type: 'spki' })
    assert.equal(publicKey.asymmetricKeyType, 'ec')
    assert.equal(publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1')
    assert.equal(only(children(algorithm), 0).value.toString('hex'), '2a8648ce3d040302')
    assert.equal(children(algorithm).length, 1)
    assert.equal(signature.value[0], 0)
    assert.ok(
      verify(
        'sha256',
        info.raw,
        { key: publicKey, dsaEncoding: 'der' },
        signature.value.subarray(1),
      ),
    )
    // The returned private key is the one the CSR names.
    const returned = createPublicKey(createPrivateKey(privateKeyPem)).export({
      type: 'spki',
      format: 'der',
    })
    assert.ok(returned.equals(spki.raw))
  })

  it('uses a fresh key for every request', () => {
    const a = createCertificateRequest(label)
    const b = createCertificateRequest(label)
    assert.notEqual(a.privateKeyPem, b.privateKeyPem)
  })

  it('refuses anything that is not a service-assigned label', () => {
    assert.throws(() => certificateNameFor('ABCDEFGH2345'))
    assert.throws(() => certificateNameFor('abc.efgh2345'))
    assert.throws(() => createCertificateRequest('short'))
    assert.equal(certificateNameFor(label), `*.${label}.u.copse.me`)
  })
})
