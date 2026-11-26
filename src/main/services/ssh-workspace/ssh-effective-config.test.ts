import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forwardAgentFromSshG } from './ssh-effective-config.ts'

/** The shape of real `ssh -G` output, trimmed to a few neighbouring keywords. */
function sshG(forwardAgentLine: string | null): string {
  return [
    'host dev-box',
    'user alice',
    'hostname dev.example.com',
    'port 22',
    'addressfamily any',
    'batchmode no',
    'canonicalizefallbacklocal yes',
    ...(forwardAgentLine === null ? [] : [forwardAgentLine]),
    'forwardx11 no',
    'forwardx11trusted no',
    'identityfile ~/.ssh/id_ed25519',
    '',
  ].join('\n')
}

describe('forwardAgentFromSshG', () => {
  it('reads forwarding that ~/.ssh/config turned on', () => {
    assert.equal(forwardAgentFromSshG(sshG('forwardagent yes')), true)
  })

  it('reads forwarding that is off', () => {
    assert.equal(forwardAgentFromSshG(sshG('forwardagent no')), false)
  })

  it('counts a socket path or environment variable as forwarding', () => {
    assert.equal(forwardAgentFromSshG(sshG('forwardagent ~/.1password/agent.sock')), true)
    assert.equal(forwardAgentFromSshG(sshG('forwardagent $SSH_AUTH_SOCK')), true)
  })

  it('does not confuse neighbouring forward* keywords with ForwardAgent', () => {
    assert.equal(forwardAgentFromSshG('forwardx11 yes\nforwardx11trusted yes\n'), undefined)
  })

  it('reports no answer when the output has no forwardagent line', () => {
    assert.equal(forwardAgentFromSshG(sshG(null)), undefined)
    assert.equal(forwardAgentFromSshG(''), undefined)
  })

  it('tolerates CRLF line endings and odd spacing', () => {
    assert.equal(forwardAgentFromSshG('user alice\r\n  forwardagent   yes\r\n'), true)
    assert.equal(forwardAgentFromSshG('ForwardAgent\tNo\r\n'), false)
  })
})
