import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { StreamChunk } from '@shared/types'
import { AcpTurnFailure, runAcpAgentFromSettings } from './acp-agent-service.ts'
import { disposeAllAcpSessions } from './acp-session-pool.ts'
import { classifyAcpAuthFailure, classifyAgentError } from '../agent-errors.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

/**
 * Claude's OAuth sign-in expired mid-turn (found dogfooding #4278). The CLI's
 * synthetic API-error message streamed as prose under its own message id, then
 * the prompt failed with a bare `-32000 Authentication required`. The streamed
 * prose never reached the failed turn's partial transcript, so the error notice
 * was glued onto it and the card said "not signed in" instead of "expired".
 *
 * This drives that exact sequence through a real spawned agent
 * (`tests/fixtures/mock-acp-agent.mjs`, `fail-auth-after:`).
 */

const MOCK_AGENT = resolve('tests/fixtures/mock-acp-agent.mjs')
const AGENT_ID = 'auth-expiry-fixture'
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-acp-auth-expired-'))
  execFileSync('git', ['init', '--quiet', root])
  setWorkspaceRootForTest(root)
  await setSetting('registeredAcpAgents', [
    {
      id: AGENT_ID,
      title: 'Auth expiry fixture',
      command: process.execPath,
      args: [MOCK_AGENT],
      enabled: true,
    },
  ])
})

afterEach(async () => {
  await disposeAllAcpSessions()
  setWorkspaceRootForTest(null)
  await setSetting('registeredAcpAgents', [])
  await rm(root, { recursive: true, force: true })
})

async function failedTurn(): Promise<{ failure: AcpTurnFailure; chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  const failure = await runWithThreadExecutionContext(
    {
      projectId: 'auth-expired',
      threadId: 'auth-expired-thread',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runAcpAgentFromSettings({
        threadId: 'auth-expired-thread',
        agentId: AGENT_ID,
        userPrompt: `fail-auth-after:${EXPIRED}`,
        priorMessages: [],
        signal: AbortSignal.timeout(30_000),
        onChunk: (chunk) => chunks.push(chunk),
        registry: new ToolRegistry(),
      }),
  ).then(
    () => assert.fail('the turn should fail'),
    (err: unknown) => err,
  )
  assert.ok(failure instanceof AcpTurnFailure, 'the turn fails as an ACP turn failure')
  return { failure, chunks }
}

describe('an ACP sign-in that expires mid-turn', () => {
  it('keeps the id-stamped prose the agent streamed before the failure', async () => {
    const { failure, chunks } = await failedTurn()
    // The thread was shown the agent's words as an id-stamped message…
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.type === 'acp_content' &&
          chunk.content.type === 'text' &&
          chunk.content.text === EXPIRED,
      ),
    )
    // …so the failure carries them too: history keeps them, and the notice
    // knows it follows streamed text.
    assert.equal(failure.partial.assistantText, EXPIRED)
    assert.equal(failure.partial.finalMessageText, EXPIRED)
  })

  it('reads the agent’s final message to call the sign-in expired', async () => {
    const { failure } = await failedTurn()
    const ctx = { acpAgentId: 'claude-acp', acpFinalMessage: failure.partial.finalMessageText }
    assert.equal(classifyAcpAuthFailure(failure, ctx), 'expired')
    const notice = classifyAgentError(failure, ctx)
    assert.match(notice, /^> \[!WARNING\]\n> \*\*Claude sign-in expired\*\*/)
    assert.match(notice, /ACP error -32000 \(Authentication required\): Authentication required/)
  })
})
