import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildSync } from 'esbuild'
import { z } from 'zod'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { StreamChunk } from '@shared/types'
import type { ContainerRuntimeAttestation } from '@shared/types/unattended-run.ts'
import { ACP_COPSE_TOOLS_PROMPT_NOTE, runAcpAgentFromSettings } from './acp-agent-service.ts'
import {
  ACP_BRIDGE_MOUNT_WAIT_MS,
  ACP_COPSE_TOOLS_DROPPED_PROMPT_NOTE,
  ACP_COPSE_TOOLS_UNAVAILABLE_PROMPT_NOTE,
  acpBridgeToolMissing,
  acpCopseToolsConnectedPromptNote,
  isAcpBridgeStartupFailure,
} from './acp-bridge-mount.ts'
import { ACP_SANDBOX_GITHUB_STEER } from './acp-network-denial-steer.ts'
import { acpSessionPoolSize, disposeAllAcpSessions } from './acp-session-pool.ts'
import { acpSessionHostWorkerPath } from './acp-session-host.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
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
const NEVER_CONNECTED = /never connected to it/
const DROPPED = /connected to Copse's tool server but can't use its tools/g

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-acp-bridge-mount-'))
  execFileSync('git', ['init', '--quiet', root])
  setWorkspaceRootForTest(root)
})

afterEach(async () => {
  await disposeAllAcpSessions()
  setProjectSandboxEnabled(false)
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

async function useFixtureAgent(flags: string[], sandboxed = false): Promise<void> {
  await setSetting('registeredAcpAgents', [
    {
      id: 'bridge-fixture',
      title: AGENT_TITLE,
      command: process.execPath,
      args: [MOCK_AGENT, ...flags],
      enabled: true,
      ...(sandboxed ? { sandbox: { allowedDomains: [] } } : {}),
    },
  ])
}

function bundleStubbedSessionHost(): void {
  const outfile = acpSessionHostWorkerPath()
  const stub = join(dirname(outfile), 'bridge-sandbox-runtime-stub.mjs')
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(
    stub,
    `let config = null
export const SandboxManager = {
  async initialize(next) { config = next },
  getConfig() { return config },
  updateConfig(next) { config = next },
  isSandboxingEnabled() { return config !== null },
  async wrapWithSandboxArgv(command, shell) { return { argv: [shell, '-c', command] } },
  cleanupAfterCommand() {},
  async reset() { config = null },
}
export function getApplySeccompBinaryPath() { return null }
`,
  )
  buildSync({
    entryPoints: [resolve('src/main/services/acp/acp-session-host-worker.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    alias: {
      '@shared': resolve('src/shared'),
      '@anthropic-ai/sandbox-runtime': stub,
      '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js': stub,
    },
    external: [
      'electron',
      'shell-quote',
      'node-pty',
      'jsdom',
      '@mozilla/readability',
      'turndown',
      'electron-updater',
    ],
  })
}

/** One turn; returns how it stopped and what the thread was shown. */
async function runTurn(
  threadId: string,
  registry: ToolRegistry,
  opts: {
    userPrompt?: string
    signal?: AbortSignal
    readonlyCheckout?: boolean
    turnGuidance?: (bridgeToolNames: readonly string[]) => Promise<string | undefined>
  } = {},
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
      ...(opts.readonlyCheckout
        ? { deferredWorktree: { baseBranch: 'main', requestedAt: 1 } }
        : {}),
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
        ...(opts.turnGuidance ? { turnGuidance: opts.turnGuidance } : {}),
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
  it(
    'withholds write-access instructions until a read-only session lists the bridge',
    {
      skip: process.platform === 'win32',
    },
    async (t) => {
      // Exercise the real isolated host path with ASRT stubbed in that process;
      // no in-process fallback can conceal a missing worker in this test.
      bundleStubbedSessionHost()
      t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
      setProjectSandboxEnabled(true)
      await useFixtureAgent(['--mcp-http'], true)
      const registry = registryWithOneBridgedTool()
      const options = { readonlyCheckout: true }
      const first = await runTurn('readonly-lists-late', registry, options)
      assert.equal(first.stopReason, 'end_turn')
      assert.match(first.shown, /Read-only workspace:/)
      assert.doesNotMatch(first.shown, /request_write_access/)

      const listing = await runTurn('readonly-lists-late', registry, {
        ...options,
        userPrompt: 'list-mcp-tools',
      })
      assert.equal(listing.stopReason, 'end_turn')
      assert.match(listing.shown, /listed/)

      const after = await runTurn('readonly-lists-late', registry, options)
      assert.equal(after.stopReason, 'end_turn')
      assert.match(after.shown, /now connected/)
      assert.match(after.shown, /request_write_access/)
      assert.match(after.shown, /end your turn/)
    },
  )

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
    const registry = registryWithOneBridgedTool()
    await sandboxedRun('sandboxed-late', async () => {
      const first = await turn('sandboxed-late', registry)
      assert.match(first.prompt, /Environment note: this session runs inside a filesystem sandbox/)
      assert.doesNotMatch(first.prompt, /run_shell tool for commands/)
      // The GitHub steer stays without the tools: no github.com from this process.
      assert.ok(first.prompt.includes(ACP_SANDBOX_GITHUB_STEER))

      await runTurn('sandboxed-late', registry, { userPrompt: 'list-mcp-tools' })
      const after = await turn('sandboxed-late', registry)
      const restored = /Tool note: Copse's "copse" MCP server is now connected[\s\S]*/.exec(
        after.prompt,
      )?.[0]
      assert.ok(restored, `the prompt says the tools are back: ${after.prompt}`)
      assert.ok(restored.includes(ACP_COPSE_TOOLS_PROMPT_NOTE))
      assert.match(restored, /use its run_shell tool for commands/)
      assert.ok(restored.includes(ACP_SANDBOX_GITHUB_STEER))
    })
  })

  it("replaces Claude Agent ACP's failed-to-start line with Copse's own message", async () => {
    await useFixtureAgent(['--mcp-http', '--report-mcp-failure'])
    const { shown } = await turn('reports-failure', registryWithOneBridgedTool())
    assert.doesNotMatch(shown, CLAUDE_FALLBACK)
    assert.equal(shown.match(new RegExp(UNAVAILABLE, 'g'))?.length, 1)
  })
})

