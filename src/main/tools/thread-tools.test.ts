import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThread, deleteProjectThread } from '../services/thread-store.ts'
import { runWithApprovalHandler } from '../services/approval.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import { setSetting } from '../services/storage/settings.ts'
import { listThreadsTool, sendThreadPromptTool } from './thread-tools.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import { hasThreadAccess } from '../services/security/thread-access.ts'
import { normalizeToolExecuteResult } from '@shared/types'

describe('conversation tools', () => {
  let root: string
  let previous: string | undefined
  let projects: unknown
  const signal = new AbortController().signal
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-thread-tools-'))
    previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    projects = storageGet('projects')
    storageSet('projects', [{ id: 'thread-tools-project', name: 'Project', path: '/repo' }])
    await createThread('thread-tools-project', {
      id: 'thread-tools-destination',
      title: 'Investigate build failures',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
  })
  afterEach(async () => {
    await setSetting('threadReadAccess', [])
    await setSetting('threadSendAccess', [])
    storageSet('projects', projects)
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  })

  it('withholds catalog contents when read access is declined', async () => {
    const result = await runWithApprovalHandler(
      async () => ({ approved: false, remember: false }),
      () =>
        runWithActiveRunIdentity('thread-tools-source', () => listThreadsTool.execute({}, signal)),
    )
    assert.doesNotMatch(normalizeToolExecuteResult(result).result, /Investigate build failures/)
  })

  it('searches the catalog after read approval without granting sending', async () => {
    const result = await runWithApprovalHandler(
      async () => ({ approved: true, remember: false }),
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          listThreadsTool.execute({ query: 'build' }, signal),
        ),
    )
    assert.match(normalizeToolExecuteResult(result).result, /Investigate build failures/)
    assert.equal(hasThreadAccess('thread-tools-source', 'send'), false)
  })

  it('asks separately to send and leaves the destination untouched on denial', async () => {
    await setSetting('threadReadAccess', ['thread-tools-source'])
    let title = ''
    const result = await runWithApprovalHandler(
      async (request) => {
        title = request.title
        return { approved: false, remember: false }
      },
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          sendThreadPromptTool.execute(
            {
              project_id: 'thread-tools-project',
              thread_id: 'thread-tools-destination',
              prompt: 'Check the build',
            },
            signal,
          ),
        ),
    )
    assert.equal(title, 'Send prompts to your other threads?')
    assert.match(normalizeToolExecuteResult(result).result, /not granted/)
    assert.equal(hasThreadAccess('thread-tools-source', 'send'), false)
  })

  it('does not request permission for self-targeted or missing destinations', async () => {
    await runWithApprovalHandler(
      async () => {
        assert.fail('should not prompt for an invalid destination')
      },
      () =>
        runWithActiveRunIdentity('thread-tools-destination', async () => {
          for (const thread_id of ['thread-tools-destination', 'missing']) {
            const result = await sendThreadPromptTool.execute(
              { project_id: 'thread-tools-project', thread_id, prompt: 'Check the build' },
              signal,
            )
            assert.match(normalizeToolExecuteResult(result).result, /different|unavailable/)
          }
        }),
    )
  })

  it('rechecks a destination deleted while send permission is pending', async () => {
    const result = await runWithApprovalHandler(
      async () => {
        await deleteProjectThread('thread-tools-project', 'thread-tools-destination')
        return { approved: true, remember: false }
      },
      () =>
        runWithActiveRunIdentity('thread-tools-source', () =>
          sendThreadPromptTool.execute(
            {
              project_id: 'thread-tools-project',
              thread_id: 'thread-tools-destination',
              prompt: 'Check the build',
            },
            signal,
          ),
        ),
    )
    assert.match(normalizeToolExecuteResult(result).result, /unavailable/)
  })
})
