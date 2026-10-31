import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type CreateTerminalRequest,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { runShellTool } from '../../tools/shell-tool.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { clearGitRemotesCache } from '../security/git-remotes.ts'
import { setWorkspaceTrusted } from '../security/workspace-trust.ts'
import { setSetting } from '../storage/settings.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { openAcpSession, runAcpSessionPrompt, type MutableAcpHandlers } from './acp-client.ts'
import { startAcpNativeBridge, type AcpNativeBridge } from './acp-native-bridge.ts'
import {
  ACP_TERMINAL_NOT_RUN_EXIT_CODE,
  ACP_TERMINAL_RETRY_MARKER,
  AcpTerminalHost,
} from './acp-terminals.ts'

/**
 * ACP client terminals (#623) end to end: a scripted ACP agent drives
 * `terminal/*` against `openAcpSession`, which runs each command through the
 * real native bridge, ToolRegistry permission gate and `run_shell` tool. Only
 * the OS sandbox boundary is mocked (as in shell-tool.test.ts), so the gate,
 * the sandboxed attempt and the unsandboxed-retry prompt are Copse's own.
 */

const SESSION = 'terminal-session'
const SANDBOXED_OUTPUT = 'sandboxed attempt denied'

interface TerminalRun {
  exit: WaitForTerminalExitResponse
  output: string
  truncated: boolean
}

interface AgentScript {
  /** What the agent asks for; `killAfter` kills once output contains it. */
  request: Omit<CreateTerminalRequest, 'sessionId'>
  killAfter?: string
}

interface Harness {
  root: string
  prompts: ApprovalRequest[]
  capabilities: () => ClientCapabilities | undefined
  run: (script: AgentScript, opts?: { bindTurn?: boolean }) => Promise<TerminalRun>
}

