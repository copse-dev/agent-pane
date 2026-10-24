import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'
import {
  CLOSED_PROXY_URL,
  downloadsDisabledChildEnv,
  firewallTrust,
  packageFirewallChildEnv,
  withoutFirewallBypass,
} from './child-env.ts'
import { createCertificateAuthority } from './x509.ts'

const SETTINGS = {
  proxyUrl: 'http://copse:t@127.0.0.1:4100',
  extraCaFile: '/tmp/fw/extra-ca.pem',
  fullBundleFile: '/tmp/fw/ca-bundle.pem',
}

describe('withoutFirewallBypass', () => {
  it('drops entries that would exempt an intercepted registry and keeps the rest', () => {
    assert.equal(
      withoutFirewallBypass(
        'localhost,127.0.0.1,registry.npmjs.org,.npmjs.org,files.pythonhosted.org,crates.io,pypi.org,*',
      ),
      'localhost,127.0.0.1,pypi.org',
    )
    assert.equal(withoutFirewallBypass(undefined), '')
  })
})

describe('packageFirewallChildEnv', () => {
  it('points every supported manager at the firewall and its trust files', () => {
    const env = packageFirewallChildEnv(
      { PATH: '/bin', HTTPS_PROXY: 'http://corp:3128', ELECTRON_RUN_AS_NODE: '1' },
      SETTINGS,
    )
    for (const key of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'npm_config_https_proxy',
      'YARN_HTTPS_PROXY',
      'PIP_PROXY',
      'CARGO_HTTP_PROXY',
    ]) {
      assert.equal(env[key], SETTINGS.proxyUrl, key)
    }
    assert.equal(env['NODE_EXTRA_CA_CERTS'], SETTINGS.extraCaFile)
    for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'PIP_CERT', 'CARGO_HTTP_CAINFO']) {
      assert.equal(env[key], SETTINGS.fullBundleFile, key)
    }
    assert.equal(env['PATH'], '/bin')
    assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined)
    assert.equal(env['YARN_HTTPS_CA_FILE_PATH'], undefined)
  })

  it('strips registry bypasses from NO_PROXY and always sets npm_config_noproxy', () => {
    const env = packageFirewallChildEnv(
      { NO_PROXY: 'localhost,registry.npmjs.org', no_proxy: 'files.pythonhosted.org' },
      SETTINGS,
    )
    assert.equal(env['NO_PROXY'], 'localhost')
    assert.equal(env['no_proxy'], '')
    assert.equal(env['npm_config_noproxy'], 'localhost')
    assert.equal(packageFirewallChildEnv({}, SETTINGS)['npm_config_noproxy'], '')
  })
})

describe('downloadsDisabledChildEnv', () => {
  it('routes registry downloads to a closed port instead of around the firewall', () => {
    const env = downloadsDisabledChildEnv({
      ELECTRON_RUN_AS_NODE: '1',
      NO_PROXY: 'registry.npmjs.org',
      SSL_CERT_FILE: '/etc/corp.pem',
    })
    assert.equal(env['HTTPS_PROXY'], CLOSED_PROXY_URL)
    assert.equal(env['npm_config_https_proxy'], CLOSED_PROXY_URL)
    assert.equal(env['NO_PROXY'], '')
    assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined)
    assert.equal(env['SSL_CERT_FILE'], '/etc/corp.pem', 'trust is left alone')
  })
})

describe('firewallTrust', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'firewall-trust-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the user’s own CAs alongside the firewall CA', async () => {
    const firewallCa = createCertificateAuthority({ permittedHosts: ['crates.io'] }).certPem
    const corporateCa = createCertificateAuthority({ permittedHosts: ['corp.example'] }).certPem
    const userBundle = join(dir, 'corp.pem')
    writeFileSync(userBundle, corporateCa)
    const trust = await firewallTrust(firewallCa, { NODE_EXTRA_CA_CERTS: userBundle })
    assert.ok(trust.extraCaPem.includes(firewallCa.trim()))
    assert.ok(trust.extraCaPem.includes(corporateCa.trim()))
    assert.ok(trust.fullBundlePem.includes(firewallCa.trim()))
    assert.ok(trust.fullBundlePem.includes(corporateCa.trim()))
    // A replacing variable (SSL_CERT_FILE and friends) must not lose the public roots.
    assert.ok(trust.fullBundlePem.includes((rootCertificates[0] ?? '').trim()))
  })

  it('ignores missing or unreadable user bundles', async () => {
    const ca = createCertificateAuthority({ permittedHosts: ['crates.io'] }).certPem
    const trust = await firewallTrust(ca, { NODE_EXTRA_CA_CERTS: join(dir, 'missing.pem') })
    assert.equal(trust.extraCaPem, `${ca.trim()}\n`)
  })
})
