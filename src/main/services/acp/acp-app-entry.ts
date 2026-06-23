import { createCopseAcpTurnRunner } from './copse-turn-runner.ts'
import { serveAcpAgentOverStdio } from './acp-agent-server.ts'
import { createRegistry, registerSkillTools } from '../registry-bootstrap.ts'
import { initSkillsRegistry } from '../skills-registry.ts'
import { loadMcpServers } from '../mcp-registry.ts'
import { buildProvider } from '../provider-selection.ts'
import { buildSystemPrompt } from '../agent-system-prompt.ts'
import { getSetting } from '../settings.ts'
import { normalizeToolExecuteResult } from '@shared/types'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'

// Tools that mutate the workspace, run commands, or reach the network must be
// approved by the ACP client (via `session/request_permission`) before they
// run. Read/search tools run without a prompt.
const TOOLS_REQUIRING_PERMISSION = new Set<string>([
  'write_file',
  'str_replace',
  'delete_file',
  'rename_file',
  'make_directory',
  'run_shell',
  'fetch_url',
  'web_search',
])

/**
 * Headless entry for `copse --acp`: expose the Copse agent loop to an ACP
 * client over stdio (ndjson JSON-RPC).
 *
 * This runs inside the Electron main process (the binary the ACP client
 * spawns) and reuses the same registry/provider/system-prompt bootstrap as the
 * GUI app, so the agent has the full tool surface. The window is never created.
 *
 * Note: the ACP transport owns stdout, so nothing else in this process may
 * write to it once the server is connected — keep diagnostics on stderr.
 */
export async function runAcpAgentMode(): Promise<void> {
  const registry = createRegistry()
  await initSkillsRegistry()
  registerSkillTools(registry)
  await loadMcpServers(registry)

  const model = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const subagentsEnabled = getSetting<boolean>('subagentsEnabled', true)

  const runner = createCopseAcpTurnRunner({
    buildProvider: () => buildProvider(model),
    buildTools: () => registry.toLLMTools(),
    // registry.execute returns a ToolExecuteResult (string or { result, editStats });
    // the ACP turn runner only needs the text result (editStats is a GUI diff-card concern).
    executeTool: async (name, args, signal) =>
      normalizeToolExecuteResult(await registry.execute(name, args, signal)).result,
    buildSystemPrompt: () => buildSystemPrompt({ subagentsEnabled, invokedSkills: [] }),
    needsPermission: (name) => TOOLS_REQUIRING_PERMISSION.has(name),
    usageModel: model,
  })

  serveAcpAgentOverStdio(runner, { name: 'Copse', loadSession: false })
}
