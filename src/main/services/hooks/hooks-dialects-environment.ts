/**
 * Binds `@copse/hooks-dialects` to this app. Imported for its side effect by
 * every app-side re-export of a package module, so any path into the adapters or
 * the runner from app code sees the same facts the rest of the host does:
 *
 * - the project sandbox (F3, decision 7): hooks spawn inside the same OS sandbox
 *   the shell tool uses, with the runner's own violation counter as the
 *   blocked-by-sandbox signal;
 * - the scrubbed child environment, so LLM tokens never reach a hook process;
 * - the current agent turn's execution root (worktree or project);
 * - the profile root that holds the user-level `hooks.json`.
 *
 * Every binding is a thunk so a module cycle through the sandbox or storage
 * layers cannot observe an uninitialised import at startup.
 */
import { configureHooksDialects } from '@copse/hooks-dialects/environment.ts'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
  spawnShellInProjectSandbox,
} from '../../project-sandbox/index.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

configureHooksDialects({
  sandbox: {
    enabled: () => isProjectSandboxEnabled(),
    spawnShell: (command, opts) =>
      spawnShellInProjectSandbox(command, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    violationCount: (command) => sandboxViolationCountForCommand(command),
    afterCommand: () => {
      afterSandboxedCommand()
    },
  },
  childEnv: (base) => envForRendererChildProcess(base),
  agentExecutionRoot: () => getAgentExecutionRoot(),
  dataRoot: () => copseDataRoot(),
})
