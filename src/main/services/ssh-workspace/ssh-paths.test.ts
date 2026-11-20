import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs, {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CONTROL_SOCKET_PATH_BUDGET,
  controlDirProblem,
  controlSocketFileName,
  controlSocketPath,
  setSshControlDirForTests,
  UNIX_DOMAIN_SOCKET_PATH_MAX,
} from './ssh-paths.ts'

describe('controlSocketPath', () => {
  afterEach(() => {
    setSshControlDirForTests(null)
  })

  it('uses a short hashed filename so long host ids stay under the Unix socket budget', () => {
    // This test is about the filename budget. macOS TMPDIR normally lives
    // under /var/folders and can itself exceed the entire stable socket-path
    // budget; production deliberately uses /tmp for that reason.
    const dir = mkdtempSync('/tmp/copse-cm-')
    try {
      setSshControlDirForTests(dir)
      const hostId = 'remote-dev-testing-016'
      const path = controlSocketPath(hostId)
      assert.equal(controlSocketFileName(hostId).length, '0123456789abcdef.sock'.length)
      assert.ok(
        Buffer.byteLength(path, 'utf8') <= CONTROL_SOCKET_PATH_BUDGET,
        `path length ${String(Buffer.byteLength(path, 'utf8'))} exceeds budget ${String(CONTROL_SOCKET_PATH_BUDGET)}: ${path}`,
      )
      // Even with OpenSSH's bind-time suffix, stay within sun_path.
      const withSuffix = `${path}.fUyzwh1gIvt57SO8`
      assert.ok(
        Buffer.byteLength(withSuffix, 'utf8') <= UNIX_DOMAIN_SOCKET_PATH_MAX,
        `path+suffix length ${String(Buffer.byteLength(withSuffix, 'utf8'))} exceeds ${String(UNIX_DOMAIN_SOCKET_PATH_MAX)}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays under budget for the macOS Application Support path that used to break', () => {
    // Simulate the old layout length; the new helper must not place sockets there.
    const legacy = `/Users/alexandra-morgan/Library/Application Support/copse-panel/ssh/remote-dev-testing-016.sock`
    assert.ok(Buffer.byteLength(legacy, 'utf8') > CONTROL_SOCKET_PATH_BUDGET)

    const path = controlSocketPath('remote-dev-testing-016')
    assert.doesNotMatch(path, /Application Support/)
    assert.ok(Buffer.byteLength(path, 'utf8') <= CONTROL_SOCKET_PATH_BUDGET)
    assert.ok(Buffer.byteLength(`${path}.fUyzwh1gIvt57SO8`, 'utf8') <= UNIX_DOMAIN_SOCKET_PATH_MAX)
  })
})

describe('sshControlDir', () => {
  const posixOnly = {
    skip: process.platform === 'win32' ? 'Windows has no uid or POSIX mode to check' : false,
  }

  /** A throwaway parent in `/tmp`, removed after the test. */
  function scratchParent(t: { after: (fn: () => void) => void }): string {
    const parent = mkdtempSync('/tmp/copse-cd-')
    t.after(() => {
      setSshControlDirForTests(null)
      rmSync(parent, { recursive: true, force: true })
    })
    return parent
  }

  it('creates a missing control directory with mode 0700', posixOnly, (t) => {
    const dir = join(scratchParent(t), 'control')
    setSshControlDirForTests(dir)

    const path = controlSocketPath('dev-box')

    assert.equal(path, join(dir, controlSocketFileName('dev-box')))
    const stats = lstatSync(dir)
    assert.ok(stats.isDirectory())
    assert.equal(stats.mode & 0o777, 0o700)
  })

  it('accepts a private directory another process created at the same moment', posixOnly, (t) => {
    const dir = join(scratchParent(t), 'control')
    setSshControlDirForTests(dir)
    const realMkdir = fs.mkdirSync
    t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
      // A second Copse process of the same user wins the race to create it.
      realMkdir(args[0], { mode: 0o700 })
      return realMkdir(...args)
    })

    assert.equal(controlSocketPath('dev-box'), join(dir, controlSocketFileName('dev-box')))
  })

  it('refuses an existing control directory that is a symbolic link', posixOnly, (t) => {
    const parent = scratchParent(t)
    const target = join(parent, 'target')
    mkdirSync(target, { mode: 0o700 })
    const link = join(parent, 'control')
    symlinkSync(target, link)
    setSshControlDirForTests(link)

    assert.throws(() => controlSocketPath('dev-box'), /symbolic link\. Remove it and try again\./)
  })

  it('refuses an existing control directory whose mode is not 0700', posixOnly, (t) => {
    const dir = join(scratchParent(t), 'control')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    setSshControlDirForTests(dir)

    assert.throws(() => controlSocketPath('dev-box'), /mode is 755, not 700/)
  })

  it('refuses an existing control path that is not a directory', posixOnly, (t) => {
    const path = join(scratchParent(t), 'control')
    writeFileSync(path, '')
    setSshControlDirForTests(path)

    assert.throws(() => controlSocketPath('dev-box'), /not a directory/)
  })
})

describe('controlDirProblem', () => {
  const privateDir = {
    isSymbolicLink: (): boolean => false,
    isDirectory: (): boolean => true,
    uid: 501,
    mode: 0o40700,
  }

  it('accepts a private directory of the current user', () => {
    assert.equal(controlDirProblem(privateDir, 501), null)
  })

  it('refuses a directory owned by another user without telling this user to remove it', () => {
    const problem = controlDirProblem({ ...privateDir, uid: 0 }, 501) ?? ''
    assert.match(problem, /belongs to another account \(uid 0, not 501\)/)
    assert.match(problem, /administrator/)
    assert.doesNotMatch(problem, /Remove it and try again/)
  })

  it('names another account as the owner of a symbolic link it made', () => {
    const link = { ...privateDir, isSymbolicLink: (): boolean => true, uid: 0 }
    assert.match(controlDirProblem(link, 501) ?? '', /belongs to another account/)
  })
})
