import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/** Base ASRT config; workspace-specific paths are passed per spawn via `customConfig`. */
export function baseSandboxConfig(): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
    },
    filesystem: {
      denyRead: [],
      allowWrite: [],
      denyWrite: [],
      allowGitConfig: true,
    },
  }
}

export function workspaceSandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const root = resolve(workspaceRoot)
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
    },
    filesystem: {
      // Deny home reads, re-allow only this project (ASRT deny-then-allow).
      denyRead: [homedir()],
      allowRead: [root, `${root}/**`],
      allowWrite: [root, `${root}/**`],
      denyWrite: [],
    },
  }
}
