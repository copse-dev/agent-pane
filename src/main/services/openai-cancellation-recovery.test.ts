import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abortAgent, runAgent } from './agent-service.ts'
import { setApiKey, deleteApiKey, getSetting, setSetting } from './storage/settings.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import {
  recordProviderKeyValidation,
  invalidateProviderKeyStatus,
} from './providers/provider-key-status.ts'
import { ToolRegistry } from './tool-registry.ts'
import type { StreamChunk } from '@shared/types'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { openAiAgentStateSchema } from './remote/openai-agents-api.ts'
import { z } from 'zod'

for (const endpoint of ['/turns', '/session', '/items', '/artifacts']) {
  it(`reports post-cancellation ${endpoint} failure through the agent host`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-cancel-recovery-'))
    const repo = join(root, 'repo')
    await mkdir(repo)
    execFileSync('git', ['init', '-b', 'feature'], { cwd: repo })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: repo },
    )
    const originalRead = fs.readFile
    const workerMock = mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) =>
      typeof args[0] === 'string' && args[0].endsWith('openai-git-worker.cjs')
        ? Promise.resolve(Buffer.from('// hosted helper fixture'))
        : originalRead(...args),
    )
    const previousRoot = process.env['COPSE_WORKSPACE_DIR']
    const previousModel = getSetting('model', 'auto:balanced')
    const previousKey = process.env['OPENAI_API_KEY']
    process.env['COPSE_WORKSPACE_DIR'] = root
    delete process.env['OPENAI_API_KEY']
    setApiKey('openai', 'mock-key')
    recordProviderKeyValidation('openai', 'mock-key', true)
    await setSetting('model', 'remote-agent:openai#gpt-6.1-sol')
    const chunks: StreamChunk[] = []
    let submitted = false
    let cancelled = false
    let confirmed = false
    const page = (data: unknown[]): Response =>
      Response.json({ data, has_more: false, last_id: null })
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      assert.equal(url.origin, 'https://api.openai.com')
      if (url.pathname === '/v1/files') return Response.json({ id: 'source' })
      if (url.pathname === '/v1/files/source') return Response.json({ deleted: true })
      if (url.pathname === '/v1/agents/environments/env')
        return Response.json({ status: 'connected' })
      if (confirmed && url.pathname.endsWith(endpoint)) return new Response('', { status: 503 })
      if (url.pathname.endsWith('/events')) {
        if (init?.method === 'GET') return new Response('')
        if (typeof init?.body === 'string' && init.body.includes('input.cancel')) cancelled = true
        else {
          submitted = true
          abortAgent('thread')
        }
        return new Response(null, { status: 202 })
      }
      if (url.pathname.endsWith('/turns'))
        return page(
          submitted
            ? [
                {
                  id: 'turn',
                  status: cancelled ? 'cancelled' : 'in_progress',
                  subagent_id: null,
                  error: null,
                },
              ]
            : [],
        )
      if (url.pathname.endsWith('/items') || url.pathname.endsWith('/artifacts')) return page([])
      if (cancelled) confirmed = true
      return Response.json({
        id: 'session',
        status: 'idle',
        usage: null,
        environment: { id: 'env' },
      })
    }
    const fetchMock = mock.method(globalThis, 'fetch', fetchImpl)
    try {
      await runWithThreadExecutionContext(
        {
          projectId: 'project',
          threadId: 'thread',
          projectRoot: repo,
          root: repo,
          checkoutMode: 'shared',
          branch: null,
        },
        () =>
          runWithActiveRunIdentity('thread', () =>
            runAgent(
              'thread',
              'task',
              [],
              { emit: (_threadId, chunk) => chunks.push(chunk) },
              new ToolRegistry(),
            ),
          ),
      )
      assert.ok(confirmed)
      assert.ok(
        chunks.some(
          (chunk) =>
            chunk.type === 'text' &&
            /cancellation was confirmed.*could not be recovered/.test(chunk.text),
        ),
      )
      assert.ok(!chunks.some((chunk) => chunk.type === 'done' && chunk.stopReason === 'CANCELLED'))
      const checkpoint = safeJsonParse(
        await readFile(join(root, 'project', 'thread', 'openai-agent-session.json'), 'utf8'),
        decodeWithSchema(z.object({ state: openAiAgentStateSchema })),
      )
      assert.equal(checkpoint?.state.pending?.prompt.includes('task'), true)
    } finally {
      fetchMock.mock.restore()
      workerMock.mock.restore()
      deleteApiKey('openai')
      invalidateProviderKeyStatus('openai')
      await setSetting('model', previousModel)
      if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY']
      else process.env['OPENAI_API_KEY'] = previousKey
      await rm(root, { recursive: true, force: true })
    }
  })
}
