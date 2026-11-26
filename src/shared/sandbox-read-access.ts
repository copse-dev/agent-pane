/**
 * Settings → Permissions → Sandbox read access: which folders outside the
 * project a sandboxed command may read without asking. Every group is
 * read-only; nothing here ever widens what a contained command may write, and
 * the network stays off. See `docs/shell-permissions.md`, "Sandbox read access".
 */

/** Toolchains and SDKs: Xcode, Command Line Tools, Homebrew, Node/Rust/Python/Ruby version managers. */
export const SANDBOX_READ_TOOLCHAINS_SETTING = 'sandboxReadToolchains'
/** Package caches and build logs: npm, pnpm, Yarn, pip, uv, Cargo, Go, Xcode DerivedData, crash logs. */
export const SANDBOX_READ_CACHES_SETTING = 'sandboxReadCaches'
/** Folders the person approved for a project, such as a sibling checkout. */
export const SANDBOX_READ_APPROVED_FOLDERS_SETTING = 'sandboxReadApprovedFolders'
/** Lockdown: no group above applies, whatever its own switch says. */
export const SANDBOX_READ_WORKSPACE_ONLY_SETTING = 'sandboxReadWorkspaceOnly'
/**
 * Main-only store of the folders each project approved, keyed by project root.
 * Never renderer-writable: a folder is added only by answering a read prompt,
 * and Settings can only remove one (`settings:revoke-sandbox-read-folder`).
 */
export const SANDBOX_READ_PROJECT_FOLDERS_SETTING = 'sandboxReadProjectFolders'

export const SANDBOX_READ_TOOLCHAINS_DEFAULT = true
export const SANDBOX_READ_CACHES_DEFAULT = true
export const SANDBOX_READ_APPROVED_FOLDERS_DEFAULT = true
export const SANDBOX_READ_WORKSPACE_ONLY_DEFAULT = false

/** Most folders one project may hold; the prompt stops offering the project grant beyond it. */
export const MAX_SANDBOX_READ_FOLDERS_PER_PROJECT = 64

export type SandboxReadGroup = 'toolchains' | 'caches' | 'approvedFolders'

/** The effective switches after the lockdown is applied. */
export interface SandboxReadAccessPolicy {
  readonly toolchains: boolean
  readonly caches: boolean
  readonly approvedFolders: boolean
}

export interface SandboxReadSwitches {
  readonly toolchains: boolean
  readonly caches: boolean
  readonly approvedFolders: boolean
  readonly workspaceOnly: boolean
}

/** Workspace-only turns every group off; otherwise each switch stands. */
export function effectiveSandboxReadPolicy(switches: SandboxReadSwitches): SandboxReadAccessPolicy {
  if (switches.workspaceOnly) return { toolchains: false, caches: false, approvedFolders: false }
  return {
    toolchains: switches.toolchains,
    caches: switches.caches,
    approvedFolders: switches.approvedFolders,
  }
}

/**
 * Credentials that stay unreadable whatever the switches say, including inside
 * an approved folder. Shown in Settings so the person can see what is fixed.
 */
export const SANDBOX_READ_FIXED_DENIALS: readonly string[] = [
  '~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker and other credential folders',
  'Keychains (~/Library/Keychains)',
  'Copse’s keys and settings (~/.copse)',
  '.env files, private keys (.pem, .key, id_*), .npmrc, .netrc and similar, in any folder',
]
