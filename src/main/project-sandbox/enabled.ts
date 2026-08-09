import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { isProjectSandboxActive, setProjectSandboxActive } from './state.ts'

/**
 * Whether project subprocesses actually spawn confined right now.
 *
 * A leaf so callers that wrap-and-spawn (including the standalone ACP probe
 * worker) can ask without importing `spawn.ts`, which pulls `node-pty`. It is
 * deliberately NOT in `state.ts`: that module is documented native-free for the
 * prompt builder, and this one needs ASRT.
 */
export function isProjectSandboxEnabled(): boolean {
  return isProjectSandboxActive() && SandboxManager.isSandboxingEnabled()
}

export function setProjectSandboxEnabled(active: boolean): void {
  setProjectSandboxActive(active)
}
