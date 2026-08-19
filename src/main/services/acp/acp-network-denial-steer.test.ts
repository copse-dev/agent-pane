import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  denialHostLabels,
  formatSandboxNetworkDenialAudit,
  type DeniedDestination,
} from './acp-network-denial-steer.ts'

describe('denialHostLabels', () => {
  it('appends the port when one was reported and deduplicates repeats', () => {
    const labels = denialHostLabels([
      { host: 'api.github.com', port: 443 },
      { host: 'api.github.com', port: 443 },
      { host: 'example.com' },
    ] satisfies DeniedDestination[])
    assert.deepEqual(labels, ['api.github.com:443', 'example.com'])
  })
})

describe('formatSandboxNetworkDenialAudit', () => {
  it('returns nothing when the turn was not blocked', () => {
    assert.equal(formatSandboxNetworkDenialAudit([]), '')
  })

  it('names the blocked hosts and puts bridged tools ahead of the allowlist override', () => {
    const out = formatSandboxNetworkDenialAudit([{ host: 'example.com', port: 443 }])
    assert.match(out, /^- example\.com:443$/m)
    assert.match(out, /gh_pr_\*/)
    assert.match(out, /run_shell and run_background/)
    assert.ok(
      out.indexOf('bridged tools') < out.indexOf('sandbox.allowedDomains'),
      'the allowlist override must read as the fallback, after the bridged tools',
    )
    assert.match(out, /Settings → ACP/)
  })

  it('calls GitHub out by name, including its content subdomains', () => {
    for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'GitHub.com'])
      assert.match(
        formatSandboxNetworkDenialAudit([{ host }]),
        /GitHub was among the blocked hosts/,
        `expected a GitHub callout for ${host}`,
      )
  })

  it('leaves the callout off for hosts that only look like GitHub', () => {
    for (const host of ['example.com', 'evilgithub.com', 'github.attacker.com'])
      assert.doesNotMatch(
        formatSandboxNetworkDenialAudit([{ host }]),
        /GitHub was among the blocked hosts/,
        `expected no GitHub callout for ${host}`,
      )
  })
})
