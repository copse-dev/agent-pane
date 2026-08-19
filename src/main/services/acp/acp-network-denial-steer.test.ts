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
    assert.match(out, /run_shell and run_background/)
    assert.ok(
      out.indexOf('bridged tools') < out.indexOf('sandbox.allowedDomains'),
      'the allowlist override must read as the fallback, after the bridged tools',
    )
    assert.match(out, /Settings → ACP/)
  })

  it('names the bridged GitHub tools when GitHub was blocked, including content subdomains', () => {
    for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'GitHub.com'])
      assert.match(
        formatSandboxNetworkDenialAudit([{ host }]),
        /gh_pr_\*/,
        `expected the bridged GitHub tools named for ${host}`,
      )
  })

  it('omits the GitHub tools for an unrelated host, including lookalikes', () => {
    // An adapter's telemetry intake or package registry is the common denial;
    // opening that card with pull-request tooling reads as a non sequitur.
    for (const host of [
      'http-intake.logs.us5.datadoghq.com',
      'registry.npmjs.org',
      'evilgithub.com',
      'github.attacker.com',
    ])
      assert.doesNotMatch(
        formatSandboxNetworkDenialAudit([{ host }]),
        /gh_pr_\*/,
        `expected no GitHub tools named for ${host}`,
      )
  })
})
