import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnPtyInProjectSandbox } from './project-sandbox/index.ts'
import { runReleaseSmokeTest } from './release-smoke.ts'

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
