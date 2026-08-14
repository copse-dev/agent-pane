import { randomUUID } from 'node:crypto'
import { serveAcpAgentOverStdio, type AcpTurnRunner } from './acp-agent-server.ts'
import { checkToolAvailability } from '../tool-availability.ts'
import { createRegistry, registerSkillTools } from '../registry-bootstrap.ts'
import { getPluginService } from '../plugins/plugin-service.ts'
import { initSkillsRegistry } from '../skills/skills-registry.ts'
import { loadMcpServers } from '../mcp/mcp-registry.ts'
import { runAgent, abortAgent, type RunAgentOptions } from '../agent-service.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setStagedDiffResolver } from '../diff-queue.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { LLMMessage, StreamChunk } from '@shared/types'
import type { ToolRegistry } from '../tool-registry.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { getActiveProjectId, getProjectRoot } from '../workspace.ts'
import {
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../thread-execution-context.ts'

/** What {@link createAcpTurnRunner} needs to drive one ACP session's turns. */
export interface AcpTurnRunnerDeps {
  /** Tools the turn's agent loop may call. */
  registry: ToolRegistry
  /**
   * Provider history for this ACP session. One ACP session is one Copse thread,
   * so the runner reads this array at the start of every prompt and replaces its
   * contents with the turn's result — it *is* the session's memory.
   */
  history: LLMMessage[]
  /** The project turns run in. Defaults to the app's persisted active project. */
  getActiveProjectId?: () => string | null
  /** Resolve a project's root. Defaults to persisted app state. */
  getProjectRoot?: (projectId: string) => string | null
  /**
   * Extra options for every `runAgent` call. This is the seam a deterministic
   * host uses to inject an `LLMProvider`, so an ACP turn can be driven end to
   * end with a mock model and no API key — see `acp-app-entry.test.ts`.
   */
  runOptions?: RunAgentOptions
}

/**
 * Build the `session/prompt` handler that turns an ACP request into a real Copse
 * turn: the *full* {@link runAgent} — the same orchestrator the GUI uses, so the
 * ACP agent role gets todos, history trimming, steering and subagent routing for
 * free. The only Electron seams it needs are supplied per turn:
 *
 * - chunk emission → an {@link AgentHost} that forwards to the ACP session;
 * - tool approvals (`approval.ts`) and staged writes (`diff-queue.ts`) → handlers
 *   that map to the client's `session/request_permission`.
 *
 * Split out from {@link runAcpAgentMode} so the agent role can be exercised
 * without a process: the bootstrap below is the only part that needs Electron,
 * and a test supplies its own registry, project and provider instead.
 */
export function createAcpTurnRunner(deps: AcpTurnRunnerDeps): AcpTurnRunner {
  const { registry, history, runOptions } = deps
  const activeProjectId = deps.getActiveProjectId ?? getActiveProjectId
  const projectRoot = deps.getProjectRoot ?? getProjectRoot

  return async (ctx) => {
    const host: AgentHost<StreamChunk> = {
      emit: (_threadId, chunk) => {
        void ctx.emit(chunk)
      },
    }

    // Both of Copse's approval channels (shell/mcp/web prompts and staged file
    // writes) ask the ACP client to decide, via session/request_permission.
    const askClient = async (title: string, rawInput: unknown): Promise<boolean> => {
      const decision = await ctx.requestPermission({ toolCallId: randomUUID(), title, rawInput })
      return decision === 'allow'
    }
    setApprovalHandler(async (req: ApprovalRequest) => ({
      approved: await askClient(req.title, { body: req.body, type: req.type }),
      remember: false,
    }))
    setStagedDiffResolver((entry) =>
      askClient(`Write ${entry.path}`, { path: entry.path, op: entry.op ?? 'write' }),
    )

    // Bridge ACP session/cancel to runAgent's abort (it keys aborts by thread id).
    const onAbort = (): void => {
      abortAgent(ctx.sessionId)
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const projectId = activeProjectId()
      if (!projectId) throw new Error('Cannot run an ACP turn without an active project')
      // ACP session ids are generated and retained by the main-process server,
      // not persisted in the GUI thread store. The project still comes from
      // trusted app state; acknowledge that main-owned membership explicitly.
      const executionContext = await resolveThreadExecutionContext(projectId, ctx.sessionId, {
        getProjectRoot: projectRoot,
        getThreadMeta: (_ownerProjectId, threadId) => Promise.resolve({ id: threadId }),
      })
      const result = await runWithThreadExecutionContext(executionContext, () =>
        runWithActiveRunIdentity(ctx.sessionId, () =>
          runAgent(ctx.sessionId, ctx.prompt, history, host, registry, runOptions),
        ),
      )
      history.length = 0
      history.push(...result.messages)
      return { stopReason: 'end_turn' }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
      setApprovalHandler(null)
      setStagedDiffResolver(null)
    }
  }
}

/**
 * Headless entry for `copse --acp`: expose the Copse agent loop to an ACP
 * client over stdio (ndjson JSON-RPC).
 *
 * This runs inside the Electron main process (the binary the ACP client spawns)
 * and drives {@link createAcpTurnRunner} over the real tool registry.
 *
 * No window is ever created. The ACP transport owns stdout, so nothing else in
 * this process may write to it once connected — keep diagnostics on stderr.
 */
export async function runAcpAgentMode(): Promise<void> {
  // Mirror the GUI bootstrap: gh/git probes must run before createRegistry()
  // gates read-only GitHub tools on isGhAvailable() (#523). P5 mirror: the
  // plugin service must be up before createRegistry() so `syncModelComparisonTools`
  // reads the persisted `pluginDisabled` state (not a fresh fallback).
  await checkToolAvailability()
  getPluginService()
  const registry = createRegistry()
  await initSkillsRegistry()
  registerSkillTools(registry)
  await loadMcpServers(registry)

  // One ACP session ↔ one Copse thread: keep the transcript across prompts.
  const history: LLMMessage[] = []

  serveAcpAgentOverStdio(createAcpTurnRunner({ registry, history }), {
    name: 'Copse',
    loadSession: false,
  })
}
