import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { StreamChunk } from '@shared/types'
import { ACP_COPSE_TOOLS_PROMPT_NOTE, runAcpAgentFromSettings } from './acp-agent-service.ts'
import {
  ACP_BRIDGE_MOUNT_WAIT_MS,
  ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE,
  isAcpBridgeStartupFailure,
} from './acp-bridge-mount.ts'
import { disposeAllAcpSessions } from './acp-session-pool.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

/**
 * #4144: Copse offered its native-tool bridge, but an ACP agent has those tools
 * only once it lists them. These turns run the real path (settings → session
 * pool → spawned agent → bridge) against `tests/fixtures/mock-acp-agent.mjs`,
 * which advertises `mcpCapabilities.http` and, depending on its flags, lists
 * the bridge's tools, never does, or reports it failed the way Claude Agent
 * ACP does when the client has no notice capability.
 */

const MOCK_AGENT = resolve('tests/fixtures/mock-acp-agent.mjs')
const AGENT_TITLE = 'Bridge fixture agent'
const UNAVAILABLE = /Copse's tools aren't available to Bridge fixture agent in this session/
const CLAUDE_FALLBACK = /Run \/mcp for the error/

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-acp-bridge-mount-'))
  execFileSync('git', ['init', '--quiet', root])
  setWorkspaceRootForTest(root)
})

afterEach(async () => {
  await disposeAllAcpSessions()
  setWorkspaceRootForTest(null)
  await setSetting('registeredAcpAgents', [])
  await rm(root, { recursive: true, force: true })
})

function registryWithOneBridgedTool(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: z.object({}),
    execute: () => Promise.resolve('contents'),
  })
  return registry
}

async function useFixtureAgent(flags: string[]): Promise<void> {
  await setSetting('registeredAcpAgents', [
    {
      id: 'bridge-fixture',
      title: AGENT_TITLE,
      command: process.execPath,
      args: [MOCK_AGENT, ...flags],
      enabled: true,
    },
  ])
}

/** One turn; returns what the thread was shown and the prompt the agent received. */
async function turn(
  threadId: string,
  registry: ToolRegistry,
): Promise<{ shown: string; prompt: string }> {
  const chunks: StreamChunk[] = []
  const result = await runWithThreadExecutionContext(
    {
      projectId: 'bridge-mount',
      threadId,
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runAcpAgentFromSettings({
        threadId,
        agentId: 'bridge-fixture',
        userPrompt: 'echo-prompt',
        priorMessages: [],
        signal: AbortSignal.timeout(30_000),
        onChunk: (chunk) => chunks.push(chunk),
        registry,
      }),
  )
  assert.equal(result.stopReason, 'end_turn')
  const shown = chunks.map((chunk) => (chunk.type === 'text' ? chunk.text : '')).join('')
  const prompt = /prompt:([\s\S]*)/.exec(shown)?.[1] ?? ''
  assert.ok(prompt, `the agent echoed its prompt: ${shown}`)
  return { shown, prompt }
}

describe('ACP native bridge mount (#4144)', () => {
  it('stops claiming Copse tools, and says so once, when the agent never lists them', async () => {
    await useFixtureAgent(['--mcp-http'])
    const registry = registryWithOneBridgedTool()
    const started = Date.now()
    const first = await turn('never-lists', registry)
    assert.ok(
      Date.now() - started >= ACP_BRIDGE_MOUNT_WAIT_MS - 100,
      'the first turn gives the agent the mount window',
    )
    assert.match(first.shown, UNAVAILABLE)
    assert.ok(first.prompt.includes(ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE))
    assert.ok(!first.prompt.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
    assert.doesNotMatch(first.prompt, /Prefer the "copse" MCP tools/)
    assert.match(first.prompt, /Session notes:/, 'the rest of the session notes stay')

    const startedAgain = Date.now()
    const second = await turn('never-lists', registry)
    assert.ok(Date.now() - startedAgain < ACP_BRIDGE_MOUNT_WAIT_MS, 'a later turn does not wait')
    assert.doesNotMatch(second.shown.replace(/prompt:[\s\S]*/, ''), UNAVAILABLE)
    assert.ok(!second.prompt.includes(ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE))
    assert.ok(!second.prompt.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
  })

  it('keeps claiming the tools for an agent that lists them', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    const { shown, prompt } = await turn('lists', registryWithOneBridgedTool())
    assert.doesNotMatch(shown, UNAVAILABLE)
    assert.ok(prompt.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
    assert.ok(!prompt.includes(ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE))
  })

  it("replaces Claude Agent ACP's failed-to-start line with Copse's own message", async () => {
    await useFixtureAgent(['--mcp-http', '--report-mcp-failure'])
    const { shown } = await turn('reports-failure', registryWithOneBridgedTool())
    assert.doesNotMatch(shown, CLAUDE_FALLBACK)
    assert.equal(shown.match(new RegExp(UNAVAILABLE, 'g'))?.length, 1)
  })
})

describe('isAcpBridgeStartupFailure', () => {
  const fallback = (
    server: string,
    status: string,
  ): Parameters<typeof isAcpBridgeStartupFailure>[0] => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `**MCP server "${server}" failed to start**` },
    _meta: { claudeCode: { kind: 'mcpServerStatus', server, status } },
  })

  it("recognises only the bridge's own failure", () => {
    assert.equal(isAcpBridgeStartupFailure(fallback('copse', 'failed')), true)
    assert.equal(isAcpBridgeStartupFailure(fallback('docs', 'failed')), false)
    assert.equal(isAcpBridgeStartupFailure(fallback('copse', 'needs-auth')), false)
  })

  it('ignores the same words without the adapter tag', () => {
    assert.equal(
      isAcpBridgeStartupFailure({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '**MCP server "copse" failed to start**' },
      }),
      false,
    )
  })
})
