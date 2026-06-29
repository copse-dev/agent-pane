import { randomUUID } from 'node:crypto'
import { serveAcpAgentOverStdio, type AcpTurnRunner } from './acp-agent-server.ts'
import { createRegistry, registerSkillTools } from '../registry-bootstrap.ts'
import { initSkillsRegistry } from '../skills-registry.ts'
import { loadMcpServers } from '../mcp-registry.ts'
import { runAgent, abortAgent } from '../agent-service.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setStagedDiffResolver } from '../diff-queue.ts'
import type { AgentHost } from '@shared/agent/agent-host.ts'
import type { LLMMessage } from '@shared/types'

/**
 * Headless entry for `copse --acp`: expose the Copse agent loop to an ACP
 * client over stdio (ndjson JSON-RPC).
 *
 * This runs inside the Electron main process (the binary the ACP client spawns)
 * and drives the *full* {@link runAgent} — the same orchestrator the GUI uses,
 * so the ACP agent gets todos, history trimming, steering and subagent routing
 * for free. The only Electron seams it needs are injected per turn:
 *
 * - chunk emission → an {@link AgentHost} that forwards to the ACP session;
 * - tool approvals (`approval.ts`) and staged writes (`diff-queue.ts`) → handlers
 *   that map to the client's `session/request_permission`.
 *
 * No window is ever created. The ACP transport owns stdout, so nothing else in
 * this process may write to it once connected — keep diagnostics on stderr.
 */
export async function runAcpAgentMode(): Promise<void> {
  const registry = createRegistry()
  await initSkillsRegistry()
  registerSkillTools(registry)
  await loadMcpServers(registry)

  // One ACP session ↔ one Copse thread: keep the transcript across prompts.
  const history: LLMMessage[] = []

  const runner: AcpTurnRunner = async (ctx) => {
    const host: AgentHost = {
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
    const onAbort = (): void => abortAgent(ctx.sessionId)
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await runAgent(ctx.sessionId, ctx.prompt, history, host, registry)
      history.length = 0
      history.push(...result.messages)
      return { stopReason: 'end_turn' }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
      setApprovalHandler(null)
      setStagedDiffResolver(null)
    }
  }

  serveAcpAgentOverStdio(runner, { name: 'Copse', loadSession: false })
}
