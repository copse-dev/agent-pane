import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, symlink, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearAllowedWorkspaceRootsForTest,
  registerAllowedWorkspaceRoot,
  resolveWorkspacePath,
  setWorkspaceRootForTest,
} from '../services/workspace.ts'
import { runCommand } from '../services/command-runner.ts'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from '../services/subprocess-output-cap.ts'
import {
  gatewayReadFile,
  gatewayWriteFile,
  SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
  gatewayListDir,
} from './sandbox-fs-client.ts'

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

  it('lists directories when the workspace root path contains spaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'copse-spaced-parent-'))
    const dir = join(parent, 'e research workspace')
    try {
      await mkdir(dir, { recursive: true })
      clearAllowedWorkspaceRootsForTest()
      const root = registerAllowedWorkspaceRoot(dir)
      const restore = setWorkspaceRootForTest(root)
      await writeFile(join(dir, 'visible.txt'), 'ok', 'utf-8')
      const dirents = await gatewayListDir(root)
      assert.ok(dirents.some((d) => d.name === 'visible.txt' && !d.isDir))
      restore()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
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

  it('gatewayWriteFile refuses to follow a dangling symlink that escapes the workspace (#578)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'copse-sbfs-esc-'))
    const outside = await mkdtemp(join(tmpdir(), 'copse-sbfs-out-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = registerAllowedWorkspaceRoot(ws)
      const restore = setWorkspaceRootForTest(root)
      // Dangling symlink: its target does not exist yet, so it slips past
      // resolveWorkspacePath's existing-prefix realpath and looks like a new file.
      const escapeTarget = join(outside, 'authorized_keys')
      await symlink(escapeTarget, join(root, 'deploy.conf'))
      const abs = resolveWorkspacePath('deploy.conf')
      // Without the write-target guard, the write would follow the symlink out
      // of the workspace and clobber `escapeTarget`.
      await assert.rejects(gatewayWriteFile(abs, 'pwned'), /symlink that escapes/)
      await assert.rejects(stat(escapeTarget), /ENOENT/)
      restore()
    } finally {
      await rm(ws, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('gatewayWriteFile writes a normal new file inside the workspace', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'copse-sbfs-ok-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = registerAllowedWorkspaceRoot(ws)
      const restore = setWorkspaceRootForTest(root)
      const abs = resolveWorkspacePath(join('sub', 'new.txt'))
      await gatewayWriteFile(abs, 'ok')
      assert.equal(await readFile(abs, 'utf-8'), 'ok')
      restore()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
