import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACP_SANDBOX_GH_CONFIG_ERROR,
  acpSandboxGithubSteer,
  denialHostLabels,
  formatSandboxNetworkDenialAudit,
  type DeniedDestination,
} from './acp-network-denial-steer.ts'
import {
  SANDBOX_DENIAL_SIGNATURES,
  classifySandboxDenial,
} from '../security/sandbox-denial-signatures.ts'

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
    assert.match(out, /Settings → General → Coding agents/)
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

describe('acpSandboxGithubSteer (issue #4145)', () => {
  const ghConfigSignature = SANDBOX_DENIAL_SIGNATURES.find(
    (signature) => signature.id === 'gh-config-read',
  )

  it('quotes the same gh error the gh-config-read denial signature recognises', () => {
    assert.ok(ghConfigSignature, 'the gh-config-read signature must exist')
    assert.match(ACP_SANDBOX_GH_CONFIG_ERROR, ghConfigSignature.pattern)
    assert.equal(
      classifySandboxDenial(ACP_SANDBOX_GH_CONFIG_ERROR, 'gh pr view')?.operation,
      'read ~/.config/gh',
    )
    // What gh really prints names the absolute path; the quote must not be the
    // only spelling the signature accepts.
    assert.match(
      'failed to read configuration: open /Users/me/.config/gh/config.yml: operation not permitted',
      ghConfigSignature.pattern,
    )
  })

  it('explains the own-shell gh failure for every route and never offers ~/.config/gh', () => {
    for (const names of [undefined, [], ['read_file'], ['run_shell'], ['gh_api_read']]) {
      const steer = acpSandboxGithubSteer(names)
      assert.ok(
        steer.includes(ACP_SANDBOX_GH_CONFIG_ERROR),
        `quotes the error for ${String(names)}`,
      )
      assert.match(steer, /It is not a missing login/)
      assert.match(steer, /do not run `gh auth login`/)
      assert.match(steer, /do not ask for access to ~\/\.config\/gh/)
      assert.match(steer, /sandbox\.allowedDomains does not fix it/)
      assert.match(steer, /Do not call github\.com or api\.github\.com from this process/)
    }
  })

  it('names exactly the GitHub tools the bridge offered, then the run_shell fallback', () => {
    const steer = acpSandboxGithubSteer([
      'read_file',
      'run_shell',
      'gh_pr_view',
      'gh_api_read',
      'git_fetch',
      'get_ci_status',
    ])
    assert.match(steer, /Offered here: gh_pr_view, gh_api_read, git_fetch, get_ci_status\./)
    assert.match(steer, /Use gh_api_read for any other GitHub read/)
    assert.match(steer, /Use git_fetch to fetch branches/)
    assert.match(steer, /For anything they do not cover, run `gh` through its run_shell tool/)
    assert.doesNotMatch(steer, /read_file/)
    assert.doesNotMatch(steer, /when available/)
  })

  it('does not name gh_api_read, git_fetch or run_shell when the bridge did not offer them', () => {
    const steer = acpSandboxGithubSteer(['gh_pr_view'])
    assert.match(steer, /Offered here: gh_pr_view\./)
    assert.doesNotMatch(steer, /gh_api_read|git_fetch|run_shell/)
  })

  it('falls back to run_shell when the bridge offers no GitHub tools (#4142)', () => {
    const steer = acpSandboxGithubSteer(['read_file', 'run_shell'])
    assert.match(steer, /offers no GitHub tools in this session/)
    assert.match(steer, /run `gh` through its run_shell tool, which can ask the user/)
    assert.doesNotMatch(steer, /gh_api_read|git_fetch|Offered here/)
  })

  it('says GitHub is out of reach when nothing bridged can reach it', () => {
    const noBridge = acpSandboxGithubSteer([])
    assert.match(noBridge, /"copse" MCP server is not available in this session/)
    assert.match(noBridge, /Tell the user that GitHub could not be reached/)
    assert.doesNotMatch(noBridge, /gh_api_read|git_fetch|run_shell/)

    const noShell = acpSandboxGithubSteer(['read_file'])
    assert.match(noShell, /offers no GitHub or shell tools in this session/)
    assert.match(noShell, /Tell the user that GitHub could not be reached/)
  })

  it('keeps the generic wording when the offered tools are unknown', () => {
    const steer = acpSandboxGithubSteer()
    assert.match(steer, /GitHub and CI tools when available/)
    assert.match(steer, /gh_api_read/)
    assert.match(steer, /git_fetch/)
  })
})
