import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { StreamChunk } from '@shared/types'
import type { ContainerRuntimeAttestation } from '@shared/types/unattended-run.ts'
import { ACP_COPSE_TOOLS_PROMPT_NOTE, runAcpAgentFromSettings } from './acp-agent-service.ts'
import {
  ACP_BRIDGE_MOUNT_WAIT_MS,
  ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE,
  acpCopseToolsConnectedPromptNote,
  isAcpBridgeStartupFailure,
} from './acp-bridge-mount.ts'
import { acpSandboxGithubSteer } from './acp-network-denial-steer.ts'
import { acpSessionPoolSize, disposeAllAcpSessions } from './acp-session-pool.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import {
  clearRuntimeContainmentForTests,
  declareContainerRuntime,
  type GuestContainmentObservation,
} from '../security/runtime-containment.ts'
import {
  activateUnattendedRunForRun,
  armUnattendedRun,
  clearUnattendedRunsForTests,
} from '../security/unattended-run.ts'

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

function registryWithBridgedTools(names: readonly string[]): ToolRegistry {
  const registry = new ToolRegistry()
  for (const name of names) {
    registry.register({
      name,
      description: `Fixture ${name}`,
      parameters: z.object({}),
      execute: () => Promise.resolve('contents'),
    })
  }
  return registry
}

function registryWithOneBridgedTool(): ToolRegistry {
  return registryWithBridgedTools(['read_file'])
}

/** Bridged tools that give a sandboxed agent's GitHub steer something to name. */
const GITHUB_ROUTE_TOOLS = ['read_file', 'run_shell', 'gh_api_read', 'git_fetch']
const LISTED_GITHUB_ROUTE = /Offered here: gh_api_read, git_fetch\./

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

/** One turn; returns how it stopped and what the thread was shown. */
async function runTurn(
  threadId: string,
  registry: ToolRegistry,
  opts: { userPrompt?: string; signal?: AbortSignal } = {},
): Promise<{ stopReason: string; shown: string }> {
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
        userPrompt: opts.userPrompt ?? 'echo-prompt',
        priorMessages: [],
        signal: opts.signal ?? AbortSignal.timeout(30_000),
        onChunk: (chunk) => chunks.push(chunk),
        registry,
      }),
  )
  const shown = chunks.map((chunk) => (chunk.type === 'text' ? chunk.text : '')).join('')
  return { stopReason: result.stopReason, shown }
}

/** One `echo-prompt` turn; returns what the thread was shown and the prompt the agent received. */
async function turn(
  threadId: string,
  registry: ToolRegistry,
): Promise<{ shown: string; prompt: string }> {
  const { stopReason, shown } = await runTurn(threadId, registry)
  assert.equal(stopReason, 'end_turn')
  const prompt = /prompt:([\s\S]*)/.exec(shown)?.[1] ?? ''
  assert.ok(prompt, `the agent echoed its prompt: ${shown}`)
  return { shown, prompt }
}

/**
 * Run `fn` as the thread's unattended run inside a declared container, where
 * the agent counts as sandboxed and its notes carry the sandbox steering. This
 * is the one sandboxed ACP path a test can reach without a real OS sandbox.
 */
