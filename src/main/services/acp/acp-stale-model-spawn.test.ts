import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { StreamChunk } from '@shared/types'
import { runAcpAgentFromSettings } from './acp-agent-service.ts'
import { disposeAllAcpSessions } from './acp-session-pool.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

/**
 * A thread's turn on a spawned agent (`tests/fixtures/stale-model-acp-agent.cjs`)
 * that no longer offers the thread's model. The thread is told once, on the
 * turn that opened the session, and the notice stays out of the history the
 * next fresh session is replayed: it is Copse's note to the user, not words
 * the agent said.
 */
let root = ''
afterEach(async () => {
  await disposeAllAcpSessions()
  setWorkspaceRootForTest(null)
  setSetting('registeredAcpAgents', [])
  if (root) await rm(root, { recursive: true, force: true })
})

describe('an ACP thread turn on a model the agent no longer offers', () => {
  it('tells the thread once and keeps the notice out of the agent’s history', async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-acp-stale-model-'))
    execFileSync('git', ['init', '--quiet', root])
    setWorkspaceRootForTest(root)
    setSetting('registeredAcpAgents', [
      {
        id: 'stale-model-fixture',
        title: 'Fixture agent',
        command: process.execPath,
        args: [resolve('tests/fixtures/stale-model-acp-agent.cjs')],
        enabled: true,
      },
    ])
    const turn = async (userPrompt: string): Promise<{ streamed: string; history: unknown }> => {
      const chunks: StreamChunk[] = []
      const result = await runAcpAgentFromSettings({
        threadId: 'stale-model-thread',
        agentId: 'stale-model-fixture',
        model: 'fixture-model-2',
        userPrompt,
        priorMessages: [],
        signal: AbortSignal.timeout(20_000),
        onChunk: (chunk) => chunks.push(chunk),
      })
      assert.equal(result.stopReason, 'end_turn')
      const streamed = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []))
      return { streamed: streamed.join(''), history: result.messages }
    }

    await runWithThreadExecutionContext(
      {
        projectId: 'stale-model',
        threadId: 'stale-model-thread',
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: 'main',
      },
      async () => {
        const first = await turn('Check the build.')
        assert.equal(
          first.streamed,
          "_This thread's model (**fixture-model-2**) is no longer offered by this agent — " +
            'continuing on **Fixture Model 3** instead. Pick another model in the footer._\n\n' +
            'The build passes on this model.',
        )
        assert.deepEqual(first.history, [
          { role: 'assistant', content: 'The build passes on this model.' },
        ])

        // Same thread, same pooled session, same stale pick: nothing more to say.
        const second = await turn('Run the tests.')
        assert.equal(second.streamed, 'The tests pass too.')
      },
    )
  })
})
