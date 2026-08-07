import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { MockLLMProvider } from '@copse/llm/mock-provider.ts'
import { defineTool } from '@shared/types'
import type { LLMMessage, StreamChunk } from '@shared/types'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import { createAcpTurnRunner } from './acp-app-entry.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'
import { requestApproval } from '../approval.ts'
import { ToolRegistry } from '../tool-registry.ts'

/** The assistant text the client received, reassembled from its stream chunks. */
function streamedText(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : [])).join('')
}

/**
 * The terminal update for one tool call.
 *
 * Selecting by id matters: an approval prompt reaches the client as its *own*
 * `tool_call_update` under a separate id (that is how a client renders a pending
 * permission), so "the first update" is the question, not the answer.
 */
function resultOf(chunks: readonly StreamChunk[], toolCallId: string): string | undefined {
  const update = chunks.find(
    (chunk) => chunk.type === 'tool_call_update' && chunk.toolCallId === toolCallId,
  )
  return update?.type === 'tool_call_update' && typeof update.result === 'string'
    ? update.result
    : undefined
}

/** The id of the single tool call the mock model was steered into making. */
function soleToolCallId(chunks: readonly StreamChunk[], name: string): string {
  const calls = chunks.filter((chunk) => chunk.type === 'tool_call' && chunk.toolCall.name === name)
  assert.equal(calls.length, 1, `expected exactly one ${name} call to reach the ACP client`)
  const call = calls[0]
  assert.ok(call?.type === 'tool_call')
  return call.toolCall.id
}

/**
 * Both ends of ACP, in the unit tier, with no API key.
 *
 * `acp-loopback.test.ts` already pins the *protocol* round trip, but with a stub
 * turn runner on the agent side — so nothing there proves Copse's own agent is
 * what an ACP client actually gets. This does: the far end is the real
 * {@link createAcpTurnRunner}, which drives the real `runAgent`, over the real
 * `ToolRegistry` and the real approval plumbing. The single fake is the model —
 * a {@link MockLLMProvider} injected through `runAgent`'s `provider` seam, the
 * same one the headless host and the bench harness use.
 *
 * So a turn crosses, in order: client `session/prompt` → ndjson → agent role →
 * agent loop → tool call → `requestApproval` → back out as
 * `session/request_permission` → client answer → tool result → chunk stream →
 * client `StreamChunk`s. Every layer is production code except the model.
 *
 * That makes this CI-runnable on every PR: no agent binary to install, no
 * `ANTHROPIC_API_KEY`, no Electron, no subprocess — just two in-memory byte
 * pipes. See `docs/testing-strategy.md` → "Testing ACP without a model key".
 */

/**
 * Stands in for any Copse tool that must ask before it acts (shell, MCP, web,
 * PII). Every one of those gates funnels through `requestApproval`, so calling
 * it directly is what puts the whole approval bridge under test — without
 * dragging a shell, a git repo, or the macOS sandbox into a unit test.
 */
const gatedProbeTool = defineTool({
  name: 'gated_probe',
  description: 'Test-only tool: asks the user for approval, then reports the answer.',
  parameters: z.object({ subject: z.string() }),
  async execute({ subject }) {
    const { approved } = await requestApproval({
      title: `Inspect ${subject}`,
      body: `probe ${subject}`,
      type: 'shell',
    })
    return approved ? `inspected ${subject}` : `declined ${subject}`
  },
})

/**
 * Serve `runner` as the ACP agent over a pair of in-memory byte pipes, and hand
 * the client end back through the pool's transport seam. Real ndjson framing and
 * real JSON-RPC — only the process boundary is elided.
 */
function inProcessAgentTransport(runner: AcpTurnRunner): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  return () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    const connection = buildAcpAgentApp(runner, { name: 'Copse' }).connect(
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    )
    return Promise.resolve({
      stream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
      dispose: (): void => {
        connection.close()
      },
    })
  }
}