async function sandboxedRun<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const attestation: ContainerRuntimeAttestation = {
    runtimeId: 'rt-bridge-mount',
    image: 'copse-worker:test',
    user: 1001,
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    pidsLimit: 512,
    memoryLimit: '4g',
    network: 'none',
    egressAllowlist: [],
    hostMounts: ['/run/copse'],
    securityProfiles: 'default',
  }
  const guest: GuestContainmentObservation = {
    uid: 1001,
    capabilitySets: { inheritable: 0n, permitted: 0n, effective: 0n, bounding: 0n, ambient: 0n },
    noNewPrivileges: true,
    upNetworkInterfaces: ['lo'],
    rootMountOptions: ['ro', 'relatime'],
  }
  declareContainerRuntime(attestation, guest)
  armUnattendedRun(threadId, {
    runtimeId: attestation.runtimeId,
    budgets: { wallClockMs: 60_000, tokenCeiling: 1_000_000 },
  })
  activateUnattendedRunForRun(threadId)
  try {
    return await runWithActiveRunIdentity(threadId, fn)
  } finally {
    clearUnattendedRunsForTests()
    clearRuntimeContainmentForTests()
  }
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

  it('takes a Stop during the mount window for a cancel, not a failed mount', async () => {
    await useFixtureAgent(['--mcp-http'])
    const registry = registryWithOneBridgedTool()
    const stop = new AbortController()
    // Stop once the session is open, while the turn waits for the listing.
    const stopOnceOpen = (async (): Promise<void> => {
      const giveUpAt = Date.now() + 20_000
      while (acpSessionPoolSize() === 0 && Date.now() < giveUpAt) await delay(10)
      stop.abort()
    })()
    const started = Date.now()
    const stopped = await runTurn('stopped', registry, { signal: stop.signal })
    await stopOnceOpen
    assert.equal(stopped.stopReason, 'cancelled')
    assert.ok(Date.now() - started < ACP_BRIDGE_MOUNT_WAIT_MS, 'the Stop ends the wait')
    assert.doesNotMatch(stopped.shown, UNAVAILABLE)

    // The bridge was not marked unavailable: the next turn still decides, once.
    const next = await turn('stopped', registry)
    assert.equal(next.shown.match(new RegExp(UNAVAILABLE, 'g'))?.length, 1)
    assert.ok(next.prompt.includes(ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE))
  })

  it('tells an agent that lists the tools late that they are back', async () => {
    await useFixtureAgent(['--mcp-http'])
    const registry = registryWithOneBridgedTool()
    const first = await turn('lists-late', registry)
    assert.match(first.shown, UNAVAILABLE)

    const listing = await runTurn('lists-late', registry, { userPrompt: 'list-mcp-tools' })
    assert.equal(listing.stopReason, 'end_turn')
    assert.match(listing.shown, /listed/)

    const after = await turn('lists-late', registry)
    assert.ok(after.prompt.includes(acpCopseToolsConnectedPromptNote(ACP_COPSE_TOOLS_PROMPT_NOTE)))
    assert.ok(!after.prompt.includes(ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE))
    assert.doesNotMatch(after.shown, UNAVAILABLE)
    // Unsandboxed: nothing of the sandbox note comes back with it.
    assert.doesNotMatch(after.prompt, /run_shell tool for commands|For GitHub work/)
  })

  it('gives a sandboxed agent that lists late its run_shell and GitHub steering back', async () => {
    await useFixtureAgent(['--mcp-http'])
    const registry = registryWithBridgedTools(GITHUB_ROUTE_TOOLS)
    await sandboxedRun('sandboxed-late', async () => {
      const first = await turn('sandboxed-late', registry)
      assert.match(first.prompt, /Environment note: this session runs inside a filesystem sandbox/)
      assert.doesNotMatch(first.prompt, /run_shell tool for commands/)
      // Offered but never connected: the GitHub steer stays, names none of
      // the offered tools, and says GitHub is out of reach (#4145).
      assert.ok(first.prompt.includes(acpSandboxGithubSteer([])))
      assert.doesNotMatch(first.prompt, /Offered here/)

      await runTurn('sandboxed-late', registry, { userPrompt: 'list-mcp-tools' })
      const after = await turn('sandboxed-late', registry)
      const restored = /Tool note: Copse's "copse" MCP server is now connected[\s\S]*/.exec(
        after.prompt,
      )?.[0]
      assert.ok(restored, `the prompt says the tools are back: ${after.prompt}`)
      assert.ok(restored.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
      assert.match(restored, /use its run_shell tool for commands/)
      assert.match(restored, LISTED_GITHUB_ROUTE)
      assert.doesNotMatch(restored, /"copse" MCP server is not available/)
    })
  })

  it("hands a sandboxed agent's GitHub steer the tools it listed", async () => {
    // The wiring the steer depends on: drop the listed names at the turn's
    // call site and this prompt says GitHub is out of reach instead.
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    await sandboxedRun('sandboxed-lists', async () => {
      const { prompt } = await turn('sandboxed-lists', registryWithBridgedTools(GITHUB_ROUTE_TOOLS))
      assert.match(prompt, LISTED_GITHUB_ROUTE)
      assert.match(prompt, /For anything they do not cover, run `gh` through its run_shell tool/)
      assert.doesNotMatch(prompt, /"copse" MCP server is not available/)
      assert.ok(prompt.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
    })
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