describe('ACP client terminals through run_shell (#623)', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function harness(opts: {
    sandbox: 'off' | 'violation'
    approve: (request: ApprovalRequest) => boolean
    terminals?: boolean
  }): Promise<Harness> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'copse-acp-terminal-')))
    cleanups.push(async () => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), '[core]\n')
    clearGitRemotesCache()
    cleanups.push(clearGitRemotesCache)
    cleanups.push(setWorkspaceRootForTest(root))
    setWorkspaceTrusted(root, true)
    cleanups.push(() => {
      setWorkspaceTrusted(root, false)
    })
    // Deterministic shape approval off: every question below must reach a person.
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('safeInstallEnabled', false)
    await setSetting('safetyClassifierEnabled', false)
    cleanups.push(async () => {
      await setSetting('safeInstallEnabled', true)
    })

    if (opts.sandbox === 'violation') {
      // The contained attempt "fails inside the sandbox" and the runner records
      // a violation against exactly that command, so run_shell offers its
      // runner-verified unsandboxed retry. The retry spawns the real command.
      mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
      mock.method(SandboxManager, 'cleanupAfterCommand', () => undefined)
      mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
        Promise.resolve({
          argv: ['/bin/sh', '-c', `echo '${SANDBOXED_OUTPUT}'; exit 1`],
          env: { ...process.env },
        }),
      )
      mock.method(SandboxManager.getSandboxViolationStore(), 'getViolationsForCommand', () => [
        { line: 'deny(1) network-outbound', timestamp: new Date() },
      ])
      setProjectSandboxEnabled(true)
      cleanups.push(() => {
        setProjectSandboxEnabled(false)
        mock.restoreAll()
      })
    }

    const prompts: ApprovalRequest[] = []
    setApprovalHandler((request) => {
      prompts.push(request)
      return Promise.resolve({ approved: opts.approve(request), remember: false })
    })
    cleanups.push(() => {
      setApprovalHandler(null)
    })

    const registry = new ToolRegistry()
    registry.register(runShellTool)
    const bridgeAbort = new AbortController()
    const bridge: AcpNativeBridge | null = await startAcpNativeBridge(
      registry,
      bridgeAbort.signal,
      { threadId: 'acp-terminal-thread', projectId: 'acp-terminal-project' },
    )
    assert.ok(bridge)
    cleanups.push(async () => {
      bridgeAbort.abort()
      await bridge.close()
    })
    const context: ThreadExecutionContext = {
      projectId: 'acp-terminal-project',
      threadId: 'acp-terminal-thread',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }

    let capabilities: ClientCapabilities | undefined
    let script: AgentScript | null = null
    let result: TerminalRun | null = null
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const connection = agent({ name: 'scripted-terminal-agent' })
      .onRequest('initialize', (ctx) => {
        capabilities = ctx.params.clientCapabilities
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
      })
      .onRequest('session/new', () => ({ sessionId: SESSION }))
      .onRequest('session/prompt', async (ctx) => {
        assert.ok(script)
        const { terminalId } = await ctx.client.request(methods.client.terminal.create, {
          sessionId: SESSION,
          ...script.request,
        })
        const killAfter = script.killAfter
        if (killAfter !== undefined) {
          for (;;) {
            const { output } = await ctx.client.request(methods.client.terminal.output, {
              sessionId: SESSION,
              terminalId,
            })
            if (output.includes(killAfter)) break
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          await ctx.client.request(methods.client.terminal.kill, { sessionId: SESSION, terminalId })
        }
        const exit = await ctx.client.request(methods.client.terminal.waitForExit, {
          sessionId: SESSION,
          terminalId,
        })
        const { output, truncated } = await ctx.client.request(methods.client.terminal.output, {
          sessionId: SESSION,
          terminalId,
        })
        await ctx.client.request(methods.client.terminal.release, {
          sessionId: SESSION,
          terminalId,
        })
        result = { exit, output, truncated }
        return { stopReason: 'end_turn' }
      })
      .connect(ndJsonStream(a2c.writable, c2a.readable))

    const handlers: MutableAcpHandlers = {
      current: {
        onChunk: () => undefined,
        requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      },
      ...(opts.terminals === false
        ? {}
        : { terminals: new AcpTerminalHost(bridge.runShellCommand) }),
    }
    const open = await openAcpSession(
      { command: 'unused', cwd: root, sshTarget: null },
      handlers,
      () =>
        Promise.resolve({
          stream: ndJsonStream(c2a.writable, a2c.readable),
          dispose: () => {
            connection.close()
          },
        }),
    )
    cleanups.push(() => open.dispose())

    return {
      root,
      prompts,
      capabilities: () => capabilities,
      run: async (next, runOpts): Promise<TerminalRun> => {
        script = next
        result = null
        if (runOpts?.bindTurn !== false) bridge.setExecutionContext(context)
        try {
          await runAcpSessionPrompt(open, 'go', undefined)
        } finally {
          bridge.setExecutionContext(null)
        }
        assert.ok(result, 'the scripted agent should have finished its terminal')
        return result
      },
    }
  }

  it('advertises terminals and runs an argv command through the permission gate', async () => {
    // No OS sandbox: run_shell's gate must ask before anything runs.
    const h = await harness({ sandbox: 'off', approve: () => true })
    assert.equal(h.capabilities()?.terminal, true)
    const run = await h.run({ request: { command: 'printf', args: ['%s\\n', 'hello world'] } })
    assert.deepEqual(run, {
      exit: { exitCode: 0, signal: null },
      output: 'hello world\n',
      truncated: false,
    })
    assert.equal(h.prompts.length, 1)
    assert.match(h.prompts[0]?.body ?? '', /'printf' '%s\\n' 'hello world'/)
  })

  it('applies env and a subdirectory cwd, and honours outputByteLimit', async () => {
    const h = await harness({ sandbox: 'off', approve: () => true })
    await mkdir(join(h.root, 'sub'))
    const run = await h.run({
      request: {
        command: 'printf "%s:%s" "$GREETING" "$(basename "$PWD")"',
        env: [{ name: 'GREETING', value: 'hi there' }],
        cwd: join(h.root, 'sub'),
        outputByteLimit: 7,
      },
    })
    assert.equal(run.exit.exitCode, 0)
    assert.deepEqual([run.output, run.truncated], ['ere:sub', true])
  })

  it('reports a gate rejection to the agent without running anything', async () => {
    const h = await harness({ sandbox: 'off', approve: () => false })
    const run = await h.run({ request: { command: 'touch', args: ['should-not-exist'] } })
    assert.deepEqual(run.exit, { exitCode: ACP_TERMINAL_NOT_RUN_EXIT_CODE, signal: null })
    assert.equal(run.output, 'User rejected the run_shell tool call.\n')
    assert.equal(h.prompts.length, 1)
  })

  it('offers the unsandboxed retry after a sandbox violation and runs it once approved', async () => {
    const h = await harness({ sandbox: 'violation', approve: () => true })
    const run = await h.run({ request: { command: 'echo retried' } })
    assert.deepEqual(run.exit, { exitCode: 0, signal: null })
    assert.equal(run.output, `${SANDBOXED_OUTPUT}\n${ACP_TERMINAL_RETRY_MARKER}\nretried\n`)
    // The contained command auto-ran; the only question was the retry.
    assert.deepEqual(
      h.prompts.map((p) => p.cause),
      ['shell-sandbox-retry'],
    )
  })

  it('returns the sandboxed failure and the decline when the retry is refused', async () => {
    const h = await harness({ sandbox: 'violation', approve: () => false })
    const run = await h.run({ request: { command: 'echo retried' } })
    assert.deepEqual(run.exit, { exitCode: 1, signal: null })
    assert.equal(run.output, `${SANDBOXED_OUTPUT}\nUser declined to run outside the sandbox.\n`)
    assert.deepEqual(
      h.prompts.map((p) => p.cause),
      ['shell-sandbox-retry'],
    )
  })

  it('kills a running command on terminal/kill', async () => {
    const h = await harness({ sandbox: 'off', approve: () => true })
    const run = await h.run({
      request: { command: 'echo started; sleep 30' },
      killAfter: 'started',
    })
    assert.equal(run.exit.exitCode, null)
    assert.ok(
      run.exit.signal === 'SIGTERM' || run.exit.signal === 'SIGKILL',
      String(run.exit.signal),
    )
  })

  it('refuses a command that arrives with no turn bound', async () => {
    const h = await harness({ sandbox: 'off', approve: () => true })
    const run = await h.run({ request: { command: 'touch', args: ['x'] } }, { bindTurn: false })
    assert.equal(run.exit.exitCode, ACP_TERMINAL_NOT_RUN_EXIT_CODE)
    assert.match(run.output, /no thread execution context is bound/)
    assert.equal(h.prompts.length, 0)
  })

  it('does not advertise terminals when Copse cannot back them', async () => {
    const h = await harness({ sandbox: 'off', approve: () => true, terminals: false })
    assert.equal(h.capabilities()?.terminal, false)
  })
})
