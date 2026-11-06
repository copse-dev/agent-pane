import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  gitSigningFailureMessage,
  sshAgentHasSigningKey,
  sshCommitSignature,
} from './git-signing-result.ts'

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('SSH signing identity preflight', () => {
  it('matches the configured public key and ignores key comments', () => {
    const result = {
      code: 0,
      stdout: `${publicKey} fixture@example.invalid\n`,
      stdoutTruncated: false,
      stderr: '',
    }
    assert.equal(sshAgentHasSigningKey(result, publicKey), true)
    assert.equal(sshAgentHasSigningKey(result, publicKey.replace('AAAAIA', 'AAAAIB')), false)
  })

  it('accepts the system empty-agent response on stdout or stderr', () => {
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(
        sshAgentHasSigningKey(
          {
            code: 1,
            stdout: stream === 'stdout' ? 'The agent has no identities.\n' : '',
            stderr: stream === 'stderr' ? 'The agent has no identities.\n' : '',
            stdoutTruncated: false,
          },
          publicKey,
        ),
        false,
      )
    }
  })

  it('refuses failed, malformed and truncated queries even when they mention the configured key', () => {
    for (const result of [
      {
        code: 2,
        stdout: publicKey,
        stderr: 'Could not open a connection to your authentication agent.',
        stdoutTruncated: false,
      },
      { code: 0, stdout: `${publicKey}\nmalformed response`, stderr: '', stdoutTruncated: false },
      { code: 0, stdout: '', stderr: '', stdoutTruncated: false },
      { code: 0, stdout: publicKey, stderr: '', stdoutTruncated: true },
      { code: 1, stdout: 'The agent has no identities.', stderr: '', stdoutTruncated: true },
    ]) {
      assert.throws(
        () => sshAgentHasSigningKey(result, publicKey),
        /Cannot inspect SSH signing identities/,
      )
    }
  })
})

describe('SSH signing diagnostics', () => {
  it('preserves the missing-key failure and explains recovery without changing signing policy', () => {
    assert.throws(
      () =>
        sshCommitSignature({
          code: 255,
          stdout: '',
          stdoutTruncated: false,
          stderr: "Couldn't find key in agent\r\n",
        }),
      /ssh-keygen exited with code 255\.\nCouldn't find key in agent.*Load the matching signing key/,
    )
  })

  it('preserves socket failures separately from a missing key', () => {
    assert.throws(
      () =>
        sshCommitSignature({
          code: 255,
          stdout: '',
          stdoutTruncated: false,
          stderr: 'Could not communicate with agent: Permission denied',
        }),
      /Could not communicate with agent: Permission denied/,
    )
  })

  it('rejects truncated or malformed success output without including stdout in the error', () => {
    for (const stdoutTruncated of [true, false]) {
      assert.throws(
        () =>
          sshCommitSignature({
            code: 0,
            stdout: 'sensitive output',
            stdoutTruncated,
            stderr: '',
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /truncated signature|did not return an SSH signature/)
          assert.ok(!error.message.includes('sensitive output'))
          return true
        },
      )
    }
  })

  it('returns a successful signature unchanged', () => {
    const signature = '-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----\n'
    assert.equal(
      sshCommitSignature({ code: 0, stdout: signature, stdoutTruncated: false, stderr: '' }),
      signature,
    )
  })

  it('preserves authorization and timeout errors across the broker response', () => {
    for (const reason of ['Signing socket authorization changed.', 'ssh-keygen timed out.']) {
      assert.equal(
        gitSigningFailureMessage(new Error(reason)),
        `SSH commit signing failed. No unsigned retry was attempted.\n${reason}\n`,
      )
    }
  })

  it('bounds diagnostics and removes terminal escapes and NULs', () => {
    const output = gitSigningFailureMessage(
      new Error('\u001b[31mdenied\u001b[0m\0' + 'x'.repeat(40000)),
    )
    assert.match(output, /\ndeniedx/)
    assert.ok(!output.includes('\u001b'))
    assert.ok(!output.includes('\0'))
    assert.ok(Buffer.byteLength(output) < 32768)
    assert.equal(
      gitSigningFailureMessage({ message: 'untrusted exception' }),
      'SSH commit signing failed. No unsigned retry was attempted.\n',
    )
  })
})
