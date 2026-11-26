import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { turnProfileInstructions, withProfileGuidance } from './agent-service.ts'
import { deleteSetting, setSetting } from './storage/settings.ts'
import { storageGet, storageSet } from './storage/storage.ts'
import { createThread } from './thread-store.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'

describe('withProfileGuidance', () => {
  const block = '## Profile instructions: Reviewer\n\nReview only.'

  it('appends the profile after Copse’s own guidance', async () => {
    const guidance = withProfileGuidance(async (tools) => `Copse tools: ${tools.join(',')}`, block)
    assert.equal(await guidance(['read_file']), `Copse tools: read_file\n\n${block}`)
  })

  it('sends the profile alone when Copse’s assembly has nothing for the turn', async () => {
    assert.equal(await withProfileGuidance(async () => undefined, block)([]), block)
  })

  it('leaves the guidance untouched without profile instructions', () => {
    const copse = async (): Promise<string> => 'Copse'
    assert.equal(withProfileGuidance(copse, ''), copse)
  })
})

describe('turnProfileInstructions', () => {
  it('reads the profile from the thread when main starts the turn without one', async () => {
    const previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    const root = await mkdtemp(join(tmpdir(), 'copse-profile-wake-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    const suffix = randomUUID()
    const projectId = `project-profile-${suffix}`
    const threadId = `thread-profile-${suffix}`
    const previousProjects = storageGet('projects')
    try {
      await setSetting('agentProfiles', [
        { id: 'reviewer', name: 'Reviewer', instructions: 'Never edit files.' },
      ])
      storageSet('projects', [{ id: projectId, path: root }])
      await createThread(projectId, {
        id: threadId,
        title: 'Profile wake',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 1,
        profileId: 'reviewer',
      })
      const context = {
        projectId,
        threadId,
        projectRoot: root,
        root,
        checkoutMode: 'shared' as const,
        branch: null,
      }
      const expected = '## Profile instructions: Reviewer\n\nNever edit files.'
      // A CI or long-task wake: no profile on the payload.
      assert.equal(
        await runWithThreadExecutionContext(context, () => turnProfileInstructions(threadId, {})),
        expected,
      )
      // The payload wins when the renderer sent one.
      assert.equal(
        await runWithThreadExecutionContext(context, () =>
          turnProfileInstructions(threadId, { profileId: 'gone' }),
        ),
        '',
      )
    } finally {
      await deleteSetting('agentProfiles')
      storageSet('projects', previousProjects)
      if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
      await rm(root, { recursive: true, force: true })
    }
  })
})