describe('ACP agent mode: a real Copse turn, driven by Copse as the ACP client', () => {
  let workspace: string | null = null

  afterEach(async () => {
    await disposeAllAcpSessions()
    if (workspace) {
      await rm(workspace, { recursive: true, force: true })
      workspace = null
    }
  })

  it('runs the built-in agent loop for an ACP client on a mock model, with no API key', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'copse-acp-loopback-'))
    const root = workspace

    const registry = new ToolRegistry()
    registry.register(gatedProbeTool)

    // The ACP session's memory — the runner replaces it with each turn's result.
    const history: LLMMessage[] = []
    const runner = createAcpTurnRunner({
      registry,
      history,
      // A headless ACP process reads these from persisted app state; the test
      // supplies a scratch project instead of seeding storage.
      getActiveProjectId: () => 'acp-loopback-project',
      getProjectRoot: () => root,
      // The whole point: a complete turn with no provider credentials anywhere.
      runOptions: { provider: new MockLLMProvider(), contextWindow: 100_000 },
    })

    const { entry } = await acquireAcpSession({
      threadId: 'acp-loopback-thread',
      // `command` is never spawned — the transport below replaces that step.
      config: { command: 'copse --acp (in-process)', cwd: root },
      createTransport: inProcessAgentTransport(runner),
    })

    const chunks: StreamChunk[] = []
    const permissionTitles: string[] = []
    const handlers: AcpClientHandlers = {
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
      requestPermission: (req) => {
        permissionTitles.push(req.toolCall.title ?? '')
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'allow' } })
      },
    }
    entry.open.handlers.current = handlers

    // `[[mcp:<tool> {args}]]` is the mock provider's steering directive (it is
    // dead-code-eliminated from release builds), so the fake model makes a real,
    // named tool call instead of whatever it would otherwise improvise.
    const stop = await runAcpSessionPrompt(
      entry.open,
      '[[mcp:gated_probe {"subject":"the workspace"}]]',
      undefined,
    )

    assert.equal(stop.stopReason, 'end_turn')

    // The agent loop's tool call reached the client as an ACP tool call.
    const toolCallId = soleToolCallId(chunks, 'gated_probe')

    // Copse's approval gate crossed the protocol as session/request_permission,
    // and the client's answer came back far enough to change what the tool did.
    assert.deepEqual(permissionTitles, ['Inspect the workspace'])
    assert.equal(resultOf(chunks, toolCallId), 'inspected the workspace')

    // ...and the mock model's own words finished the turn on the client side.
    assert.match(streamedText(chunks), /Mock response/)

    // The session kept its transcript, which is what lets a follow-up prompt
    // continue the same conversation rather than replaying it.
    assert.ok(history.length > 0, 'the ACP session should retain the turn it just ran')
  })

  it('denying the client-side permission propagates back into the tool result', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'copse-acp-loopback-'))
    const root = workspace

    const registry = new ToolRegistry()
    registry.register(gatedProbeTool)

    const runner = createAcpTurnRunner({
      registry,
      history: [],
      getActiveProjectId: () => 'acp-loopback-project',
      getProjectRoot: () => root,
      runOptions: { provider: new MockLLMProvider(), contextWindow: 100_000 },
    })

    const { entry } = await acquireAcpSession({
      threadId: 'acp-loopback-deny',
      config: { command: 'copse --acp (in-process)', cwd: root },
      createTransport: inProcessAgentTransport(runner),
    })

    const chunks: StreamChunk[] = []
    const handlers: AcpClientHandlers = {
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    }
    entry.open.handlers.current = handlers

    await runAcpSessionPrompt(
      entry.open,
      '[[mcp:gated_probe {"subject":"the workspace"}]]',
      undefined,
    )

    assert.equal(
      resultOf(chunks, soleToolCallId(chunks, 'gated_probe')),
      'declined the workspace',
      'a refused ACP permission must reach the tool as a denial, not a silent allow',
    )
  })
})