/**
 * #4142: the agent lists Copse's tools, then drops them all. Claude Code does
 * this when one schema breaks its rules, and the listing alone looks like a
 * healthy mount. The model still calls a tool it was steered to, and Claude
 * Code's "No such tool available" for a listed tool is the evidence.
 */
describe('ACP agent that drops the tools it listed (#4142)', () => {
  it('says once that the agent cannot use the tools, and stops steering it to them', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    const registry = registryWithOneBridgedTool()
    const refused = await runTurn('drops', registry, {
      userPrompt: 'refuse-copse-tool:read_file Read it with my own tools.',
    })
    assert.equal(refused.stopReason, 'end_turn')
    assert.equal(refused.shown.match(DROPPED)?.length, 1)
    assert.doesNotMatch(refused.shown, NEVER_CONNECTED, 'it did connect')
    assert.match(refused.shown, /Read it with my own tools\./)

    // The next prompt tells the agent to stop reaching for them, once.
    const next = await turn('drops', registry)
    assert.doesNotMatch(next.shown.replace(/prompt:[\s\S]*/, ''), DROPPED)
    assert.ok(next.prompt.includes(ACP_COPSE_TOOLS_DROPPED_PROMPT_NOTE))
    const after = await turn('drops', registry)
    assert.ok(!after.prompt.includes(ACP_COPSE_TOOLS_DROPPED_PROMPT_NOTE))

    const again = await runTurn('drops', registry, {
      userPrompt: 'refuse-copse-tool:read_file Again with my own tools.',
    })
    assert.doesNotMatch(again.shown, DROPPED, 'the thread is told once per session')
  })

  it('takes no notice of a refused call for a tool Copse never listed', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    const registry = registryWithOneBridgedTool()
    const refused = await runTurn('hallucinates', registry, {
      userPrompt: 'refuse-copse-tool:no_such_copse_tool Fine.',
    })
    assert.equal(refused.stopReason, 'end_turn')
    assert.doesNotMatch(refused.shown, DROPPED)
    const next = await turn('hallucinates', registry)
    assert.ok(!next.prompt.includes(ACP_COPSE_TOOLS_DROPPED_PROMPT_NOTE))
  })
})

