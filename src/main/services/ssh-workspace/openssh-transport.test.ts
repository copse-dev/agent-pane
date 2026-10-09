import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import {
  createSshFileTransferLimit,
  OpenSshTransport,
  sshExecArgs,
  sshPtyArgs,
} from './openssh-transport.ts'
import { controlSocketPath, setSshControlDirForTests } from './ssh-paths.ts'

const host: SshWorkspaceHost = {
  id: 'dev-box',
  label: 'Dev',
  host: 'dev.example',
  user: 'ubuntu',
}

describe('sshExecArgs / ControlPath', () => {
  afterEach(() => {
    setSshControlDirForTests(null)
  })

  it(
    'passes the control socket via -S, not -o ControlPath',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    () => {
      const dir = mkdtempSync('/tmp/copse-cm-')
      try {
        setSshControlDirForTests(dir)
        const sock = controlSocketPath(host.id)

        const args = sshExecArgs(host, 'true')
        const sIdx = args.indexOf('-S')
        assert.notEqual(sIdx, -1)
        assert.equal(args[sIdx + 1], sock)

        for (const arg of args) {
          assert.ok(
            !arg.startsWith('ControlPath='),
            `must not pass -o ControlPath=… (got ${arg}); OpenSSH splits on spaces`,
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it(
    'keeps -S socket path for pty argv as well',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    () => {
      const dir = mkdtempSync('/tmp/copse-cm-')
      try {
        setSshControlDirForTests(dir)
        const sock = controlSocketPath(host.id)
        const args = sshPtyArgs(host, 'bash -l')
        assert.equal(args[0], '-tt')
        const sIdx = args.indexOf('-S')
        assert.equal(args[sIdx + 1], sock)
        assert.ok(!args.some((a) => a.startsWith('ControlPath=')))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it(
    'persists the multiplexed master well past a pause between agent turns',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    () => {
      // A short ControlPersist means the next command re-authenticates — a
      // password dialog on password-auth hosts. Keepalives bound the other
      // direction: a master whose peer vanished must die, not hang.
      const args = sshExecArgs(host, 'true')
      const persist = args.find((arg) => arg.startsWith('ControlPersist='))
      assert.ok(persist, 'expected a ControlPersist option')
      const seconds = Number.parseInt(persist.split('=')[1] ?? '', 10)
      assert.ok(seconds >= 3600, `ControlPersist too short for a work session: ${persist}`)
      assert.ok(args.some((arg) => arg.startsWith('ServerAliveInterval=')))
      assert.ok(args.some((arg) => arg.startsWith('ServerAliveCountMax=')))
    },
  )

  it('does not emit -p/-i/user@ when host only has an ssh-config alias', () => {
    // Imported ProxyCommand hosts must be invoked as the bare alias so OpenSSH
    // applies Port/User/IdentityFile/ProxyCommand from ~/.ssh/config.
    const aliasOnly: SshWorkspaceHost = {
      id: 'remote-dev-testing-016',
      label: 'remote-dev-testing-016',
      host: 'remote-dev-testing-016',
    }
    const args = sshExecArgs(aliasOnly, 'true')
    assert.ok(!args.includes('-p'))
    assert.ok(!args.includes('-i'))
    assert.equal(args[args.length - 2], 'remote-dev-testing-016')
  })
})

describe('SSH file transfer limit', () => {
  it('stops a stream before a chunk would take it over the byte budget', async () => {
    const limiter = createSshFileTransferLimit(5)
    assert.ok(limiter)
    const written: Buffer[] = []
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        written.push(chunk)
        callback()
      },
    })

    await assert.rejects(
      pipeline(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), limiter, destination),
      /exceeded the 5 byte limit/,
    )
    assert.equal(Buffer.concat(written).byteLength, 4)
  })

  it('rejects an invalid byte budget before starting a transfer', () => {
    assert.throws(() => createSshFileTransferLimit(Number.NaN), /Invalid SSH file transfer limit/)
  })
})

/** Put an executable `ssh` shell script first on PATH for the duration of a test. */
function installFakeSsh(t: { after: (fn: () => void) => void }, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-fake-ssh-'))
  const sshPath = join(dir, 'ssh')
  writeFileSync(sshPath, `#!/bin/sh\n${script}\n`)
  chmodSync(sshPath, 0o755)
  const originalPath = process.env['PATH']
  process.env['PATH'] = [dir, originalPath ?? ''].join(delimiter)
  setSshControlDirForTests(dir)
  t.after(() => {
    process.env['PATH'] = originalPath
    setSshControlDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

describe(
  'OpenSshTransport against a local ssh process',
  { skip: process.platform === 'win32' },
  () => {
    it('keeps the event loop running while the control master authenticates', async (t) => {
      // The askpass bridge answers password prompts from this same event loop;
      // a blocking spawn while ssh waits on askpass would deadlock the main process.
      installFakeSsh(t, 'case " $* " in *" -O check "*) exit 255 ;; esac\nsleep 0.3\nexit 0')
      const transport = new OpenSshTransport(host)
      let ranDuringConnect = false
      const timer = setTimeout(() => {
        ranDuringConnect = !transport.isConnected()
      }, 20)
      await transport.connect()
      clearTimeout(timer)
      assert.equal(transport.isConnected(), true)
      assert.equal(ranDuringConnect, true)
    })

    it('reports the control master failure from stderr', async (t) => {
      installFakeSsh(t, 'echo "Permission denied (publickey)." >&2\nexit 255')
      const transport = new OpenSshTransport(host)
      await assert.rejects(() => transport.connect(), /Permission denied \(publickey\)\./)
      assert.equal(transport.isConnected(), false)
    })

    it('survives ssh exiting before it reads stdin', async (t) => {
      installFakeSsh(t, 'exit 3')
      const transport = new OpenSshTransport(host)
      const result = await transport.execShell('cat > /dev/null', {
        stdin: 'x'.repeat(8 * 1024 * 1024),
      })
      assert.equal(result.code, 3)
    })

    it('decodes a multibyte character split across output chunks', async (t) => {
      // "€" is E2 82 AC; the pause makes the pipe deliver it in two reads.
      installFakeSsh(t, "printf '\\342\\202'\nsleep 0.1\nprintf '\\254\\n'")
      const transport = new OpenSshTransport(host)
      const result = await transport.execShell('true')
      assert.equal(result.stdout, '€\n')
    })
  },
)
