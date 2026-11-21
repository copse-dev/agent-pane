import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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

  it(
    'keeps the main event loop responsive while a control master starts',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    async () => {
      const dir = mkdtempSync('/tmp/copse-async-ssh-')
      const oldPath = process.env['PATH']
      try {
        const fakeSsh = `${dir}/ssh`
        writeFileSync(
          fakeSsh,
          [
            '#!/bin/sh',
            'if [ "$1" = "-O" ]; then [ -e "${0%/*}/master-up" ] && exit 0; exit 1; fi',
            // Long enough that an event-loop turn must happen before connect
            // settles. A synchronous child here would settle connect first.
            '/bin/sleep 0.1',
            ': > "${0%/*}/master-up"',
            'exit 0',
          ].join('\n'),
        )
        chmodSync(fakeSsh, 0o755)
        process.env['PATH'] = dir
        setSshControlDirForTests(dir)

        let settled = false
        const connecting = new OpenSshTransport(host).connect().finally(() => {
          settled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(settled, false, 'SSH startup must yield while authentication can be answered')
        await connecting
      } finally {
        if (oldPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = oldPath
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('SSH destination validation', () => {
  /** `host` with its destination fields replaced; `user: null` drops the user. */
  function withDestination(target: string, user: string | null = 'ubuntu'): SshWorkspaceHost {
    return { id: host.id, label: host.label, host: target, ...(user === null ? {} : { user }) }
  }

  const refused: { name: string; host: SshWorkspaceHost; message: RegExp }[] = [
    { name: 'an option-shaped host', host: withDestination('-oFoo=bar'), message: /start with/ },
    { name: 'a padded option-shaped host', host: withDestination('  -oFoo=bar'), message: /start/ },
    {
      name: 'an option-shaped user',
      host: withDestination('dev.example', '-p22'),
      message: /User cannot start/,
    },
    {
      name: 'a host carrying an option-shaped user',
      host: withDestination('-p22@dev.example', null),
      message: /Host cannot start/,
    },
    {
      name: 'an option-shaped name after user@',
      host: withDestination('ubuntu@-oFoo=bar', null),
      message: /Host cannot start/,
    },
    { name: 'a host with a space', host: withDestination('dev.example -p22'), message: /spaces/ },
    {
      name: 'a host with a newline',
      host: withDestination('dev.example\n-p22'),
      message: /spaces/,
    },
    {
      name: 'a host with a control character',
      host: withDestination('dev\u0001example'),
      message: /control/,
    },
    {
      name: 'a user with a control character',
      host: withDestination('dev.example', 'ubuntu\u007f'),
      message: /User cannot contain control/,
    },
    { name: 'a blank host', host: withDestination('   '), message: /required/ },
  ]
  for (const { name, host: bad, message } of refused) {
    it(`refuses ${name} in every argv builder`, () => {
      assert.throws(() => sshExecArgs(bad, 'true'), message)
      assert.throws(() => sshPtyArgs(bad, 'bash -l'), message)
    })
  }

  const accepted: { name: string; host: SshWorkspaceHost; target: string }[] = [
    { name: 'a plain host', host: withDestination('dev.example', null), target: 'dev.example' },
    {
      name: 'a host with a user',
      host: withDestination('dev.example'),
      target: 'ubuntu@dev.example',
    },
    {
      name: 'a user@host host',
      host: withDestination('ubuntu@dev.example', null),
      target: 'ubuntu@dev.example',
    },
    {
      name: 'a padded host',
      host: withDestination('  dev.example  '),
      target: 'ubuntu@dev.example',
    },
    { name: 'a hyphenated host', host: withDestination('dev-box-2'), target: 'ubuntu@dev-box-2' },
    { name: 'an IPv6 literal', host: withDestination('[::1]', null), target: '[::1]' },
    { name: 'an IPv6 literal with a user', host: withDestination('[::1]'), target: 'ubuntu@[::1]' },
    {
      name: 'a user with a space',
      host: withDestination('dev.example', 'first last'),
      target: 'first last@dev.example',
    },
    {
      name: 'a user@host host whose unused user field is option-shaped',
      host: withDestination('ubuntu@dev.example', '-p22'),
      target: 'ubuntu@dev.example',
    },
  ]
  for (const { name, host: ok, target } of accepted) {
    it(`accepts ${name}`, () => {
      const args = sshExecArgs(ok, 'true')
      assert.equal(args.at(-2), target)
      assert.equal(args.at(-1), 'true')
      const pty = sshPtyArgs(ok, 'bash -l')
      assert.equal(pty.at(-2), target)
    })
  }

  it(
    'refuses an option-shaped host at connect without starting ssh',
    { skip: process.platform === 'win32' },
    async (t) => {
      const dir = installFakeSsh(t, 'touch "$(dirname "$0")/ran"\nexit 0')
      const transport = new OpenSshTransport({ ...host, host: '-oFoo=bar' })
      await assert.rejects(transport.connect(), /Cannot use SSH host “dev-box”: Host cannot start/)
      assert.equal(transport.isConnected(), false)
      assert.equal(existsSync(join(dir, 'ran')), false, 'ssh must not run for a refused host')
    },
  )
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
  // macOS caps Unix-domain socket paths at 104 bytes; its private TMPDIR is
  // already long enough that the hashed ControlPath can exceed Copse's limit.
  const dir = mkdtempSync('/tmp/copse-fake-ssh-')
  const sshPath = join(dir, 'ssh')
  writeFileSync(sshPath, `#!/bin/sh\n${script}\n`)
  chmodSync(sshPath, 0o755)
  const originalPath = process.env['PATH']
  process.env['PATH'] = [dir, originalPath ?? ''].join(delimiter)
  setSshControlDirForTests(dir)
  t.after(() => {
    for (const name of ['pid', 'child-pid']) {
      const pidPath = join(dir, name)
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        if (Number.isInteger(pid) && pid > 1) cleanupProcessGroup(pid)
      }
    }
    process.env['PATH'] = originalPath
    setSshControlDirForTests(null)
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * The stub's control master: `-O check` succeeds while `master-up` exists.
 * A script that starts a master creates it; a test removes it to drop the link.
 */
const STUB_MASTER_CHECK = [
  'case " $* " in',
  '  *" -O check "*) [ -e "$(dirname "$0")/master-up" ] && exit 0 || exit 255 ;;',
  'esac',
].join('\n')

/** Leave a socket file whose listener died without removing it, as a SIGKILLed master does. */
async function leaveDeadSocket(path: string): Promise<void> {
  const listener = spawn(
    process.execPath,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('ready'))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  await once(listener.stdout, 'data')
  const exited = once(listener, 'exit')
  listener.kill('SIGKILL')
  await exited
  assert.ok(existsSync(path), 'the dead listener left its socket file')
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition() && Date.now() < deadline) await delay(20)
  assert.ok(condition(), message)
}

function processIsRunning(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  assert.equal(result.error, undefined, 'process liveness probe must execute')
  const state = result.stdout.trim()
  // A container's init may retain an orphaned zombie. It has stopped executing
  // and cannot be killed again; do not mistake it for a leaked live process.
  return state.length > 0 && !state.startsWith('Z')
}

function cleanupProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The assertion path and the success path must both leave no fixture alive.
    }
  }
}

describe(
  'OpenSshTransport against a local ssh process',
  { skip: process.platform === 'win32' },
  () => {
    it('keeps the event loop running while the control master authenticates', async (t) => {
      // The askpass bridge answers password prompts from this same event loop;
      // a blocking spawn while ssh waits on askpass would deadlock the main process.
      installFakeSsh(
        t,
        [STUB_MASTER_CHECK, 'sleep 0.3', 'touch "$(dirname "$0")/master-up"', 'exit 0'].join('\n'),
      )
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

    it('answers a liveness check from the control socket alone', async (t) => {
      // Every invocation is logged so the test can prove a check never opens a
      // connection.
      const dir = installFakeSsh(
        t,
        [
          'echo "$*" >> "$(dirname "$0")/calls"',
          STUB_MASTER_CHECK,
          'touch "$(dirname "$0")/master-up"',
          'exit 0',
        ].join('\n'),
      )
      const transport = new OpenSshTransport(host)
      await transport.connect()
      assert.equal(await transport.checkAlive(), true)

      rmSync(join(dir, 'master-up'))
      assert.equal(await transport.checkAlive(), false)
      assert.equal(transport.isConnected(), false, 'a dead master is no longer reported connected')

      // What `ControlMaster=auto` does when a command runs after the drop. The
      // next check asks again rather than trusting the failed one.
      writeFileSync(join(dir, 'master-up'), '')
      assert.equal(await transport.checkAlive(), true)
      assert.equal(transport.isConnected(), true)

      const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
      // Only connect started a master; every other call asked the socket.
      assert.deepEqual(
        calls.filter((line) => !line.startsWith('-O check ')).map((line) => line.split(' ')[0]),
        ['-fNM'],
      )
    })

    it('clears a control socket its dead master left behind', async (t) => {
      // Like OpenSSH, the stub gives up multiplexing when the socket path is
      // taken: it stays connected as a plain connection and still exits 0.
      const dir = installFakeSsh(
        t,
        [
          'prev=; for arg; do [ "$prev" = -S ] && sock=$arg; prev=$arg; done',
          STUB_MASTER_CHECK,
          'if [ -S "$sock" ]; then echo "$*" >> "$(dirname "$0")/plain"; exit 0; fi',
          'touch "$(dirname "$0")/master-up"',
          'exit 0',
        ].join('\n'),
      )
      await leaveDeadSocket(controlSocketPath(host.id))

      const transport = new OpenSshTransport(host)
      await transport.connect({ quiet: true })
      assert.equal(transport.isConnected(), true)
      assert.equal(existsSync(join(dir, 'plain')), false, 'no plain connection left running')
    })

    it('does not count a master that never answered on its socket', async (t) => {
      installFakeSsh(
        t,
        [
          'case " $* " in *" -O check "*) exit 255 ;; esac',
          'echo "ControlSocket in use, disabling multiplexing" >&2',
          'exit 0',
        ].join('\n'),
      )
      const transport = new OpenSshTransport(host)
      await assert.rejects(() => transport.connect({ quiet: true }), /disabling multiplexing/)
      assert.equal(transport.isConnected(), false)
    })

    it('makes a quiet connect unable to prompt or hang', async (t) => {
      const dir = installFakeSsh(
        t,
        [
          STUB_MASTER_CHECK,
          'echo "$*" >> "$(dirname "$0")/master-args"',
          'touch "$(dirname "$0")/master-up"',
          'exit 0',
        ].join('\n'),
      )
      await new OpenSshTransport(host).connect({ quiet: true })
      rmSync(join(dir, 'master-up'))
      await new OpenSshTransport(host).connect()

      const [quiet, interactive] = readFileSync(join(dir, 'master-args'), 'utf8').trim().split('\n')
      assert.ok(quiet && interactive)
      assert.match(quiet, /-o BatchMode=yes/)
      assert.match(quiet, /-o ConnectTimeout=10/)
      assert.doesNotMatch(interactive, /BatchMode|ConnectTimeout/)
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

    it('reports a signal-terminated ssh client as a failed command', async (t) => {
      installFakeSsh(t, 'kill -TERM "$$"')
      const transport = new OpenSshTransport(host)
      const result = await transport.execShell('true')
      assert.equal(result.code, 1)
    })

    it('decodes a multibyte character split across output chunks', async (t) => {
      // "€" is E2 82 AC; the pause makes the pipe deliver it in two reads.
      installFakeSsh(t, "printf '\\342\\202'\nsleep 0.1\nprintf '\\254\\n'")
      const transport = new OpenSshTransport(host)
      const result = await transport.execShell('true')
      assert.equal(result.stdout, '€\n')
    })

    for (const stop of ['abort', 'timeout'] as const) {
      it(`escalates ${stop} to SIGKILL when the ssh client ignores SIGTERM`, async (t) => {
        const dir = installFakeSsh(
          t,
          'trap "" TERM\necho $$ > "$(dirname "$0")/pid"\nwhile :; do sleep 1; done',
        )
        const pidPath = join(dir, 'pid')
        const controller = new AbortController()
        const transport = new OpenSshTransport(host)
        const operation = transport.execShell('true', {
          signal: controller.signal,
          timeoutMs: stop === 'timeout' ? 3_000 : 0,
        })
        // Register the rejection expectation before triggering Stop or waiting
        // for readiness, so a timeout cannot become an unhandled rejection.
        const rejected = assert.rejects(
          operation,
          stop === 'abort' ? { name: 'AbortError' } : /SSH command timed out/,
        )
        await waitForCondition(() => existsSync(pidPath), 'fake ssh installed its TERM handler')
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        assert.ok(Number.isInteger(pid) && pid > 1)
        const stoppedAt = Date.now()
        if (stop === 'abort') {
          controller.abort()
          controller.abort()
        }
        await rejected
        if (stop === 'abort') {
          assert.ok(Date.now() - stoppedAt < 1_000, 'Stop rejects before the kill grace elapses')
        }
        const sshPid = pid
        await waitForCondition(() => !processIsRunning(sshPid), 'stubborn ssh must be SIGKILLed')
      })
    }

    for (const redirected of [false, true]) {
      it(`kills a descendant after ssh exits (${redirected ? 'redirected' : 'inherited'} pipes)`, async (t) => {
        const dir = installFakeSsh(
          t,
          `echo $$ > "$(dirname "$0")/pid"\n(trap "" TERM; echo ready > "$(dirname "$0")/child-ready"; exec sleep 30) ${redirected ? '>/dev/null 2>&1 </dev/null' : ''} &\necho $! > "$(dirname "$0")/child-pid"\nwait`,
        )
        const controller = new AbortController()
        const transport = new OpenSshTransport(host)
        const operation = transport.execShell('true', { signal: controller.signal, timeoutMs: 0 })
        const rejected = assert.rejects(operation, { name: 'AbortError' })
        await waitForCondition(
          () => existsSync(join(dir, 'child-ready')) && existsSync(join(dir, 'child-pid')),
          'the descendant installed its TERM handler',
        )
        const pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim())
        const descendantPid = Number(readFileSync(join(dir, 'child-pid'), 'utf8').trim())
        assert.ok(Number.isInteger(pid) && pid > 1)
        assert.ok(Number.isInteger(descendantPid) && descendantPid > 1)
        controller.abort()
        await rejected
        const childPid = descendantPid
        await waitForCondition(
          () => !processIsRunning(childPid),
          'a descendant that outlives ssh must receive the group SIGKILL',
        )
      })
    }

    it('does not start ssh for an already cancelled command', async (t) => {
      const dir = installFakeSsh(t, 'echo started > "$(dirname "$0")/started"')
      const controller = new AbortController()
      controller.abort()
      const transport = new OpenSshTransport(host)
      await assert.rejects(transport.execArgv(['true'], { signal: controller.signal }), {
        name: 'AbortError',
      })
      await delay(30)
      assert.equal(existsSync(join(dir, 'started')), false)
    })
  },
)