/**
 * Copse's turn guidance (canonical `turnStart`, decision 20) must name only
 * tools the agent has: the ones it listed, and none once it dropped them.
 */
describe('ACP turn guidance tool set', () => {
  /** A guidance builder that records the names it was given and marks the prompt. */
  function recordingGuidance(): {
    seen: (readonly string[])[]
    turnGuidance: (names: readonly string[]) => Promise<string>
  } {
    const seen: (readonly string[])[] = []
    return {
      seen,
      turnGuidance: (names): Promise<string> => {
        seen.push(names)
        return Promise.resolve(`GUIDANCE for ${names.join(',') || 'no Copse tools'}`)
      },
    }
  }

  it('builds the guidance from the tools the agent listed, once per turn', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    const { seen, turnGuidance } = recordingGuidance()
    const { shown } = await runTurn('guidance-listed', registryWithOneBridgedTool(), {
      userPrompt: 'echo-prompt',
      turnGuidance,
    })
    assert.deepEqual(seen, [['read_file']])
    assert.match(shown, /## Copse guidance\n\nGUIDANCE for read_file/)
  })

  it('assembles again on a retry after a failed assembly, instead of replaying it', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    let calls = 0
    const { shown, stopReason } = await runTurn('guidance-retry', registryWithOneBridgedTool(), {
      userPrompt: 'echo-prompt',
      turnGuidance: () => {
        calls += 1
        // A transient-looking failure, which the turn's retry handling retries.
        return calls === 1
          ? Promise.reject(new Error('provider overloaded'))
          : Promise.resolve('GUIDANCE after retry')
      },
    })
    assert.equal(stopReason, 'end_turn')
    assert.equal(calls, 2, 'the retry assembled the guidance again')
    assert.match(shown, /## Copse guidance\n\nGUIDANCE after retry/)
  })

  it('names no Copse tool when the agent never listed them', async () => {
    await useFixtureAgent(['--mcp-http'])
    const { seen, turnGuidance } = recordingGuidance()
    await runTurn('guidance-unlisted', registryWithOneBridgedTool(), { turnGuidance })
    assert.deepEqual(seen, [[]])
  })

  it('names no Copse tool once the agent dropped them', async () => {
    await useFixtureAgent(['--mcp-http', '--list-mcp-tools'])
    const registry = registryWithOneBridgedTool()
    const { seen, turnGuidance } = recordingGuidance()
    await runTurn('guidance-dropped', registry, {
      userPrompt: 'refuse-copse-tool:read_file Fine.',
      turnGuidance,
    })
    await runTurn('guidance-dropped', registry, { turnGuidance })
    assert.deepEqual(seen, [['read_file'], []])
  })
})

