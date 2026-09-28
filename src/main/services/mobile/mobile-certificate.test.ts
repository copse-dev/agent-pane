import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mobileCertificate } from './mobile-certificate.ts'

describe('mobile certificate profile', () => {
  it('issues an IP-only P-256 server leaf under a name-constrained root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-mobile-cert-'))
    try {
      const issued = mobileCertificate('192.168.1.41', dir)
      const leafPem = `${issued.cert.split('-----END CERTIFICATE-----')[0] ?? ''}-----END CERTIFICATE-----\n`
      const leaf = new X509Certificate(leafPem)
      const root = new X509Certificate(issued.root)
      assert.equal(root.ca, true)
      assert.equal(leaf.ca, false)
      assert.match(leaf.subjectAltName ?? '', /IP Address:192\.168\.1\.41/)
      assert.doesNotMatch(leaf.subjectAltName ?? '', /DNS:/)
      assert.equal(leaf.publicKey.asymmetricKeyType, 'ec')
      assert.equal(leaf.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1')
      assert.ok(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom) <= 825 * 86_400_000)
      assert.equal(leaf.verify(root.publicKey), true)
      const leafPath = join(dir, 'leaf.crt')
      writeFileSync(leafPath, leafPem)
      const leafAsn1 = execFileSync('openssl', ['asn1parse', '-in', leafPath], {
        encoding: 'utf8',
      })
      assert.match(leafAsn1, /UTCTIME/)
      assert.doesNotMatch(leafAsn1, /GENERALIZEDTIME/)
      const rootAsn1 = execFileSync('openssl', ['asn1parse', '-in', issued.rootPath], {
        encoding: 'utf8',
      })
      assert.match(rootAsn1, /UTCTIME/)
      assert.doesNotMatch(rootAsn1, /GENERALIZEDTIME/)
      execFileSync('openssl', ['verify', '-CAfile', issued.rootPath, leafPath])

      // A certificate from this CA for a public website must fail in the
      // platform verifier. Inspecting the extension text is insufficient.
      const badKey = join(dir, 'bad.key')
      const badCsr = join(dir, 'bad.csr')
      const badCert = join(dir, 'bad.crt')
      const badExt = join(dir, 'bad.ext')
      writeFileSync(badExt, 'subjectAltName=DNS:accounts.google.com\nextendedKeyUsage=serverAuth\n')
      execFileSync('openssl', [
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-subj',
        '/CN=accounts.google.com',
        '-keyout',
        badKey,
        '-out',
        badCsr,
      ])
      execFileSync('openssl', [
        'x509',
        '-req',
        '-in',
        badCsr,
        '-CA',
        issued.rootPath,
        '-CAkey',
        join(dir, 'ca.key'),
        '-CAcreateserial',
        '-out',
        badCert,
        '-days',
        '1',
        '-extfile',
        badExt,
      ])
      assert.throws(
        () =>
          execFileSync('openssl', ['verify', '-CAfile', issued.rootPath, badCert], {
            stdio: 'pipe',
          }),
        /permitted subtree violation/,
      )
      assert.equal(readFileSync(join(dir, 'ca.key'), 'utf8').includes('PRIVATE KEY'), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
