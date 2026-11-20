import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  formatArgvForShell,
  resolveSandboxShellExecutable,
  setProjectSandboxEnabled,
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

  it('drops every empty or relative entry wherever it sits', () => {
    for (const entry of ['', '.', 'bin', './x']) {
      for (const path of [
        `${entry}:/usr/bin:/bin`,
        `/usr/bin:${entry}:/bin`,
        `/usr/bin:/bin:${entry}`,
      ]) {
        assert.equal(withSandboxShellPath({ PATH: path })['PATH'], '/usr/bin:/bin', path)
      }
    }
  })

  it('keeps the absolute entries in their original order', () => {
    const env = withSandboxShellPath({
      PATH: ':/opt/b/bin:bin:/bin:.::/opt/a/bin:./x:/usr/bin:/opt/b/bin:',
    })
    assert.equal(env['PATH'], '/opt/b/bin:/bin:/opt/a/bin:/usr/bin:/opt/b/bin')
  })
})

describe('the sandbox wrapper shell environment', { skip: process.platform === 'win32' }, () => {
  it('starts the native shell wrapper with only absolute PATH entries', async (t) => {
    t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    // Stands in for ASRT: the wrapper prints the PATH it was spawned with.
    t.mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
      Promise.resolve({ argv: ['bash', '-c', 'printf %s "$PATH"'], env: { ...process.env } }),
    )
    const cwd = await mkdtemp(join(tmpdir(), 'copse-wrapper-path-'))
    setProjectSandboxEnabled(true)
    try {
      const child = await spawnShellInProjectSandbox('true', {
        cwd,
        env: { PATH: 'bin::/opt/tools/bin:.:/usr/bin:./x:/bin:' },
        stdio: 'pipe',
      })
      let output = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        output += chunk
      })
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.once('error', reject)
        child.once('close', resolveCode)
      })
      assert.equal(code, 0)
      assert.equal(output, '/opt/tools/bin:/usr/bin:/bin')
    } finally {
      setProjectSandboxEnabled(false)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('spawn environment overrides', () => {
  it('overlays caller variables without dropping the scrubbed base environment', async () => {
    const script =
      'process.stdout.write(JSON.stringify({ overlay: process.env.COPSE_TEST_OVERLAY, home: Boolean(process.env.HOME), path: Boolean(process.env.PATH) }))'
    const child = await spawnInProjectSandbox(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { COPSE_TEST_OVERLAY: 'present' },
      stdio: 'pipe',
      unsandboxed: true,
    })
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
    })
    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once('error', reject)
      child.once('close', resolveCode)
    })
    assert.equal(code, 0)
    assert.equal(output, '{"overlay":"present","home":true,"path":true}')
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