describe('acpBridgeToolMissing', () => {
  const error = (tool: string): string =>
    `<tool_use_error>Error: No such tool available: ${tool}</tool_use_error>`
  const failed = (
    fields: Omit<
      Extract<Parameters<typeof acpBridgeToolMissing>[0], { sessionUpdate: 'tool_call_update' }>,
      'sessionUpdate' | 'toolCallId'
    >,
  ): Parameters<typeof acpBridgeToolMissing>[0] => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'failed',
    ...fields,
  })
  const named = [{ metaToolName: 'mcp__copse__read_file' }]

  it("finds the tool in Claude Code's error when the adapter named the call as it", () => {
    assert.equal(
      acpBridgeToolMissing(
        failed({
          rawOutput: error('mcp__copse__read_file'),
          _meta: { claudeCode: { toolName: 'mcp__copse__read_file' } },
        }),
        [],
      ),
      'read_file',
    )
    // The identity may come from an earlier report about the same call.
    const content = [
      {
        type: 'content' as const,
        content: { type: 'text' as const, text: error('mcp__copse__read_file') },
      },
    ]
    assert.equal(acpBridgeToolMissing(failed({ content }), named), 'read_file')
    assert.equal(
      acpBridgeToolMissing(
        failed({ rawOutput: [{ type: 'text', text: error('mcp__copse__read_file') }] }),
        [{ name: 'mcp__copse__read_file' }],
      ),
      'read_file',
    )
  })

  it('needs an adapter-authored identity naming that same Copse tool', () => {
    const output = { rawOutput: error('mcp__copse__read_file') }
    assert.equal(acpBridgeToolMissing(failed(output), []), null, 'text alone proves nothing')
    assert.equal(
      acpBridgeToolMissing(failed(output), [{ title: 'mcp__copse__read_file' }]),
      null,
      'a title can carry model-chosen text',
    )
    assert.equal(acpBridgeToolMissing(failed(output), [{ metaToolName: 'Bash' }]), null)
    assert.equal(
      acpBridgeToolMissing(failed(output), [{ metaToolName: 'mcp__copse__run_shell' }]),
      null,
    )
  })

  it("accepts only Claude Code's reasons that mean the server lacks the tool", () => {
    const withReason = (reason: string): Parameters<typeof acpBridgeToolMissing>[0] =>
      failed({
        rawOutput: `<tool_use_error>Error: No such tool available: mcp__copse__read_file${reason}</tool_use_error>`,
      })
    for (const reason of [
      ". Its MCP server 'copse' is connected but does not offer this tool here. Continue without it.",
      '. No MCP server in this session provides it; continue without this tool.',
    ]) {
      assert.equal(acpBridgeToolMissing(withReason(reason), named), 'read_file', reason)
    }
    for (const reason of [
      // Transient: the tools come back by themselves.
      ". Its MCP server 'copse' is still connecting; try again shortly.",
      ". The MCP server 'copse' is still connecting. Call WaitForMcp to wait for it, then try again.",
      // About something else than the server's tool list.
      '. A permissions deny rule now blocks this tool; do not call it again.',
      ". Its MCP server 'copse' is not available in this context. Continue without this tool.",
      ". Its MCP server 'copse' needs the user to re-authorize it before its tools work again.",
    ]) {
      assert.equal(acpBridgeToolMissing(withReason(reason), named), null, reason)
    }
  })

  it("ignores a Copse tool's own failure that merely quotes the phrase", () => {
    // The call reached the bridge and read_file failed on its own terms; the
    // adapter rightly names it mcp__copse__read_file. Only Claude Code's error,
    // as the result's leading statement, says the agent lacks the tool.
    for (const output of [
      'File not found: notes/No such tool available: mcp__copse__read_file',
      '<tool_use_error>Error: File not found: No such tool available: mcp__copse__read_file</tool_use_error>',
      'Exit code 1\nNo such tool available: mcp__copse__read_file',
    ]) {
      assert.equal(acpBridgeToolMissing(failed({ rawOutput: output }), named), null, output)
      const content = [
        { type: 'content' as const, content: { type: 'text' as const, text: output } },
      ]
      assert.equal(acpBridgeToolMissing(failed({ content }), named), null, output)
    }
    // Claude Code's own error leads, bare or fenced as the adapter may render it.
    for (const output of [
      'Error: No such tool available: mcp__copse__read_file',
      '```\n<tool_use_error>Error: No such tool available: mcp__copse__read_file</tool_use_error>\n```',
    ]) {
      assert.equal(acpBridgeToolMissing(failed({ rawOutput: output }), named), 'read_file', output)
    }
  })

  it('reads only failed results that name a Copse tool', () => {
    assert.equal(
      acpBridgeToolMissing(
        failed({ status: 'completed', rawOutput: error('mcp__copse__read_file') }),
        named,
      ),
      null,
    )
    assert.equal(
      acpBridgeToolMissing(failed({ rawOutput: error('mcp__docs__read_file') }), [
        { metaToolName: 'mcp__docs__read_file' },
      ]),
      null,
    )
    assert.equal(
      acpBridgeToolMissing(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: error('mcp__copse__read_file') },
        },
        named,
      ),
      null,
    )
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
