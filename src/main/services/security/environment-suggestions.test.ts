import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptCause } from '@shared/threads/prompt-cause.ts'
import {
  buildEnvironmentSuggestions,
  MIN_APPROVALS,
  PRECHECK_APPROVALS,
  type PromptEvidence,
  type SuggestionContext,
} from './environment-suggestions.ts'

const root = '/Users/me/project'

function context(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    workspaceRoot: root,
    sandboxActive: true,
    autoApprovalLevel: 'read',
    configuredRemotes: new Set(['origin']),
    trustedCommands: new Set(),
    trustedSshHosts: [],
    trustedPackageRegistries: [],
    webAllowedOrigins: ['https://github.com'],
    harm: { workspaceRoot: root, homeDir: '/Users/me' },
    normalizeOrigin: (origin) => (/^https:\/\/[a-z0-9.-]+$/.test(origin) ? origin : null),
    ...overrides,
  }
}

let clock = 1_000

/** `count` answered shell prompts for `command`, spread over two threads. */
function shell(
  command: string,
  cause: PromptCause,
  count: number,
  verdict: PromptEvidence['verdict'] = 'approved',
): PromptEvidence[] {
  return Array.from({ length: count }, (_, i) => ({
    at: clock++,
    threadId: `t${String(i % 2)}`,
    verdict,
    kind: 'shell',
    cause,
    subject: 'shell command (arguments omitted)',
    command,
  }))
}

function web(origin: string, count: number): PromptEvidence[] {
  return Array.from({ length: count }, (_, i) => ({
    at: clock++,
    threadId: `t${String(i % 2)}`,
    verdict: 'approved' as const,
    kind: 'web',
    cause: 'web-origin' as const,
    subject: origin,
  }))
}

