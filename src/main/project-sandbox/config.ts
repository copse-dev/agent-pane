import { accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/**
 * User-level git config files git reads on every invocation. They live under
 * the home directory, which the workspace overlay otherwise denies. macOS
 * seatbelt denials surface as EPERM ("Operation not permitted"), which git
 * treats as fatal (exit 128) — so these must stay readable or every git command
 * fails. A more-specific allowRead overrides the broad home denyRead.
 */
function gitConfigReadPaths(): string[] {
  const home = homedir()
  return [
    join(home, '.gitconfig'),
    join(home, '.config/git/**'),
    join(home, '.gitignore'),
    join(home, '.gitignore_global'),
  ]
}

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
      // Deny home reads, re-allow only this project plus the user's git config
      // files (ASRT deny-then-allow; a more-specific allow overrides the deny).
      denyRead: [homedir()],
      allowRead: [root, `${root}/**`, ...toolchainRead, ...gitConfigReadPaths()],
      allowWrite: [root, `${root}/**`],
      denyWrite: [],
      allowGitConfig: true,
    },
  }
}
