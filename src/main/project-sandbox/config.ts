import { accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
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

/** Resolve Node/npm toolchain paths so sandboxed shells can run `npm test`, etc. */
export function resolveNodeToolchainAllowRead(env: NodeJS.ProcessEnv = process.env): string[] {
  const pathVar = env.PATH ?? ''
  const dirs = pathVar.split(':').filter(Boolean)
  const allow = new Set<string>()

  for (const dir of dirs) {
    let nodePath: string
    try {
      nodePath = resolve(dir, 'node')
      accessSync(nodePath)
    } catch {
      continue
    }

    allow.add(nodePath)
    const binDir = dirname(nodePath)
    allow.add(binDir)
    allow.add(`${binDir}/**`)

    // nvm/fnm layout: .../versions/node/vX.Y.Z/bin/node — npm lives under ../lib.
    const versionRoot = dirname(binDir)
    if (versionRoot !== binDir) {
      allow.add(versionRoot)
      allow.add(`${versionRoot}/**`)
    }
  }

  return [...allow]
}

export function workspaceSandboxOverlay(workspaceRoot: string): Partial<SandboxRuntimeConfig> {
  const root = resolve(workspaceRoot)
  const toolchainRead = resolveNodeToolchainAllowRead()
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
    },
    filesystem: {
      // Deny home reads, re-allow only this project (ASRT deny-then-allow).
      denyRead: [homedir()],
      allowRead: [root, `${root}/**`, ...toolchainRead],
      allowWrite: [root, `${root}/**`],
      denyWrite: [],
    },
  }
}
