import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { StreamChunk } from '@shared/types'
import { runAcpAgentFromSettings } from './acp-agent-service.ts'
import { disposeAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'
import { resolveAcpToolProvenance } from './acp-tool-provenance.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.ts'
import {
  requireThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../thread-execution-context.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const FIXTURE = resolve('tests/fixtures/acp-bridge-identity-agent.mjs')
const receiptSchema = z.object({
  attachedBy: z.enum(['new', 'resume', 'load']),
  historyLength: z.number(),
  processId: z.number(),
  prompt: z.string(),
  guidedServer: z.string(),
  mountedServers: z.array(z.string()),
  result: z
    .object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
    .nullable(),
})

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-bridge-identity-'))
  execFileSync('git', ['init', '--quiet', root])
  setWorkspaceRootForTest(root)
})
afterEach(async () => {
  await disposeAllAcpSessions()
  await setSetting('registeredAcpAgents', [])
  setWorkspaceRootForTest(null)
  await rm(root, { recursive: true, force: true })
})

async function turn(
  threadId: string,
  registry: ToolRegistry,
  executionRoot = root,
): Promise<z.infer<typeof receiptSchema>> {
  const chunks: StreamChunk[] = []
  const result = await runWithThreadExecutionContext(
    {
      projectId: 'identity-fixture',
      threadId,
      projectRoot: root,
      root: executionRoot,
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runAcpAgentFromSettings({
        threadId,
        agentId: 'identity-fixture',
        userPrompt: 'Read through the current native bridge.',
        priorMessages: [],
        registry,
        signal: AbortSignal.timeout(30_000),
        onChunk: (chunk) => chunks.push(chunk),
      }),
  )
  assert.equal(result.stopReason, 'end_turn')
  const shown = chunks.map((chunk) => (chunk.type === 'text' ? chunk.text : '')).join('')
  const payload = /identity:([^\n]*)/.exec(shown)?.[1]
  assert.ok(payload, shown)
  const receipt = safeJsonParse(payload, decodeWithSchema(receiptSchema))
  assert.ok(receipt, payload)
  return receipt
}

describe('trusted native bridge identity across ACP process recreation', () => {
  for (const method of ['resume', 'load'] as const) {
    it(`refreshes exact identity after ${method} while preserving history and native execution`, async () => {
      const calls: string[] = []
      const executionOwners: { projectId: string; threadId: string; root: string }[] = []
      const registry = new ToolRegistry()
      registry.register({
        name: 'read_file',
        description: 'Read fixture content',
        parameters: z.object({}),
        execute: () => {
          calls.push('read_file')
          const context = requireThreadExecutionContext()
          executionOwners.push({
            projectId: context.projectId,
            threadId: context.threadId,
            root: context.root,
          })
          return Promise.resolve('bridge contents')
        },
      })
      await setSetting('registeredAcpAgents', [
        {
          id: 'identity-fixture',
          title: 'Identity fixture',
          command: process.execPath,
          args: [
            FIXTURE,
            join(root, 'session.json'),
            ...(method === 'load' ? ['--load-only'] : []),
          ],
          enabled: true,
        },
      ])
      const first = await turn('identity-thread', registry)
      assert.equal(first.attachedBy, 'new')
      assert.equal(first.historyLength, 0)
      assert.deepEqual(first.mountedServers, [first.guidedServer])
      assert.deepEqual(first.result?.content, [{ type: 'text', text: 'bridge contents' }])

      assert.equal(await disposeAcpSession('identity-thread', { preserveForResume: true }), true)
      const executionRoot = method === 'load' ? join(root, 'worktree') : root
      if (method === 'load') await mkdir(executionRoot)
      const second = await turn('identity-thread', registry, executionRoot)
      assert.equal(second.attachedBy, method)
      assert.equal(second.historyLength, 1, 'provider history survived the process')
      assert.notEqual(second.processId, first.processId, 'a real replacement process ran')
      assert.notEqual(second.mountedServers[0], first.guidedServer, 'bridge identity rotated')
      assert.deepEqual(
        second.mountedServers,
        [second.guidedServer],
        'trusted guidance names the callable current bridge',
      )
      assert.match(second.prompt, /supersedes earlier Copse bridge identities/)
      assert.doesNotMatch(
        second.prompt,
        /Session notes:/,
        'conversation was reattached, not replayed',
      )
      assert.deepEqual(second.result?.content, [{ type: 'text', text: 'bridge contents' }])

      const third = await turn('identity-thread', registry, executionRoot)
      assert.equal(third.processId, second.processId, 'a warm follow-up reuses the process')
      assert.equal(third.historyLength, 2)
      assert.equal(third.guidedServer, second.guidedServer)
      assert.match(third.prompt, /supersedes earlier Copse bridge identities/)
      assert.deepEqual(third.result?.content, [{ type: 'text', text: 'bridge contents' }])
      assert.deepEqual(calls, ['read_file', 'read_file', 'read_file'])
      assert.deepEqual(
        executionOwners,
        [root, executionRoot, executionRoot].map((executionRoot) => ({
          projectId: 'identity-fixture',
          threadId: 'identity-thread',
          root: executionRoot,
        })),
        'every bridge call retains its owning project, thread and current execution root',
      )

      const offer = { server: second.guidedServer, tools: ['read_file'] }
      for (const foreign of ['copse', 'copse-foreign1', first.guidedServer]) {
        assert.notEqual(
          resolveAcpToolProvenance({ name: `mcp__${foreign}__read_file` }, [], offer).status,
          'bridged',
        )
      }
      assert.equal(
        resolveAcpToolProvenance({ name: `mcp__${second.guidedServer}__read_file` }, [], offer)
          .status,
        'bridged',
      )
    })
  }
})
