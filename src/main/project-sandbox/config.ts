import { accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/** Mirrors ASRT macOS mandatory write denies, resolved against the workspace root. */
const DANGEROUS_CONFIG_FILENAMES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const

const DANGEROUS_CONFIG_DIR_NAMES = [
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const

export function workspaceMandatoryWriteDenyPaths(workspaceRoot: string): string[] {
  const root = resolve(workspaceRoot)
  const denyPaths: string[] = []
  for (const fileName of DANGEROUS_CONFIG_FILENAMES) {
    denyPaths.push(join(root, fileName))
    denyPaths.push(`**/${fileName}`)
  }
  for (const dirName of DANGEROUS_CONFIG_DIR_NAMES) {
    denyPaths.push(join(root, dirName))
    denyPaths.push(`**/${dirName}/**`)
  }
  denyPaths.push(join(root, '.git/hooks'))
  denyPaths.push('**/.git/hooks/**')
  return [...new Set(denyPaths)]
}

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

/** Paths the bundled sandbox-fs worker must read to exec under ASRT (outside the workspace). */
export function electronRuntimeAllowReadPaths(): string[] {
  const exec = resolve(process.execPath)
  const paths = [exec, dirname(exec), `${dirname(exec)}/**`]
  if (process.platform === 'darwin' && exec.includes('.app/')) {
    const appRoot = `${exec.split('.app/')[0]!}.app`
    paths.push(resolve(appRoot), `${resolve(appRoot)}/**`)
  }
  return [...new Set(paths)]
}

/** Workspace seatbelt rules plus read access for the fs worker script and Electron runtime. */
export function fsWorkerSandboxOverlay(
  workspaceRoot: string,
  workerJsPath: string,
): Partial<SandboxRuntimeConfig> {
  const workspace = workspaceSandboxOverlay(workspaceRoot)
  const workerDir = dirname(resolve(workerJsPath))
  const fs = workspace.filesystem!
  const allowRead = [
    ...new Set([
      ...(fs.allowRead ?? []),
      workerDir,
      `${workerDir}/**`,
      ...electronRuntimeAllowReadPaths(),
    ]),
  ]
  return {
    ...workspace,
    filesystem: {
      denyRead: fs.denyRead ?? [],
      allowWrite: fs.allowWrite ?? [],
      denyWrite: fs.denyWrite ?? [],
      allowGitConfig: fs.allowGitConfig,
      allowRead,
    },
  }
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
      denyWrite: workspaceMandatoryWriteDenyPaths(root),
      allowGitConfig: true,
    },
  }
}
