import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  formatArgvForShell,
  resolveSandboxShellExecutable,
  shellForSandboxWrap,
  spawnInProjectSandbox,
  spawnShellInProjectSandbox,
  withSandboxShellPath,
} from './spawn.ts'
import { isSpawnableWorkingDirectory } from './spawn-cwd.ts'

describe('formatArgvForShell', () => {
  it('keeps workspace and Electron paths with spaces as single shell words', () => {
    const exec = '/Users/me/debugging/e research/agent-pane/node_modules/electron/dist/Electron'
    const worker = '/Users/me/debugging/e research/agent-pane/dist/main/sandbox-fs-worker.js'
    const command = formatArgvForShell(exec, [worker])
    assert.match(command, /^'\/Users\/me\/debugging\/e research\/agent-pane/)
  })

  it('quotes only executable and worker paths (request travels via env when sandboxed)', () => {
    const exec = '/tmp/e research/Electron'
    const worker = '/tmp/e research/sandbox-fs-worker.js'
    const command = formatArgvForShell(exec, [worker])
    assert.equal(command.includes('statDir'), false)
    assert.equal(command, `'${exec}' '${worker}'`)
  })

  it('runs a spaced executable path under bash -c without splitting on spaces', () => {
    const dir = '/tmp/copse spaced spawn test'
    const execPath = `${dir}/fake-electron`
    const workerPath = `${dir}/worker.js`
    const command = formatArgvForShell(execPath, [workerPath])
    const script = [
      `mkdir -p ${JSON.stringify(dir)}`,
      `printf '#!/bin/sh\\necho OK\\n' > ${JSON.stringify(execPath)}`,
      `chmod +x ${JSON.stringify(execPath)}`,
      `touch ${JSON.stringify(workerPath)}`,
      command,
    ].join('; ')
    const out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).trim()
    assert.equal(out, 'OK')
  })
})

describe('shellForSandboxWrap', () => {
  it('uses a PATH-resolvable shell name for absolute macOS shell paths', () => {
    const originalPath = process.env['PATH']
    process.env['PATH'] = '/custom/bin'
    try {
      assert.equal(shellForSandboxWrap('/bin/bash'), 'bash')
      assert.match(process.env['PATH'] ?? '', /(?:^|:)\/bin(?::|$)/)
      assert.match(process.env['PATH'] ?? '', /(?:^|:)\/usr\/bin(?::|$)/)
    } finally {
      process.env['PATH'] = originalPath
    }
  })
})

describe('resolveSandboxShellExecutable', () => {
  it('rewrites bare bash/sh to absolute paths so GUI Electron PATH cannot ENOENT', () => {
    assert.equal(resolveSandboxShellExecutable('bash'), '/bin/bash')
    assert.equal(resolveSandboxShellExecutable('sh'), '/bin/sh')
    assert.equal(resolveSandboxShellExecutable('/bin/bash'), '/bin/bash')
  })
})

describe('withSandboxShellPath', () => {
  it('prepends /bin and /usr/bin when missing from a snapshotted child env', () => {
    const env = withSandboxShellPath({ PATH: '/custom/bin', HOME: '/tmp' })
    assert.match(env['PATH'] ?? '', /^\/usr\/bin:\/bin:\/custom\/bin$/)
    assert.equal(env['HOME'], '/tmp')
  })
})

describe('isSpawnableWorkingDirectory', () => {
  it('accepts an existing directory and rejects a deleted one or a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-spawn-cwd-'))
    try {
      assert.equal(await isSpawnableWorkingDirectory(dir), true)
      assert.equal(await isSpawnableWorkingDirectory(join(dir, 'missing')), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    assert.equal(await isSpawnableWorkingDirectory(dir), false)
  })

  it('treats an empty cwd as inheriting this process directory', async () => {
    assert.equal(await isSpawnableWorkingDirectory(''), true)
  })
})

describe('spawning into a deleted working directory', () => {
  /** A path that certainly existed and certainly does not now. */
  async function deletedDirectory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'copse-missing-cwd-'))
    await rm(dir, { recursive: true, force: true })
    return dir
  }

  it('names the missing directory instead of libuv "spawn <shell> ENOENT"', async () => {
    const missing = await deletedDirectory()
    await assert.rejects(
      spawnInProjectSandbox(process.execPath, ['-e', ''], { cwd: missing, stdio: 'pipe' }),
      (err: Error) => {
        assert.match(err.message, /Working directory no longer exists/)
        assert.ok(err.message.includes(missing))
        assert.doesNotMatch(err.message, /ENOENT/)
        return true
      },
    )
  })

  it('fails the same way for a shell command line', async () => {
    const missing = await deletedDirectory()
    await assert.rejects(
      spawnShellInProjectSandbox('echo hi', { cwd: missing, stdio: 'pipe' }),
      /Working directory no longer exists/,
    )
  })
})
