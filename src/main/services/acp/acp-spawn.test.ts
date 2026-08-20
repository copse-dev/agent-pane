import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { StreamChunk } from '@shared/types'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * The ACP client against an agent it actually **spawned**.
 *
 * Every other ACP test injects an in-process transport through the pool's
 * `createTransport` seam, which is the right trade for protocol and turn
 * behaviour — but it steps over the process boundary entirely. `spawnAcpAgentProcess`,
 * the stdout→ndjson reader, the stderr tail and the exit-error path only run
 * when there is a real child, and CI has no ACP agent installed to be one.
 *
 * `tests/fixtures/mock-acp-agent.mjs` is that child: a scripted agent over the
 * bare SDK that answers from a fixed script, so this needs no agent binary, no
 * auth and no model key — just `node`.
 */

/** The fixture agent, spawned as `node tests/fixtures/mock-acp-agent.mjs`. */
const MOCK_AGENT = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')

function collectingHandlers(into: StreamChunk[], decision: 'allow' | 'reject'): AcpClientHandlers {
  return {
    onChunk: (chunk): void => {
      into.push(chunk)
    },
    requestPermission: () =>
      Promise.resolve({ outcome: { outcome: 'selected', optionId: decision } }),
  }
}

/** The assistant text the client received, reassembled from its stream chunks. */
function streamedText(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : [])).join('')
}

describe('ACP client against a spawned agent process', () => {
  afterEach(async () => {
    await disposeAllAcpSessions()
  })

  it('completes a turn over the child process stdio', async () => {
    const { entry } = await acquireAcpSession({
      threadId: 'acp-spawn-turn',
      config: { command: process.execPath, args: [MOCK_AGENT], cwd: process.cwd() },
    })

    const chunks: StreamChunk[] = []
    entry.open.handlers.current = collectingHandlers(chunks, 'allow')

    const stop = await runAcpSessionPrompt(entry.open, 'hello over stdio', undefined)

    assert.equal(stop.stopReason, 'end_turn')
    assert.equal(streamedText(chunks), 'echo:hello over stdio')
  })

  it('round-trips a permission request across the process boundary', async () => {
    const { entry } = await acquireAcpSession({
      threadId: 'acp-spawn-permission',
      config: { command: process.execPath, args: [MOCK_AGENT], cwd: process.cwd() },
    })

    const chunks: StreamChunk[] = []
    entry.open.handlers.current = collectingHandlers(chunks, 'reject')

    await runAcpSessionPrompt(entry.open, 'ask before deleting', undefined)

    // The agent reports back what the client answered, so this only reads
    // `reject` if the decision survived the full request/response round trip.
    assert.match(streamedText(chunks), /client answered reject/)
  })

  it('surfaces the child stderr when the agent dies mid-turn', async () => {
    const { entry } = await acquireAcpSession({
      threadId: 'acp-spawn-crash',
      config: { command: process.execPath, args: [MOCK_AGENT], cwd: process.cwd() },
    })

    const chunks: StreamChunk[] = []
    entry.open.handlers.current = collectingHandlers(chunks, 'allow')

    // A turn against a dead agent must fail loudly. Reporting a bare "closed"
    // would leave the user with a broken agent and no idea why — the child's
    // last words on stderr are usually the whole diagnosis.
    await assert.rejects(
      runAcpSessionPrompt(entry.open, 'please crash', undefined),
      /mock-acp-agent: exploding on request/,
    )
  })
})
