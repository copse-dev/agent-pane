import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { externalReadRequestSchema } from '../../project-sandbox/external-read-worker.ts'
import { SANDBOX_FS_REQUEST_ENV } from '../../project-sandbox/sandbox-fs-client.ts'
import { runWithActiveRunIdentity, getActiveRunThread } from '../active-run-identity.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { createExternalToolReader } from '../security/external-tool-read.ts'
import {
  clearReadOutsideProjectGrants,
  grantReadOutsideProject,
} from '../security/read-outside-grant.ts'
import { setSetting } from '../storage/settings.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import type { RunCommandOptions } from '../exec/command-runner.ts'
import { createAcpFileReader } from './acp-file-access.ts'

describe('ACP file reads use native consent and scoped workers', () => {
  let base: string
  let root: string
  let file: string
  let enabled: boolean
  let approve: boolean
  let remember: boolean
  let answerHook: (() => void | Promise<void>) | undefined
  const calls: RunCommandOptions[] = []
  const prompts: ApprovalRequest[] = []
  const reader = createAcpFileReader(
    createExternalToolReader({
      workerPath: () => join(root, 'worker.js'),
      sandboxEnabled: () => enabled,
      run: async (_command, _args, opts) => {
        assert.ok(opts)
        calls.push(opts)
        const req = safeJsonParse(
          opts.env?.[SANDBOX_FS_REQUEST_ENV] ?? '',
          decodeWithSchema(externalReadRequestSchema),
        )
        assert.ok(req)
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, data: await readFile(req.path, 'utf8') }),
          stderr: '',
          stdoutTruncated: false,
        }
      },
    }),
  )
  const read = (
    path: string,
    line?: number,
    limit?: number,
    threadId = 'acp-reader',
    signal?: AbortSignal,
  ): ReturnType<typeof reader> =>
    runWithActiveRunIdentity(threadId, () =>
      runWithThreadExecutionContext(
        {
          projectId: 'acp-reader',
          threadId,
          root,
          projectRoot: root,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          reader(
            {
              sessionId: 'fixture-session',
              path,
              ...(line !== undefined ? { line } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
            root,
            signal,
          ),
      ),
    )

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'copse-acp-read-')))
    root = join(base, 'project')
    file = join(base, 'notes.txt')
    await mkdir(root)
    await writeFile(file, 'first\nsecond\nthird\n')
    await writeFile(join(root, 'local.txt'), 'local\n')
    enabled = true
    approve = true
    remember = true
    answerHook = undefined
    calls.length = 0
    prompts.length = 0
    clearReadOutsideProjectGrants()
    await setSetting('toolPermissionOverrides', {})
    setApprovalHandler(async (request) => {
      assert.equal(getActiveRunThread(), 'acp-reader')
      prompts.push(request)
      await answerHook?.()
      return { approved: approve, remember }
    })
  })
  afterEach(async () => {
    setApprovalHandler(null)
    clearReadOutsideProjectGrants()
    await setSetting('toolPermissionOverrides', {})
    await rm(base, { recursive: true, force: true })
  })

  it('uses the exact named read overlay, no writes/network, and raw ACP line ranges', async () => {
    assert.deepEqual(await read(file, 2, 1), { content: 'second' })
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.scope, 'external-read')
    assert.deepEqual(prompts[0].reasons, [file])
    const call = calls[0]
    assert.ok(call)
    assert.equal(call.requireSandbox, true)
    const sandbox = call.sandboxConfig
    assert.ok(sandbox)
    const fs = sandbox.filesystem
    assert.ok(fs)
    assert.deepEqual(fs.allowWrite, [])
    assert.deepEqual(sandbox.network?.allowedDomains, [])
    assert.ok(fs.allowRead)
    assert.ok(fs.allowRead.includes(file))
    assert.equal(fs.allowRead.includes(base), false)
    assert.deepEqual(await read(file), { content: 'first\nsecond\nthird\n' })
    assert.equal(prompts.length, 1)
  })

  it('keeps local reads on the workspace path without a worker or outside prompt', async () => {
    assert.deepEqual(await read('local.txt'), { content: 'local\n' })
    assert.equal(calls.length, 0)
    assert.equal(prompts.length, 0)
  })

  it('does not run the worker when outside consent is declined', async () => {
    approve = false
    await assert.rejects(read(file), /declined/)
    assert.equal(calls.length, 0)
  })

  it('respects Blocked before prompts or reads even with an outside grant', async () => {
    grantReadOutsideProject('acp-reader', [file])
    await setSetting('toolPermissionOverrides', { 'copse:read_file': 'block' })
    await assert.rejects(read(file), /Block.*tool permission settings/)
    assert.equal(calls.length, 0)
    assert.equal(prompts.length, 0)
  })

  it('asks on every native invocation and outside scope when read_file is Always ask', async () => {
    grantReadOutsideProject('acp-reader', [file])
    await setSetting('toolPermissionOverrides', { 'copse:read_file': 'ask' })
    await read(file)
    await read(file)
    assert.equal(prompts.filter((p) => p.scope === 'external-read').length, 2)
    assert.equal(prompts.length, 4)
  })

  it('does not reuse another thread grant or allow a sibling path', async () => {
    grantReadOutsideProject('different-thread', [file])
    await read(file)
    const sibling = join(base, 'sibling.txt')
    await writeFile(sibling, 'sibling')
    await read(sibling)
    assert.equal(prompts.length, 2)
  })

  it('refuses credential aliases and missing containment despite remembered grants', async () => {
    const secret = join(base, '.env')
    await writeFile(secret, 'secret')
    const alias = join(base, 'alias.txt')
    await symlink(secret, alias)
    await assert.rejects(read(alias), /credentials/)
    grantReadOutsideProject('acp-reader', [file])
    enabled = false
    await assert.rejects(read(file), /sandbox/)
    assert.equal(prompts.length, 0)
    assert.equal(calls.length, 0)
  })

  it('cancels a pending outside approval without reading any bytes', async () => {
    const controller = new AbortController()
    answerHook = (): void => {
      controller.abort()
    }
    await assert.rejects(read(file, undefined, undefined, 'acp-reader', controller.signal), {
      name: 'AbortError',
    })
    assert.equal(calls.length, 0)
  })

  it('rechecks a Blocked policy and path identity after outside approval', async () => {
    answerHook = (): Promise<void> =>
      setSetting('toolPermissionOverrides', { 'copse:read_file': 'block' })
    await assert.rejects(read(file), /blocked/)
    assert.equal(calls.length, 0)
    await setSetting('toolPermissionOverrides', {})
    answerHook = async (): Promise<void> => {
      await rm(file)
      await writeFile(file, 'replacement')
    }
    await assert.rejects(read(file), /target changed/)
    assert.equal(calls.length, 0)
  })
})
