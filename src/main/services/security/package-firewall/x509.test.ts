import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:net'
import { connect, createServer } from 'node:tls'
import { createCertificateAuthority } from './x509.ts'

const HOSTS = ['registry.npmjs.org', 'crates.io']

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

describe('createCertificateAuthority', () => {
  it('mints a self-signed CA certificate', () => {
    const ca = new X509Certificate(createCertificateAuthority({ permittedHosts: HOSTS }).certPem)
    assert.equal(ca.ca, true)
    assert.ok(ca.verify(ca.publicKey), 'the CA signs itself')
    assert.ok(ca.checkIssued(ca))
    assert.match(ca.subject, /O=Copse Package Firewall/)
    assert.equal(ca.publicKey.asymmetricKeyType, 'ec')
  })

  it('issues leaf certificates the CA verifies, for permitted hosts and their subdomains', () => {
    const authority = createCertificateAuthority({ permittedHosts: HOSTS })
    const ca = new X509Certificate(authority.certPem)
    for (const host of ['registry.npmjs.org', 'static.crates.io']) {
      const leaf = new X509Certificate(authority.issue(host).certPem)
      assert.equal(leaf.ca, false)
      assert.ok(leaf.verify(ca.publicKey), host)
      assert.ok(leaf.checkIssued(ca), host)
      assert.equal(leaf.checkHost(host), host)
      assert.equal(leaf.subjectAltName, `DNS:${host}`)
      assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1'])
    }
  })

  it('refuses to issue outside its name constraints', () => {
    const authority = createCertificateAuthority({ permittedHosts: HOSTS })
    for (const host of [
      'example.com',
      'npmjs.org',
      'evilcrates.io',
      'registry.npmjs.org.evil.test',
    ]) {
      assert.throws(() => authority.issue(host), /may not issue/, host)
    }
  })

  it('rejects an empty or malformed permitted-host list', () => {
    assert.throws(() => createCertificateAuthority({ permittedHosts: [] }))
    assert.throws(() => createCertificateAuthority({ permittedHosts: ['*.example.com'] }))
  })

  it('bounds validity around the issue time', () => {
    const now = new Date('2026-10-22T12:00:00Z')
    const authority = createCertificateAuthority({
      permittedHosts: HOSTS,
      now,
      validityMs: 24 * 60 * 60 * 1000,
    })
    const leaf = new X509Certificate(authority.issue('crates.io').certPem)
    assert.ok(new Date(leaf.validFrom) < now)
    assert.equal(new Date(leaf.validTo).toISOString(), '2026-10-23T12:00:00.000Z')
  })

  it('completes a verified TLS handshake for an issued host', async () => {
    const authority = createCertificateAuthority({ permittedHosts: HOSTS })
    const { certPem, keyPem } = authority.issue('registry.npmjs.org')
    const server = createServer({ cert: certPem, key: keyPem }, (socket) => {
      socket.end('ok')
    })
    const port = await listen(server)
    try {
      const client = connect({
        host: '127.0.0.1',
        port,
        servername: 'registry.npmjs.org',
        ca: authority.certPem,
      })
      await once(client, 'secureConnect')
      assert.equal(client.authorized, true)
      client.destroy()

      // The same CA does not make a different name trusted.
      const mismatch = connect({
        host: '127.0.0.1',
        port,
        servername: 'crates.io',
        ca: authority.certPem,
      })
      const error = await new Promise<Error>((resolve) => {
        mismatch.once('error', resolve)
      })
      assert.match(error.message, /altnames|Hostname/i)
    } finally {
      server.close()
    }
  })
})
