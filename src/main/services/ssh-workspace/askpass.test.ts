import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifySshPrompt } from './ssh-prompt.ts'
import { buildGitSshCommand, leaseGitSshEnv } from './git-ssh-env.ts'
import {
  initSshAskpassServer,
  leaseSshAskpassEnv,
  resetSshAskpassForTests,
  setSshAskpassUserDataDirForTests,
} from './askpass.ts'
import { setSshPromptHandler } from './ssh-prompt.ts'

describe('classifySshPrompt', () => {
  it('treats host-key wording as confirm', () => {
    assert.equal(
      classifySshPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])?'),
      'confirm',
    )
  })

  it('treats passphrase wording as secret', () => {
    assert.equal(
      classifySshPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519':"),
      'secret',
    )
  })
})

describe('buildGitSshCommand', () => {
  it('defaults to accept-new without BatchMode', () => {
    assert.equal(buildGitSshCommand({}, 'accept-new'), 'ssh -oStrictHostKeyChecking=accept-new')
  })

  it('honors an ambient GIT_SSH_COMMAND override', () => {
    assert.equal(
      buildGitSshCommand({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/custom' }, 'strict'),
      'ssh -i ~/.ssh/custom',
    )
  })

  it('uses strict checking when configured', () => {
    assert.equal(buildGitSshCommand({}, 'strict'), 'ssh -oStrictHostKeyChecking=yes')
  })
})

describe('ssh askpass bridge', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'copse-ssh-askpass-'))
    resetSshAskpassForTests()
    setSshAskpassUserDataDirForTests(testDir)
    initSshAskpassServer()
  })

  afterEach(() => {
    setSshPromptHandler(null)
    resetSshAskpassForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('rejects unknown nonces', async () => {
    const lease = leaseSshAskpassEnv({})
    const socketPath = lease.env['COPSE_SSH_ASKPASS_SOCKET']
    assert.ok(typeof socketPath === 'string' && socketPath.length > 0)
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(socketPath)
      let buffer = ''
      client.on('error', reject)
      client.write(`${JSON.stringify({ nonce: 'bad-nonce', prompt: 'test' })}\n`)
      client.on('data', (chunk) => {
        buffer += chunk.toString()
      })
      client.on('end', () => {
        resolve(buffer)
      })
    })
    assert.deepEqual(JSON.parse(response), { response: null })
    lease.release()
  })

  it('returns secret responses from the prompt handler', async () => {
    setSshPromptHandler(async (req) => {
      assert.equal(req.kind, 'secret')
      assert.match(req.prompt, /passphrase/i)
      return { value: 's3cret' }
    })

    const lease = leaseSshAskpassEnv({})
    const socketPath = lease.env['COPSE_SSH_ASKPASS_SOCKET']
    const nonce = lease.env['COPSE_SSH_ASKPASS_NONCE']
    assert.ok(typeof socketPath === 'string' && socketPath.length > 0)
    assert.ok(typeof nonce === 'string' && nonce.length > 0)

    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(socketPath)
      let buffer = ''
      client.on('error', reject)
      client.write(`${JSON.stringify({ nonce, prompt: 'Enter passphrase for key' })}\n`)
      client.on('data', (chunk) => {
        buffer += chunk.toString()
      })
      client.on('end', () => {
        resolve(buffer)
      })
    })
    assert.deepEqual(JSON.parse(response), { response: 's3cret' })
    lease.release()
  })

  it('maps confirm prompts to yes', async () => {
    setSshPromptHandler(async (req) => {
      assert.equal(req.kind, 'confirm')
      return { value: 'yes' }
    })

    const lease = leaseSshAskpassEnv({})
    const socketPath = lease.env['COPSE_SSH_ASKPASS_SOCKET']
    const nonce = lease.env['COPSE_SSH_ASKPASS_NONCE']
    assert.ok(typeof socketPath === 'string' && socketPath.length > 0)
    assert.ok(typeof nonce === 'string' && nonce.length > 0)

    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(socketPath)
      let buffer = ''
      client.on('error', reject)
      client.write(
        `${JSON.stringify({
          nonce,
          prompt: 'Are you sure you want to continue connecting (yes/no)?',
        })}\n`,
      )
      client.on('data', (chunk) => {
        buffer += chunk.toString()
      })
      client.on('end', () => {
        resolve(buffer)
      })
    })
    assert.deepEqual(JSON.parse(response), { response: 'yes' })
    lease.release()
  })
})

describe('leaseGitSshEnv', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'copse-git-ssh-env-'))
    resetSshAskpassForTests()
    setSshAskpassUserDataDirForTests(testDir)
  })

  afterEach(() => {
    resetSshAskpassForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('includes askpass and drops BatchMode from the default ssh command', () => {
    const lease = leaseGitSshEnv({})
    try {
      assert.ok(lease.env['SSH_ASKPASS'])
      assert.ok(lease.env['GIT_ASKPASS'])
      assert.equal(lease.env['SSH_ASKPASS_REQUIRE'], 'force')
      assert.match(String(lease.env['GIT_SSH_COMMAND']), /StrictHostKeyChecking=accept-new/)
      assert.doesNotMatch(String(lease.env['GIT_SSH_COMMAND']), /BatchMode/)
    } finally {
      lease.release()
    }
  })
})
