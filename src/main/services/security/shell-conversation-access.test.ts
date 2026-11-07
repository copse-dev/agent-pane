import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureShellCommandPermitted } from './permission-gate.ts'
import { clearReadOutsideProjectGrants, grantReadOutsideProject } from './read-outside-grant.ts'
import { hasThreadAccess, revokeThreadAccess } from './thread-access.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setApprovalHandler } from '../approval.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { setSetting } from '../storage/settings.ts'
import { drainWriteQueue } from '../storage/write-queue.ts'

async function withReadAlias(
  destination: 'other' | 'own' | 'outside',
  directory: boolean,
  check: (
    read: () => Promise<boolean>,
    prompts: string[],
    consent: (allow: boolean) => void,
  ) => Promise<void>,
): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'copse-shell-conversation-')))
  const root = join(base, 'repo')
  const chatRoot = join(base, 'chat')
  const targetDir =
    destination === 'outside'
      ? join(base, 'notes')
      : join(chatRoot, 'project', destination === 'own' ? 'source' : 'other')
  mkdirSync(root)
  mkdirSync(chatRoot)
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, 'events.jsonl')
  writeFileSync(target, 'synthetic conversation fixture')
  const alias = join(base, 'alias')
  symlinkSync(directory ? targetDir : target, alias, directory ? 'dir' : 'file')
  const operand = directory ? join(alias, 'events.jsonl') : alias
  const previousStore = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = chatRoot
  const restore = setWorkspaceRootForTest(root)
  const prompts: string[] = []
  let approved = false
  await setSetting('threadReadAccess', [])
  await setSetting('safetyClassifierEnabled', false)
  setApprovalHandler(async (request) => {
    prompts.push(request.cause ?? '')
    return { approved, remember: false }
  })
  grantReadOutsideProject('source', [alias])
  try {
    await runWithThreadExecutionContext(
      {
        projectId: 'project',
        threadId: 'source',
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('source', () =>
          check(
            () =>
              ensureShellCommandPermitted(`cat ${operand}`, {
                executionRoot: root,
                sandboxEnabled: true,
                autoRun: true,
              }),
            prompts,
            (allow) => {
              approved = allow
            },
          ),
        ),
    )
  } finally {
    setApprovalHandler(null)
    clearReadOutsideProjectGrants()
    await setSetting('threadReadAccess', [])
    await drainWriteQueue()
    restore()
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    rmSync(base, { recursive: true, force: true })
  }
}

for (const directory of [false, true]) {
  it(`requires conversation consent through an approved ${directory ? 'directory' : 'file'} symlink, including after revocation`, async () => {
    await withReadAlias('other', directory, async (read, prompts, consent) => {
      assert.equal(await read(), false)
      assert.deepEqual(prompts, ['thread-read-access'])
      assert.equal(hasThreadAccess('source', 'read'), false)
      consent(true)
      assert.equal(await read(), true)
      assert.equal(hasThreadAccess('source', 'read'), true)
      const count = prompts.length
      assert.equal(await read(), true)
      assert.equal(prompts.length, count, 'reuse the conversation grant')
      await revokeThreadAccess('source', 'read')
      assert.equal(hasThreadAccess('source', 'read'), false)
      consent(false)
      assert.equal(await read(), false)
      assert.equal(
        prompts.length,
        count + 1,
        'revocation requires fresh consent despite the outside-path grant',
      )
      assert.equal(hasThreadAccess('source', 'read'), false)
    })
  })
}

for (const destination of ['own', 'outside'] as const) {
  it(`keeps an approved symlink to ${destination === 'own' ? 'the source transcript' : 'ordinary notes'} readable without conversation consent`, async () => {
    await withReadAlias(destination, false, async (read, prompts) => {
      assert.equal(await read(), true)
      assert.deepEqual(prompts, [])
      assert.equal(hasThreadAccess('source', 'read'), false)
    })
  })
}