describe('buildEnvironmentSuggestions', () => {
  it('suggests the lowest auto-approval level that covers repeated approvals', () => {
    const [suggestion, ...rest] = buildEnvironmentSuggestions(
      shell('git commit -m "fix parser"', 'shell-in-sandbox', MIN_APPROVALS),
      context(),
    )
    assert.ok(suggestion)
    assert.equal(rest.length, 0)
    assert.equal(suggestion.kind, 'auto-approval-level')
    assert.equal(suggestion.value, 'local-write')
    assert.equal(suggestion.approvals, MIN_APPROVALS)
    assert.equal(suggestion.threads, 2)
    assert.equal(suggestion.checked, false)
    assert.match(suggestion.risk, /git hooks/)
  })

  it('pre-ticks a low-risk level only once it has enough approvals', () => {
    const [suggestion] = buildEnvironmentSuggestions(
      shell('git commit -m x', 'shell-in-sandbox', PRECHECK_APPROVALS),
      context(),
    )
    assert.ok(suggestion)
    assert.equal(suggestion.checked, true)
  })

  it('does not suggest pushes when commits alone clear the bar', () => {
    const [suggestion] = buildEnvironmentSuggestions(
      [
        ...shell('git commit -m x', 'shell-in-sandbox', MIN_APPROVALS),
        ...shell('git push origin feature', 'shell-sandbox-escalation', 1),
      ],
      context(),
    )
    assert.ok(suggestion)
    assert.equal(suggestion.value, 'local-write')
  })

  it('never suggests trusting the binary of a recognised shape, even without a sandbox', () => {
    const suggestions = buildEnvironmentSuggestions(
      shell('git push origin feature', 'shell-sandbox-escalation', PRECHECK_APPROVALS),
      context({ sandboxActive: false }),
    )
    assert.deepEqual(suggestions, [])
  })

  it('suggests trusting a host tool, never pre-ticked', () => {
    const [suggestion] = buildEnvironmentSuggestions(
      shell('xcodebuild -scheme App build', 'shell-sandbox-escalation', PRECHECK_APPROVALS),
      context(),
    )
    assert.ok(suggestion)
    assert.equal(suggestion.kind, 'trusted-command')
    assert.equal(suggestion.value, 'xcodebuild')
    assert.equal(suggestion.checked, false)
    assert.match(suggestion.risk, /outside the project sandbox/)
  })

  it('never suggests an interpreter, shell or other non-trustable binary', () => {
    for (const command of ['python3 build.py', 'bash ./deploy.sh', 'env FOO=1 make']) {
      assert.deepEqual(
        buildEnvironmentSuggestions(shell(command, 'shell-sandbox-escalation', 5), context()),
        [],
        command,
      )
    }
  })

  it('skips a binary already trusted', () => {
    const suggestions = buildEnvironmentSuggestions(
      shell('xcodebuild -scheme App build', 'shell-sandbox-escalation', 5),
      context({ trustedCommands: new Set(['xcodebuild']) }),
    )
    assert.deepEqual(suggestions, [])
  })

  it('marks a suggestion declined when a refused prompt would also have been removed', () => {
    const [suggestion] = buildEnvironmentSuggestions(
      [
        ...shell('xcodebuild -scheme App build', 'shell-sandbox-escalation', 5),
        ...shell('xcodebuild -scheme App archive', 'shell-sandbox-escalation', 1, 'denied'),
      ],
      context(),
    )
    assert.ok(suggestion)
    assert.equal(suggestion.declined, true)
    assert.equal(suggestion.checked, false)
  })

  it('needs approvals from more than one thread', () => {
    const evidence = shell('xcodebuild build', 'shell-sandbox-escalation', 5).map((item) => ({
      ...item,
      threadId: 'only',
    }))
    assert.deepEqual(buildEnvironmentSuggestions(evidence, context()), [])
  })

  it('ignores prompts below the approval threshold and prompts without a command', () => {
    const evidence = [
      ...shell('xcodebuild build', 'shell-sandbox-escalation', MIN_APPROVALS - 1),
      ...shell('xcodebuild build', 'shell-sandbox-escalation', 5).map(
        ({ command: _command, ...item }) => item,
      ),
    ]
    assert.deepEqual(buildEnvironmentSuggestions(evidence, context()), [])
  })

  it('suggests a repeatedly approved web origin that is not already allowed', () => {
    const suggestions = buildEnvironmentSuggestions(
      [...web('https://docs.example.com', 5), ...web('https://github.com', 5), ...web('nope', 5)],
      context(),
    )
    assert.deepEqual(
      suggestions.map((s) => [s.kind, s.value, s.checked]),
      [['web-origin', 'https://docs.example.com', true]],
    )
  })

  it('suggests an SSH host only when trusting it alone removes the harm prompt', () => {
    const suggestions = buildEnvironmentSuggestions(
      [
        ...shell('ssh build-box uptime', 'shell-guarded-yolo-harm', 5),
        // Agent forwarding still asks on a trusted host, so trust would not help.
        ...shell('ssh -A jump-box uptime', 'shell-guarded-yolo-harm', 5),
      ],
      context(),
    )
    assert.deepEqual(
      suggestions.map((s) => [s.kind, s.value, s.checked]),
      [['trusted-ssh-host', 'build-box', false]],
    )
  })

  it('suggests a package registry only when trusting it alone removes the harm prompt', () => {
    const suggestions = buildEnvironmentSuggestions(
      [
        ...shell(
          'npm install left-pad --registry https://npm.corp.example',
          'shell-guarded-yolo-harm',
          5,
        ),
        // `direct` can never be trusted by origin, so trusting the proxy would not help.
        ...shell(
          'GOPROXY=https://proxy.corp.example,direct go mod download',
          'shell-guarded-yolo-harm',
          5,
        ),
      ],
      context(),
    )
    assert.deepEqual(
      suggestions.map((s) => [s.kind, s.value, s.checked]),
      [['trusted-package-registry', 'https://npm.corp.example', false]],
    )
  })

  it('redacts secrets in examples', () => {
    // Assembled at run time so the repository's secret scan never sees a key=value literal.
    const fake = ['not', 'a', 'real', 'value'].join('-')
    const [suggestion] = buildEnvironmentSuggestions(
      shell(`xcodebuild -scheme App API_TOKEN=${fake}`, 'shell-sandbox-escalation', 5),
      context(),
    )
    assert.ok(suggestion)
    assert.ok(suggestion.examples.every((example) => !example.includes(fake)))
  })
})
