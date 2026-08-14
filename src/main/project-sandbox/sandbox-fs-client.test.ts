import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, symlink, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  clearAllowedWorkspaceRootsForTest,
  registerAllowedWorkspaceRoot,
  resolvePathWithinRoot,
  resolveWorkspacePath,
  setWorkspaceRootForTest,
} from '../services/workspace.ts'
import { runCommand } from '../services/exec/command-runner.ts'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from '../services/exec/subprocess-output-cap.ts'
import {
  gatewayReadFile,
  gatewayWriteFile,
  SANDBOX_FS_WORKER_STDOUT_MAX_BYTES,
  gatewayListDir,
  setSandboxFsGatewayEnabledForTest,
  setSandboxFsOneShotInvokerForTest,
} from './sandbox-fs-client.ts'
import { setWorkerSpawnerForTest, shutdownSandboxFsServer } from './sandbox-fs-server.ts'

describe('sandbox-fs-client', () => {
  afterEach(() => {
    setSandboxFsGatewayEnabledForTest(null)
    setSandboxFsOneShotInvokerForTest(null)
    setWorkerSpawnerForTest(null)
    shutdownSandboxFsServer()
  })

  it('reads via direct fs when project sandbox is inactive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = await registerAllowedWorkspaceRoot(dir)
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
      const root = await registerAllowedWorkspaceRoot(dir)
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
      const parsed = expectRecord(parseJsonUnknown(stdout.trim()))
      assert.equal(parsed['ok'], true)
      assert.equal(parsed['data'], content)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gatewayWriteFile refuses to follow a dangling symlink that escapes the workspace (#578)', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'copse-sbfs-esc-'))
    const outside = await mkdtemp(join(tmpdir(), 'copse-sbfs-out-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = await registerAllowedWorkspaceRoot(ws)
      const restore = setWorkspaceRootForTest(root)
      // Dangling symlink: its target does not exist yet, so it slips past
      // resolveWorkspacePath's existing-prefix realpath and looks like a new file.
      const escapeTarget = join(outside, 'authorized_keys')
      await symlink(escapeTarget, join(root, 'deploy.conf'))
      const abs = await resolveWorkspacePath('deploy.conf')
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
      const root = await registerAllowedWorkspaceRoot(ws)
      const restore = setWorkspaceRootForTest(root)
      const abs = await resolveWorkspacePath(join('sub', 'new.txt'))
      await gatewayWriteFile(abs, 'ok')
      assert.equal(await readFile(abs, 'utf-8'), 'ok')
      restore()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('routes sandboxed writes through a one-shot worker, not the persistent read server', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'copse-sbfs-sandbox-write-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = await registerAllowedWorkspaceRoot(ws)
      const restore = setWorkspaceRootForTest(root)
      const abs = await resolveWorkspacePath(join('sub', 'new.txt'))
      let serverSpawned = false
      let oneShotCalled = false
      setSandboxFsGatewayEnabledForTest(true)
      setWorkerSpawnerForTest(() => {
        serverSpawned = true
        return Promise.reject(new Error('persistent server must not handle writes'))
      })
      setSandboxFsOneShotInvokerForTest(async (request, requestedRoot) => {
        oneShotCalled = true
        assert.equal(request['op'], 'writeFile')
        assert.equal(requestedRoot, undefined)
        await mkdir(join(root, 'sub'), { recursive: true })
        await writeFile(abs, String(request['content']), 'utf-8')
        return { ok: true }
      })

      await gatewayWriteFile(abs, 'ok')

      assert.equal(await readFile(abs, 'utf-8'), 'ok')
      assert.equal(oneShotCalled, true)
      assert.equal(serverSpawned, false)
      restore()
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })

  it('uses an explicit task root instead of the active project root', async () => {
    const project = await mkdtemp(join(tmpdir(), 'copse-sbfs-project-'))
    const taskRoot = await mkdtemp(join(tmpdir(), 'copse-sbfs-task-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const projectRoot = await registerAllowedWorkspaceRoot(project)
      const restore = setWorkspaceRootForTest(projectRoot)
      await writeFile(join(projectRoot, 'same.txt'), 'project', 'utf-8')
      await writeFile(join(taskRoot, 'same.txt'), 'task', 'utf-8')

      const taskFile = await resolvePathWithinRoot('same.txt', taskRoot)
      assert.equal(await gatewayReadFile(taskFile, taskRoot), 'task')
      await gatewayWriteFile(taskFile, 'task edited', taskRoot)
      assert.equal(await readFile(taskFile, 'utf-8'), 'task edited')
      assert.equal(await readFile(join(projectRoot, 'same.txt'), 'utf-8'), 'project')
      restore()
    } finally {
      await rm(project, { recursive: true, force: true })
      await rm(taskRoot, { recursive: true, force: true })
    }
  })

  // Regression: `scripts/dev.mts` never emitted `dist/main/sandbox-fs-worker.js`,
  // so a `dist/` built only by `npm run dev` failed every sandboxed fs call with a
  // MODULE_NOT_FOUND printed by a doomed child process. This runs with the real
  // spawn paths (no invoker or spawner stub) and no worker bundle beside the test
  // bundle, which is exactly that state: it must fail naming the missing build,
  // and it must fail before launching anything.
  it('names the missing worker bundle instead of spawning a doomed process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-nobundle-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = await registerAllowedWorkspaceRoot(dir)
      const restore = setWorkspaceRootForTest(root)
      setSandboxFsGatewayEnabledForTest(true)

      await assert.rejects(gatewayListDir(root), (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /sandbox fs worker bundle is missing/)
        assert.match(err.message, /npm run build/)
        assert.match(err.message, /sandbox-fs-worker\.js/)
        return true
      })
      restore()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
