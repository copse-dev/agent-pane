import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnPtyInProjectSandbox } from './project-sandbox/index.ts'
import { decidePtySmokeAfterExit, runReleaseSmokeTest } from './release-smoke.ts'

async function ptySpawnAvailable(): Promise<boolean> {
  const shell = process.env['SHELL'] || '/bin/bash'
  try {
    const child = await spawnPtyInProjectSandbox(shell, {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      unsandboxed: true,
    })
    child.kill()
    return true
  } catch {
    return false
  }
}

describe('decidePtySmokeAfterExit', () => {
  const marker = 'copse-release-smoke-pty'

  it('resolves when the marker already arrived', () => {
    assert.deepEqual(decidePtySmokeAfterExit({ output: `ok ${marker}\n`, marker, exitCode: 0 }), {
      action: 'resolve',
    })
  })

  it('rejects on non-zero exit without a marker', () => {
    assert.deepEqual(decidePtySmokeAfterExit({ output: '', marker, exitCode: 1 }), {
      action: 'reject',
      message: 'Packaged PTY smoke test exited 1',
    })
  })

  it('waits on clean exit without a marker (late onData race)', () => {
    assert.deepEqual(decidePtySmokeAfterExit({ output: '', marker, exitCode: 0 }), {
      action: 'wait',
    })
  })
})

describe('runReleaseSmokeTest', () => {
  let workspaceDir: string | undefined
  let previousWorkspaceDir: string | undefined

  afterEach(() => {
    if (workspaceDir) {
      rmSync(workspaceDir, { recursive: true, force: true })
      workspaceDir = undefined
    }
    if (previousWorkspaceDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspaceDir
  })

  it('exercises PTY output and thread persistence', async (t) => {
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    previousWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']
    workspaceDir = mkdtempSync(join(tmpdir(), 'copse-release-smoke-'))
    process.env['COPSE_WORKSPACE_DIR'] = workspaceDir

    await assert.doesNotReject(() => runReleaseSmokeTest())
  })
})
