import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifySshPrompt } from './ssh-prompt.ts'
import { buildGitSshCommand, leaseGitSshEnv } from './git-ssh-env.ts'
import {
  initSshAskpassServer,
  leaseSshAskpassEnv,
  resetSshAskpassForTests,
  setSshAskpassUserDataDirForTests,
  type SshAskpassLease,
} from './askpass.ts'
import { setSshPromptHandler } from './ssh-prompt.ts'
import {
  resolveRendererPromptTarget,
  runWithRendererPromptTarget,
  type RendererPromptTarget,
} from '../renderer-prompt-target.ts'

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

/** One askpass round-trip over the bridge socket, as the helper script does it. */
function askOverSocket(lease: SshAskpassLease, prompt: string): Promise<string> {
  const socketPath = lease.env['COPSE_SSH_ASKPASS_SOCKET']
  const nonce = lease.env['COPSE_SSH_ASKPASS_NONCE']
  assert.ok(typeof socketPath === 'string' && socketPath.length > 0)
  assert.ok(typeof nonce === 'string' && nonce.length > 0)
  return new Promise<string>((resolve, reject) => {
    const client = connect(socketPath)
    let buffer = ''
    client.on('error', reject)
    client.write(`${JSON.stringify({ nonce, prompt })}\n`)
    client.on('data', (chunk) => {
      buffer += chunk.toString()
    })
    client.on('end', () => {
      resolve(buffer)
    })
  })
}

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

  it('keeps the socket short when the profile path exceeds the macOS socket budget', async () => {
    resetSshAskpassForTests()
    const longUserDataDir = join(testDir, 'named-profile-'.repeat(10))
    mkdirSync(longUserDataDir, { recursive: true })
    setSshAskpassUserDataDirForTests(longUserDataDir)
    initSshAskpassServer()
    setSshPromptHandler(async () => ({ value: 'verified' }))

    const lease = leaseSshAskpassEnv({})
    try {
      const path = lease.env['COPSE_SSH_ASKPASS_SOCKET']
      assert.ok(typeof path === 'string' && path.length > 0)
      if (process.platform === 'win32') {
        assert.match(path, /^\\\\\\\\\.\\\\pipe\\\\copse-ssh-askpass-/)
      } else {
        assert.ok(
          Buffer.byteLength(path) < 104,
          `socket path is ${String(Buffer.byteLength(path))}B`,
        )
        assert.equal(path.startsWith(longUserDataDir), false)
      }
      const response = await askOverSocket(lease, 'Enter passphrase for key')
      assert.deepEqual(JSON.parse(response), { response: 'verified' })
    } finally {
      lease.release()
    }
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

  it('marks configured-host prompts as eligible for device persistence', async () => {
    setSshPromptHandler(async (req) => {
      assert.equal(req.kind, 'secret')
      assert.equal(req.canRememberOnDevice, true)
      return { value: 's3cret', remember: true }
    })

    const lease = leaseSshAskpassEnv({}, 'dev')
    const response = await askOverSocket(lease, '(me@dev.example) Password:')
    lease.release()

    assert.deepEqual(JSON.parse(response), { response: 's3cret' })
  })

  it('reuses a remembered secret for a later spawn without re-prompting', async () => {
    let prompts = 0
    setSshPromptHandler(async (req) => {
      prompts += 1
      assert.equal(req.kind, 'secret')
      return { value: 's3cret', remember: true }
    })

    const first = leaseSshAskpassEnv({})
    const firstResponse = await askOverSocket(first, '(me@dev.example) Password:')
    first.release()

    const second = leaseSshAskpassEnv({})
    const secondResponse = await askOverSocket(second, '(me@dev.example) Password:')
    second.release()

    assert.deepEqual(JSON.parse(firstResponse), { response: 's3cret' })
    assert.deepEqual(JSON.parse(secondResponse), { response: 's3cret' })
    assert.equal(prompts, 1)
  })

  it('prompts every spawn when the user declines to remember', async () => {
    let prompts = 0
    setSshPromptHandler(async () => {
      prompts += 1
      return { value: 's3cret', remember: false }
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lease = leaseSshAskpassEnv({})
      const response = await askOverSocket(lease, '(me@dev.example) Password:')
      lease.release()
      assert.deepEqual(JSON.parse(response), { response: 's3cret' })
    }
    assert.equal(prompts, 2)
  })

  // #2507. OpenSSH asks over this socket, in a fresh async context, so the scope
  // set by the window that started the connection is long gone by the time the
  // question arrives. The lease carries it instead — without that, a pop-out's
  // SSH terminal put its passphrase and host-key prompts on the main window,
  // where they timed out unanswered.
  describe('the window that leased the connection gets asked', () => {
    function fakeRenderer(id: string): RendererPromptTarget & { id: string } {
      return { id, isDestroyed: (): boolean => false, send: (): void => {} }
    }

    it('restores the leasing renderer when the prompt arrives over the socket', async () => {
      const mainWindow = fakeRenderer('main')
      const popout = fakeRenderer('popout')
      let asked: RendererPromptTarget | null = null
      setSshPromptHandler(async () => {
        asked = resolveRendererPromptTarget(mainWindow)
        return { value: 's3cret' }
      })

      // Leased inside the pop-out's scope, exactly as `terminal:create` does...
      const lease = runWithRendererPromptTarget(popout, () => leaseSshAskpassEnv({}))
      // ...and asked from outside it, exactly as the askpass helper does.
      const response = await askOverSocket(lease, 'Enter passphrase for key')
      lease.release()

      assert.deepEqual(JSON.parse(response), { response: 's3cret' })
      assert.equal(asked, popout)
    })

    it('leaves a lease with no window behind it on the main-window fallback', async () => {
      // A background agent run leases credentials too. Nothing scoped it, so it
      // must not inherit whichever renderer happened to ask last.
      const mainWindow = fakeRenderer('main')
      let asked: RendererPromptTarget | null = null
      setSshPromptHandler(async () => {
        asked = resolveRendererPromptTarget(mainWindow)
        return { value: 's3cret' }
      })

      const lease = leaseSshAskpassEnv({})
      await askOverSocket(lease, 'Enter passphrase for key')
      lease.release()

      assert.equal(asked, mainWindow)
    })

    it('routes a host-key confirmation the same way', async () => {
      // The one the user can least afford to answer blind: a fingerprint shown
      // in a window that never mentioned the connection is unanswerable.
      const mainWindow = fakeRenderer('main')
      const popout = fakeRenderer('popout')
      let asked: RendererPromptTarget | null = null
      setSshPromptHandler(async (req) => {
        assert.equal(req.kind, 'confirm')
        asked = resolveRendererPromptTarget(mainWindow)
        return { value: 'yes' }
      })

      const lease = runWithRendererPromptTarget(popout, () => leaseSshAskpassEnv({}))
      const response = await askOverSocket(
        lease,
        'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
      )
      lease.release()

      assert.deepEqual(JSON.parse(response), { response: 'yes' })
      assert.equal(asked, popout)
    })
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

describe('leaseSshAskpassEnv environment inheritance', () => {
  let testDir = ''

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'copse-ssh-askpass-env-'))
    resetSshAskpassForTests()
    setSshAskpassUserDataDirForTests(testDir)
  })

  afterEach(() => {
    resetSshAskpassForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('preserves PATH/HOME/SSH_AUTH_SOCK from the base env for ProxyCommand', () => {
    const lease = leaseSshAskpassEnv({
      PATH: '/custom/bin:/usr/bin',
      HOME: '/home/proxy-user',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    })
    try {
      assert.equal(lease.env['PATH'], '/custom/bin:/usr/bin')
      assert.equal(lease.env['HOME'], '/home/proxy-user')
      assert.equal(lease.env['SSH_AUTH_SOCK'], '/tmp/agent.sock')
      assert.ok(lease.env['SSH_ASKPASS'])
    } finally {
      lease.release()
    }
  })
})
