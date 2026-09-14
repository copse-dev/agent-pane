import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { augmentPathForGuiLaunch, toolProbePath } from './launch-path.ts'

describe('launcher-controlled PATH', () => {
  it('preserves the complete supplied environment and path order when enabled', () => {
    const env = {
      COPSE_PRESERVE_PATH: '1',
      PATH: '/Volumes/Dev Disk/toolchains/bin:/usr/bin:/bin',
      HOME: '/Users/example',
      SHELL: '/bin/zsh',
    }
    const before = { ...env }
    augmentPathForGuiLaunch(env, 'darwin', '/Users/example')
    assert.deepEqual(env, before)
    assert.equal(toolProbePath(env, 'darwin'), before.PATH)
  })

  it('does not invent a PATH when the controlled environment omitted it', () => {
    const env = { COPSE_PRESERVE_PATH: '1' }
    augmentPathForGuiLaunch(env, 'darwin', '/Users/example')
    assert.equal(Object.hasOwn(env, 'PATH'), false)
    assert.equal(toolProbePath(env, 'darwin'), '')
  })

  it('preserves Windows Path casing and separators', () => {
    const env = { COPSE_PRESERVE_PATH: '1', Path: 'E:\\Kit\\bin;C:\\Windows\\System32' }
    augmentPathForGuiLaunch(env, 'win32', 'C:\\Users\\example')
    assert.deepEqual(env, { COPSE_PRESERVE_PATH: '1', Path: 'E:\\Kit\\bin;C:\\Windows\\System32' })
  })

  it('retains the ordinary GUI and probe defaults when not opted in', () => {
    for (const flag of [undefined, '', '0', 'true']) {
      const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/custom/bin' }
      if (flag !== undefined) env['COPSE_PRESERVE_PATH'] = flag
      augmentPathForGuiLaunch(env, 'darwin', '/Users/example')
      assert.equal(
        env['PATH'],
        '/opt/homebrew/bin:/usr/local/bin:/Users/example/.local/bin:/Users/example/.vera/bin:/bin:/usr/bin:/custom/bin',
      )
      assert.equal(toolProbePath(env, 'darwin'), `/usr/bin:/bin:/exec-daemon:${env['PATH'] ?? ''}`)
      const once = env['PATH']
      augmentPathForGuiLaunch(env, 'darwin', '/Users/example')
      assert.equal(env['PATH'], once)
    }
  })

  it(
    'makes check-node use the supplied Node without loading host nvm',
    { skip: process.platform === 'win32' },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'copse-launch-path-'))
      try {
        const nvm = join(root, 'host nvm')
        mkdirSync(nvm)
        // An ordinary make invocation must reach this sentinel; an opted-in
        // launch must not source any host nvm file at all.
        writeFileSync(join(nvm, 'nvm.sh'), 'exit 97\n')
        const makefile = fileURLToPath(new URL('../../Makefile', import.meta.url))
        const env: NodeJS.ProcessEnv = {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          COPSE_PRESERVE_PATH: '1',
        }
        const run = (): SpawnSyncReturns<string> =>
          spawnSync('make', ['-f', makefile, 'check-node', `NVM_DIR=${nvm}`], {
            cwd: root,
            env,
            encoding: 'utf8',
            timeout: 10_000,
          })
        const preserved = run()
        assert.equal(preserved.status, 0, preserved.stderr)
        env['COPSE_PRESERVE_PATH'] = '0'
        const ordinary = run()
        assert.notEqual(ordinary.status, 0)
        assert.match(ordinary.stderr, /97/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
