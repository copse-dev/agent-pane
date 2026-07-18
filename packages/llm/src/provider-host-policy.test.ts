import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertLowRiskProviderHost,
  assertProviderHostAllowed,
  builtinProviderHosts,
  isProviderHostAllowed,
  providerHostKey,
} from './provider-host-policy.ts'

describe('providerHostKey', () => {
  it('normalizes to lowercase hostname', () => {
    assert.equal(providerHostKey('https://API.Together.XYZ/v1'), 'api.together.xyz')
  })

  it('rejects an invalid URL', () => {
    assert.throws(() => {
      providerHostKey('not a url')
    }, /not a valid URL/)
  })
})

describe('builtinProviderHosts', () => {
  it('includes first-party and preset hosts', () => {
    const hosts = builtinProviderHosts()
    assert.ok(hosts.has('api.anthropic.com'))
    assert.ok(hosts.has('api.openai.com'))
    assert.ok(hosts.has('api.cursor.com'))
    assert.ok(hosts.has('openrouter.ai'))
    assert.ok(hosts.has('api.mistral.ai'))
    assert.ok(hosts.has('router.huggingface.co'))
    assert.ok(hosts.has('localhost'))
  })
})

describe('assertLowRiskProviderHost', () => {
  it('allows public FQDNs and loopback', () => {
    assert.doesNotThrow(() => {
      assertLowRiskProviderHost('api.together.xyz')
    })
    assert.doesNotThrow(() => {
      assertLowRiskProviderHost('localhost')
    })
  })

  it('rejects single-label and .local names', () => {
    assert.throws(() => {
      assertLowRiskProviderHost('intranet')
    }, /fully-qualified/)
    assert.throws(() => {
      assertLowRiskProviderHost('printer.local')
    }, /fully-qualified/)
  })

  it('rejects private literals', () => {
    assert.throws(() => {
      assertLowRiskProviderHost('10.0.0.1')
    }, /private or link-local/)
  })
})

describe('assertProviderHostAllowed', () => {
  it('allows builtins and local servers without approval', () => {
    assert.doesNotThrow(() => {
      assertProviderHostAllowed('https://api.mistral.ai/v1', [])
    })
    assert.doesNotThrow(() => {
      assertProviderHostAllowed('http://127.0.0.1:1234/v1', [])
    })
    assert.doesNotThrow(() => {
      assertProviderHostAllowed('http://localhost:11434/v1', [])
    })
  })

  it('allows an approved custom host', () => {
    assert.doesNotThrow(() => {
      assertProviderHostAllowed('https://api.together.xyz/v1', ['api.together.xyz'])
    })
    assert.equal(isProviderHostAllowed('https://api.together.xyz/v1', ['api.together.xyz']), true)
  })

  it('blocks an unapproved custom host', () => {
    assert.throws(() => {
      assertProviderHostAllowed('https://evil.example/v1', [])
    }, /evil\.example.*not approved.*General/)
    assert.equal(isProviderHostAllowed('https://evil.example/v1', []), false)
  })
})
