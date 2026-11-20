import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UNSANDBOXED_ACCESS_WARNING } from '@shared/approval-copy.ts'
import type { RuntimeProfile } from '@shared/threads/execution-runtime.ts'
import { formatShellPromptParts } from './permission-policy.ts'
import {
  runtimeChangeLines,
  runtimeLeadLine,
  sandboxEscapeChangeSection,
  sshPromptRuntime,
} from './runtime-prompt.ts'

describe('runtime prompt copy', () => {
  it('lists exactly what a sandbox escape widens', () => {
    assert.deepEqual(
      runtimeChangeLines(
        { kind: 'local', containment: 'contained' },
        { kind: 'local', containment: 'host' },
      ),
      [
        'Files: this project only → everything your account can open on this computer',
        'Network: only hosts the sandbox already allows → any host',
        'Isolation: the project sandbox → none',
      ],
    )
    assert.match(sandboxEscapeChangeSection(), /^Approving changes how it runs:\n• Files: /)
  })

  it('lists nothing when the runtime does not change', () => {
    const contained: RuntimeProfile = { kind: 'local', containment: 'contained' }
    assert.deepEqual(runtimeChangeLines(contained, contained), [])
  })

  it('names the SSH host and says no sandbox applies there', () => {
    const line = runtimeLeadLine(
      { kind: 'ssh', name: 'build-box', forwardsAgent: false },
      UNSANDBOXED_ACCESS_WARNING,
    )
    assert.match(line, /^This runs on build-box over SSH, as that account\./)
    assert.match(line, /Copse adds no sandbox there/)
    assert.doesNotMatch(line, /agent/)
  })

  it("names the SSH host's network as part of what the command can reach", () => {
    const line = runtimeLeadLine(
      { kind: 'ssh', name: 'build-box', forwardsAgent: false },
      UNSANDBOXED_ACCESS_WARNING,
    )
    assert.match(line, /reach any network that host can\./)
  })

  it('says when Copse forwards the SSH agent, so local keys are in reach too', () => {
    const line = runtimeLeadLine(
      { kind: 'ssh', name: 'build-box', forwardsAgent: true },
      UNSANDBOXED_ACCESS_WARNING,
    )
    assert.match(
      line,
      /It can also use the SSH keys in your local agent, which Copse forwards to this host\.$/,
    )
  })

  it('names an SSH host by its label and address, and carries its agent forwarding', () => {
    assert.deepEqual(
      sshPromptRuntime('build-box', {
        label: 'Build box',
        address: 'deploy@10.0.0.5',
        forwardAgent: true,
      }),
      { kind: 'ssh', name: 'Build box (deploy@10.0.0.5)', forwardsAgent: true },
    )
    assert.deepEqual(
      sshPromptRuntime('box', { label: 'deploy@box', address: 'deploy@box', forwardAgent: false }),
      { kind: 'ssh', name: 'deploy@box', forwardsAgent: false },
    )
    assert.deepEqual(sshPromptRuntime('build-box', undefined), {
      kind: 'ssh',
      name: 'build-box',
      forwardsAgent: false,
    })
  })

  it('keeps the local lead lines unchanged', () => {
    assert.equal(
      formatShellPromptParts('ls', [], true).bodyAdvice,
      'This runs inside the project sandbox. It can still change or delete project files.',
    )
    assert.match(
      formatShellPromptParts('ls', [], false).bodyAdvice ?? '',
      /^The project sandbox is unavailable for this command\. This runs with your user account/,
    )
  })

  it('opens an SSH prompt with the host instead of the local sandbox state', () => {
    const advice =
      formatShellPromptParts('ls', [], false, {
        kind: 'ssh',
        name: 'build-box',
        forwardsAgent: false,
      }).bodyAdvice ?? ''
    assert.match(advice, /^This runs on build-box over SSH/)
    assert.doesNotMatch(advice, /project sandbox is unavailable/)
  })
})
