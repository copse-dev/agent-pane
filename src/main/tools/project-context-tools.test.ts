import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchProjectContextTool, readProjectContextTool } from './project-context-tools.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { runWithApprovalHandler } from '../services/approval.ts'
import { createThread } from '../services/thread-store.ts'
import { storageGet, storageSet } from '../services/storage/storage.ts'
import { setSetting } from '../services/storage/settings.ts'
import { addKnowledgeNote, setKnowledgeRootForTest } from '../services/storage/knowledge-store.ts'
import { hasThreadAccess, revokeThreadAccess } from '../services/security/thread-access.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { OKF_MEMORIES_PLUGIN_ID } from '@copse/agent/plugins/okf-memories-plugin.ts'
import { normalizeToolExecuteResult } from '@shared/types'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { runWithAgentRunReadonly } from '../services/agent-run-readonly.ts'
import { ProjectContextReader } from '../services/project-context.ts'
import { turnIngestedExternalContent } from '../services/security/turn-taint.ts'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'

describe('project context tools at the native boundary', () => {
  let root: string
  let previousWorkspace: string | undefined
  let projects: unknown
  let activeProject: unknown
  let context: ThreadExecutionContext
  const signal = new AbortController().signal
  function inTurn<T>(run: () => T): T {
    return runWithThreadExecutionContext(context, () =>
      runWithActiveRunIdentity(context.threadId, run),
    )
  }
  async function search(
    args: Parameters<typeof searchProjectContextTool.execute>[0],
  ): Promise<string> {
    return normalizeToolExecuteResult(await searchProjectContextTool.execute(args, signal)).result
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-context-tools-'))
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
    setKnowledgeRootForTest(join(root, 'knowledge'))
    projects = storageGet('projects')
    activeProject = storageGet('activeProjectId')
    storageSet('projects', [
      { id: 'p', name: 'First', path: '/first' },
      { id: 'q', name: 'Second', path: '/second' },
    ])
    storageSet('activeProjectId', 'p')
    context = {
      projectId: 'p',
      threadId: 'own',
      projectRoot: '/first',
      root: '/first',
      checkoutMode: 'shared',
      branch: null,
    }
    for (const [project, id, content] of [
      ['p', 'own', 'needle own'],
      ['p', 'other', 'needle other'],
      ['q', 'foreign', 'needle FOREIGN'],
    ]) {
      assert.ok(project && id && content)
      await createThread(project, {
        id,
        title: id,
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [{ id: 'u', role: 'user', content, createdAt: 1, toolCalls: [] }],
      })
    }
    inTurn(() => addKnowledgeNote({ type: 'Memory', title: 'Saved fact', body: 'needle MEMORY' }))
  })
  afterEach(async () => {
    mock.restoreAll()
    setPermissionGateForTests(null)
    await setSetting('threadReadAccess', [])
    await setSetting('threadSendAccess', [])
    storageSet('projects', projects)
    storageSet('activeProjectId', activeProject)
    setKnowledgeRootForTest(null)
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    rmSync(root, { recursive: true, force: true })
  })

  it('fails closed outside a captured thread and never takes a project from tool arguments', async () => {
    assert.match(await search({ query: 'needle' }), /requires an active thread/)
    const args = searchProjectContextTool.parameters.parse({
      query: 'needle',
      scope: 'thread',
      projectId: 'q',
    })
    assert.doesNotMatch(await inTurn(() => search(args)), /FOREIGN/)
    assert.match(
      await runWithThreadExecutionContext(context, () =>
        runWithActiveRunIdentity('different', () => search(args)),
      ),
      /requires an active thread/,
    )
  })

  it('refuses cross-thread results without existing conversation consent', async () => {
    let prompts = 0
    const output = await runWithApprovalHandler(
      async () => {
        prompts++
        return { approved: false, remember: false }
      },
      () => inTurn(() => search({ query: 'needle', kinds: ['evidence'] })),
    )
    assert.equal(prompts, 1)
    assert.match(output, /not granted/)
    assert.doesNotMatch(output, /needle/)
  })

  it('captures ownership across a project switch during consent, without granting sending', async () => {
    const output = await runWithApprovalHandler(
      async () => {
        storageSet('activeProjectId', 'q')
        return { approved: true, remember: false }
      },
      () => inTurn(() => search({ query: 'needle' })),
    )
    assert.match(output, /needle other/)
    assert.match(output, /needle MEMORY/)
    assert.doesNotMatch(output, /FOREIGN/)
    assert.equal(hasThreadAccess('own', 'send'), false)
  })

  it('reads only the own chat without prompting and does not inherit another chat’s grant', async () => {
    let prompts = 0
    await setSetting('threadReadAccess', ['other'])
    await runWithApprovalHandler(
      async () => {
        prompts++
        return { approved: false, remember: false }
      },
      async () => {
        const output = await inTurn(() =>
          search({ query: 'needle', scope: 'thread', kinds: ['evidence'] }),
        )
        assert.match(output, /needle own/)
        assert.doesNotMatch(output, /needle other|FOREIGN/)
        assert.equal(prompts, 0)
        await inTurn(() => search({ query: 'needle', kinds: ['evidence'] }))
        assert.equal(prompts, 1)
      },
    )
  })

  it('keeps memory disable separate from evidence retrieval', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.disable(OKF_MEMORIES_PLUGIN_ID)
    const output = await runWithDefaultPluginRegistry(plugins, () =>
      inTurn(() => search({ query: 'needle', scope: 'thread' })),
    )
    assert.match(output, /needle own/)
    assert.match(output, /memories-disabled/)
    assert.doesNotMatch(output, /needle MEMORY/)
  })

  it('reads a memory search result without requesting conversation access', async () => {
    let prompts = 0
    await runWithApprovalHandler(
      async () => {
        prompts++
        return { approved: false, remember: false }
      },
      () =>
        inTurn(async () => {
          const output = await search({ query: 'needle', kinds: ['memory'] })
          const decoded = safeJsonParse(
            output,
            decodeWithSchema(
              z.object({
                results: z.array(z.object({ id: z.string(), revision: z.string() })),
              }),
            ),
          )
          const memory = decoded?.results[0]
          assert.ok(memory)
          const read = normalizeToolExecuteResult(
            await readProjectContextTool.execute(memory, signal),
          ).result
          assert.match(read, /needle MEMORY/)
          assert.equal(prompts, 0)
          assert.equal(hasThreadAccess('own', 'read'), false)
        }),
    )
  })

  it('discards a completed response when consent is revoked before delivery', async () => {
    await setSetting('threadReadAccess', ['own'])
    mock.method(ProjectContextReader.prototype, 'search', async () => {
      await revokeThreadAccess('own', 'read')
      return 'PRIVATE RESPONSE'
    })
    const output = await inTurn(() => search({ query: 'needle' }))
    assert.match(output, /permission was revoked/)
    assert.doesNotMatch(output, /PRIVATE/)
  })

  it('discards memory output when the master plugin is disabled before delivery', async () => {
    const plugins = createFirstPartyPluginRegistry()
    mock.method(ProjectContextReader.prototype, 'search', async () => {
      plugins.disable(OKF_MEMORIES_PLUGIN_ID)
      return 'PRIVATE MEMORY'
    })
    const output = await runWithDefaultPluginRegistry(plugins, () =>
      inTurn(() => search({ query: 'needle', kinds: ['memory'] })),
    )
    assert.match(output, /Memories were disabled/)
    assert.doesNotMatch(output, /PRIVATE/)
  })

  it('does not discard evidence-only output when memory is disabled during the read', async () => {
    const plugins = createFirstPartyPluginRegistry()
    mock.method(ProjectContextReader.prototype, 'search', async () => {
      plugins.disable(OKF_MEMORIES_PLUGIN_ID)
      return 'EVIDENCE'
    })
    const output = await runWithDefaultPluginRegistry(plugins, () =>
      inTurn(() => search({ query: 'needle', scope: 'thread', kinds: ['evidence'] })),
    )
    assert.equal(output, 'EVIDENCE')
  })

  it('registers both real tools and preserves read-only gates and external-content framing', async () => {
    const native = createRegistry()
    assert.ok(native.names().includes('search_project_context'))
    assert.ok(native.names().includes('read_project_context'))
    const registry = new ToolRegistry()
    registry.register(searchProjectContextTool)
    registry.register(readProjectContextTool)
    setPermissionGateForTests(async () => true)
    await inTurn(() =>
      runWithAgentRunReadonly(true, async () => {
        const output = normalizeToolExecuteResult(
          await registry.execute(
            'search_project_context',
            { query: 'needle', scope: 'thread' },
            signal,
          ),
        ).result
        assert.match(output, /needle own/)
        assert.match(output, /external/)
        assert.equal(turnIngestedExternalContent(), true)
      }),
    )
    setPermissionGateForTests(async () => false)
    const blocked = normalizeToolExecuteResult(
      await inTurn(() =>
        registry.execute('search_project_context', { query: 'needle', scope: 'thread' }, signal),
      ),
    ).result
    assert.doesNotMatch(blocked, /needle own/)
  })
})
