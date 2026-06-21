import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearAllowedWorkspaceRootsForTest,
  registerAllowedWorkspaceRoot,
  setWorkspaceRootForTest,
} from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from '../services/subprocess-output-cap.ts'
import { gatewayReadFile, SANDBOX_FS_WORKER_STDOUT_MAX_BYTES } from './sandbox-fs-client.ts'

describe('sandbox-fs-client', () => {
  it('reads via direct fs when project sandbox is inactive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = registerAllowedWorkspaceRoot(dir)
      const restore = setWorkspaceRootForTest(root)
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8')
      const text = await gatewayReadFile(join(dir, 'a.txt'))
      assert.equal(text, 'hello')
      restore()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses a stdout budget above the default command output cap', () => {
    assert.ok(SANDBOX_FS_WORKER_STDOUT_MAX_BYTES > COMMAND_OUTPUT_MAX_BYTES)
  })

  it('parses worker-shaped JSON above the default stdout cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-big-'))
    const filePath = join(dir, 'big.txt')
    const content = 'x'.repeat(COMMAND_OUTPUT_MAX_BYTES + 1024)
    try {
      await writeFile(filePath, content, 'utf-8')

      const { stdout: capped, code: cappedCode } = await runCommand(
        process.execPath,
        [
          '-e',
          "const fsp=require('node:fs/promises');fsp.readFile(process.env.COPSE_TEST_FILE,'utf-8').then((d)=>process.stdout.write(JSON.stringify({ok:true,data:d})))",
        ],
        {
          env: { COPSE_TEST_FILE: filePath },
          unsandboxed: true,
        },
      )
      assert.equal(cappedCode, 0)
      assert.throws(() => JSON.parse(capped.trim()))
      assert.ok(capped.includes(COMMAND_OUTPUT_TRUNCATED_MARKER))

      const { stdout, code } = await runCommand(
        process.execPath,
        [
          '-e',
          "const fsp=require('node:fs/promises');fsp.readFile(process.env.COPSE_TEST_FILE,'utf-8').then((d)=>process.stdout.write(JSON.stringify({ok:true,data:d})))",
        ],
        {
          env: { COPSE_TEST_FILE: filePath },
          unsandboxed: true,
          stdoutMaxBytes: SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
        },
      )
      assert.equal(code, 0)
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; data: string }
      assert.equal(parsed.ok, true)
      assert.equal(parsed.data, content)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
