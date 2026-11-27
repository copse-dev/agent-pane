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
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

// A hook runs the same command text every time, so its violations are keyed by
// a per-spawn id: keyed by the text, every earlier run's denials would count.
const hookViolationIds = new WeakMap<ChildProcess, string>()

configureHooksDialects({
  sandbox: {
    enabled: () => isProjectSandboxEnabled(),
    spawnShell: async (command, opts) => {
      const violationId = randomUUID()
      const child = await spawnShellInProjectSandbox(command, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        violationId,
        ...(opts.localOnly ? { executionTarget: { kind: 'local' as const } } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      hookViolationIds.set(child, violationId)
      return child
    },
    violationCount: (_command, child) => {
      const violationId = hookViolationIds.get(child)
      return violationId ? sandboxViolationCountForCommand(violationId) : 0
    },
    afterCommand: () => {
      afterSandboxedCommand()
    },
  },
  childEnv: (base) => envForRendererChildProcess(base),
  agentExecutionRoot: () => getAgentExecutionRoot(),
  dataRoot: () => copseDataRoot(),
})
