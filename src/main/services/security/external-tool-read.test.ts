import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createExternalToolReader } from './external-tool-read.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { setApprovalHandler } from '../approval.ts'
import {
  clearReadOutsideProjectGrants,
  grantReadOutsideProject,
  hasReadOutsideProjectGrant,
} from './read-outside-grant.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import type { RunCommandOptions } from '../exec/command-runner.ts'
import { resolveReadablePathWithinRoot } from '../workspace.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'

describe('external file tool approval', () => {
  let base = ''
  let root = ''
  let file = ''
  let prompts = 0
  let calls: RunCommandOptions[] = []
  let enabled = true
  let approve = true
  let remember = true
  let previousCopseDir: string | undefined
  let previousChatRoot: string | undefined
  const reader = createExternalToolReader({
    workerPath: () => join(root, 'worker.js'),
    sandboxEnabled: () => enabled,
    run: async (_command: string, _args: string[], options?: RunCommandOptions) => {
      calls.push(options ?? {})
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, data: 'fixture' }),
        stderr: '',
        stdoutTruncated: false,
      }
    },
  })
  const read = (thread = 'reader', target = file): Promise<string | null> =>
    runWithActiveRunIdentity(thread, () => reader(target, root, 'read_file', { kind: 'read' }))
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'external-approval-')))
    root = join(base, 'project')
    await mkdir(root)
    file = join(base, 'note.txt')
    await writeFile(file, 'fixture')
    previousCopseDir = process.env['COPSE_DIR']
    previousChatRoot = process.env['COPSE_WORKSPACE_DIR']
    prompts = 0
    calls = []
    enabled = true
    approve = true
    remember = true
    clearReadOutsideProjectGrants()
    setSetting('toolPermissionOverrides', {})
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.scope, 'external-read')
      assert.deepEqual(request.reasons, [file])
      return { approved: approve, remember }
    })
  })
  afterEach(async () => {
    setApprovalHandler(null)
    clearReadOutsideProjectGrants()
    setSetting('toolPermissionOverrides', {})
    if (previousCopseDir === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = previousCopseDir
    if (previousChatRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousChatRoot
    setSetting('threadReadAccess', [])
    await rm(base, { recursive: true, force: true })
  })
  it('approves the exact target and uses a read-only sandbox with network denied', async () => {
    assert.equal(await read(), 'fixture')
    assert.equal(prompts, 1)
    const [call] = calls
    assert.ok(call)
    assert.equal(call.requireSandbox, true)
    assert.notEqual(call.unsandboxed, true)
    const sandbox = call.sandboxConfig
    assert.ok(sandbox?.filesystem && sandbox.network)
    assert.deepEqual(sandbox.filesystem.allowWrite, [])
    assert.ok(sandbox.filesystem.allowRead?.includes(file))
    assert.deepEqual(sandbox.network.allowedDomains, [])
    assert.equal(await read(), 'fixture')
    assert.equal(prompts, 1)
    assert.equal(await read('another-thread'), 'fixture')
    assert.equal(prompts, 2)
  })
  it('does not execute or retain a grant after denial', async () => {
    approve = false
    await assert.rejects(read(), /declined/)
    assert.equal(calls.length, 0)
    assert.equal(hasReadOutsideProjectGrant('reader', [file]), false)
  })
  it('asks again after one-time approval', async () => {
    remember = false
    await read()
    await read()
    assert.equal(prompts, 2)
  })
  it('fails closed without the sandbox, including with a remembered grant', async () => {
    grantReadOutsideProject('reader', [file])
    enabled = false
    await assert.rejects(read(), /sandbox/)
    assert.equal(calls.length, 0)
    assert.equal(prompts, 0)
  })
  it('honors Always ask and Blocked despite a remembered grant', async () => {
    grantReadOutsideProject('reader', [file])
    setSetting('toolPermissionOverrides', { 'copse:read_file': 'ask' })
    await read()
    assert.equal(prompts, 1)
    setSetting('toolPermissionOverrides', { 'copse:read_file': 'block' })
    await assert.rejects(read(), /blocked/)
    assert.equal(calls.length, 1)
  })
  it('rejects credentials and aliases to credentials before prompting', async () => {
    const credential = join(base, '.env')
    await writeFile(credential, 'synthetic fixture')
    const alias = join(base, 'alias')
    await symlink(credential, alias)
    await assert.rejects(read('reader', credential), /credentials/)
    await assert.rejects(read('reader', alias), /credentials/)
    assert.equal(prompts, 0)
    assert.equal(calls.length, 0)
  })
  it('rejects a target replaced while approval is pending', async () => {
    setApprovalHandler(async () => {
      await rm(file)
      await symlink(join(base, 'replacement'), file)
      await writeFile(join(base, 'replacement'), 'other')
      return { approved: true, remember: true }
    })
    await assert.rejects(read(), /changed/)
    assert.equal(calls.length, 0)
    assert.equal(hasReadOutsideProjectGrant('reader', [file]), false)
  })
  it('does not reuse a parent grant for a symlink to an unapproved sibling', async () => {
    const directory = join(base, 'approved-directory')
    await mkdir(directory)
    const alias = join(directory, 'link.txt')
    await symlink(file, alias)
    grantReadOutsideProject('reader', [directory])
    approve = false
    await assert.rejects(read('reader', alias), /declined/)
    assert.equal(prompts, 1)
    assert.equal(calls.length, 0)
  })
  it('leaves workspace and relative-path resolution on the existing route', async () => {
    const local = join(root, 'local.txt')
    await writeFile(local, 'local')
    assert.equal(await read('reader', local), null)
    assert.equal(await read('reader', '../note.txt'), null)
    assert.equal(prompts, 0)
    assert.equal(calls.length, 0)
  })
  it('leaves project-checkout paths in a worktree turn to the worktree rebase', async () => {
    const worktree = join(base, 'worktree')
    await mkdir(worktree)
    await writeFile(join(root, 'shared.txt'), 'project checkout copy')
    await writeFile(join(worktree, 'shared.txt'), 'thread copy')
    const target = join(root, 'shared.txt')
    const context: ThreadExecutionContext = {
      projectId: 'project',
      threadId: 'reader',
      projectRoot: root,
      root: worktree,
      checkoutMode: 'worktree',
      branch: 'copse/reader',
    }
    const resolved = await runWithThreadExecutionContext(context, () =>
      runWithActiveRunIdentity('reader', async () => {
        assert.equal(await reader(target, worktree, 'read_file', { kind: 'read' }), null)
        return resolveReadablePathWithinRoot(target, worktree)
      }),
    )
    assert.equal(resolved, join(worktree, 'shared.txt'))
    assert.equal(prompts, 0)
    assert.equal(calls.length, 0)
  })
  it('preserves conversation denial even when an outside-path grant covers the store', async () => {
    const chat = join(base, 'chat-store')
    process.env['COPSE_WORKSPACE_DIR'] = chat
    const other = join(chat, 'project', 'other-thread', 'events.jsonl')
    await mkdir(join(chat, 'project', 'other-thread'), { recursive: true })
    await writeFile(other, 'synthetic conversation')
    grantReadOutsideProject('reader', [base])
    setSetting('threadReadAccess', [])
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.cause, 'thread-read-access')
      return { approved: false, remember: false }
    })
    assert.equal(await read('reader', other), null)
    await assert.rejects(
      runWithActiveRunIdentity('reader', () => resolveReadablePathWithinRoot(other, root)),
      /declined/,
    )
    assert.equal(prompts, 1)
    assert.equal(calls.length, 0)
  })
})
