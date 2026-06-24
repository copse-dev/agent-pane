import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type ScopeVerdict = 'sandbox' | 'external' | 'ambiguous'

export interface ShellScopeAnalysis {
  verdict: ScopeVerdict
  reasons: string[]
}

/**
 * Heuristic shell-command classifier for permission prompts — not a security boundary.
 * On macOS, project seatbelt is the real confinement; elsewhere, users must approve
 * commands that look external. Evasion (substitution, encoding, uncommon tools) is
 * possible; patterns here reduce obvious false auto-runs only.
 */

// A command-invocation position: start of the string, or immediately after a
// shell separator (pipe, semicolon, &&/||, subshell open, newline). Anchoring a
// bare command name here lets us match e.g. `gh` the binary without also matching
// `gh` as a substring of a path or argument like `services/gh-pr-service.ts`
// (a read-only grep on a gh-* filename was misclassified as a GitHub CLI call).
const CMD_POS = String.raw`(?:^|[\n|;&(])\s*`

// Commands that clearly reach outside the workspace or network.
//
// `ambiguous: true` marks fuzzy "may reach" matchers — short/overloaded command
// names that often appear as harmless local subcommands (e.g. `gh`, `nc`, the
// `aws|gcloud|az` catch-all, `open <url>`). When macOS seatbelt is the real
// boundary, these auto-run *inside* the sandbox and rely on the failure→retry
// escalation if the OS actually blocks them, instead of prompting upfront on a
// guess. Without an OS sandbox they still prompt, like any external command.
const EXTERNAL_PATTERNS: Array<{ re: RegExp; reason: string; ambiguous?: boolean }> = [
  { re: /\bcurl\b|\bwget\b|\bfetch\b/i, reason: 'network download (curl/wget/fetch)' },
  {
    re: /\b(npm|yarn|pnpm|bun)\s+(i|in|install|ci|update|upgrade|publish|add|dlx|exec|create)\b/i,
    reason: 'package install/update (may fetch + run code from network)',
  },
  // Ephemeral package runners auto-fetch and execute the *latest* (typo-squattable)
  // package with no pinning or integrity check — a supply-chain RCE surface (#174).
  {
    re: /\bnpx\b|\bpnpm\s+dlx\b|\byarn\s+dlx\b|\bbunx\b|\buvx\b|\bpipx\s+run\b|\bpipx\s+install\b/i,
    reason: 'ephemeral package runner (npx/dlx/bunx/uvx/pipx — fetches & runs unpinned code)',
  },
  { re: /\bcorepack\b/i, reason: 'corepack (downloads package-manager binaries)' },
  {
    re: /\bpip3?\s+install\b|\buv\s+pip\s+install\b|\buv\s+add\b/i,
    reason: 'pip install (may fetch from network)',
  },
  { re: /\bcargo\s+install\b/i, reason: 'cargo install (may fetch from network)' },
  { re: /\bgo\s+(install|get)\b/i, reason: 'go install/get (may fetch + run code from network)' },
  { re: /\bgem\s+install\b/i, reason: 'gem install (may fetch from network)' },
  { re: /\bbrew\s+(install|update|upgrade)\b/i, reason: 'Homebrew install/update' },
  {
    re: /\b(apt|apt-get|dnf|yum|pacman)\s+(install|update|upgrade)\b/i,
    reason: 'system package manager',
  },
  { re: /\bssh\b|\bscp\b|\brsync\b/i, reason: 'remote shell/copy (ssh/scp/rsync)' },
  { re: /\bsocat\b|\blftp\b|\bftp\b/i, reason: 'network utility (socat/ftp/lftp)' },
  { re: /\bgit\s+(push|pull|fetch|clone|remote)\b/i, reason: 'git network operation' },
  { re: /\bdocker\s+(pull|push|run)\b/i, reason: 'docker network/container operation' },
  { re: /\bkubectl\b|\bhelm\s+install\b/i, reason: 'kubernetes remote operation' },
  {
    re: /\b(aws|gcloud|az)\s+/i,
    reason: 'cloud CLI (may reach external services)',
    ambiguous: true,
  },
  {
    re: new RegExp(`${CMD_POS}gh\\b`, 'i'),
    reason: 'GitHub CLI (may reach GitHub)',
    ambiguous: true,
  },
  { re: /\bopen\s+https?:|\bxdg-open\s+https?:/i, reason: 'open external URL', ambiguous: true },
  {
    re: new RegExp(`${CMD_POS}nc\\b|\\bnetcat\\b|\\btelnet\\b`, 'i'),
    reason: 'raw network utility',
    ambiguous: true,
  },
  {
    re: /\bpython3?\b[^\n|;&]*\s-c\b|\bnode\b[^\n|;&]*\s-e\b|\bbun\b[^\n|;&]*\s-e\b/i,
    reason: 'inline script (python/node -c/-e)',
  },
  { re: /\beval\b|\bexec\b|\bbase64\b/i, reason: 'dynamic execution / encoding' },
  { re: /\bpkill\b|\bkillall\b|\bkill\s+-9\b/i, reason: 'process kill (system-wide)' },
  { re: /\bsudo\b|\bsu\s+-/i, reason: 'privilege escalation' },
  {
    re: /\brm\s+-\S*[rf]\S*\s+(?:\/\s*$|~\/|\$HOME)/i,
    reason: 'destructive path outside workspace',
  },
  { re: /\brm\s+-rf\s+\/\b|\brm\s+-rf\s+~\b/i, reason: 'destructive path outside workspace' },
  { re: /\bchmod\s+[0-7]*7/i, reason: 'broad permission change' },
  { re: /\bmkfs\b|\bfdisk\b|\bdd\s+if=/i, reason: 'disk/system modification' },
]

// Paths that indicate access outside the workspace.
const OUTSIDE_PATH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|[\s|])~(?:\/|\b)/, reason: 'home directory path (~/)' },
  { re: /\$HOME\b/, reason: '$HOME reference' },
  { re: /(?:^|[\s|])\/etc\//, reason: 'system path (/etc/)' },
  { re: /(?:^|[\s|])\/usr\//, reason: 'system path (/usr/)' },
  { re: /(?:^|[\s|])\/var\//, reason: 'system path (/var/)' },
  { re: /(?:^|[\s|])\/tmp\//, reason: 'global temp path (/tmp/)' },
  { re: /\.\.\//, reason: 'parent directory traversal (../)' },
]

/** Undo common backslash obfuscation before pattern matching (e.g. c\\url → curl). */
export function normalizeShellCommandForAnalysis(command: string): string {
  return command.replace(/\\(?=[a-zA-Z0-9])/g, '')
}

// Signals that a package command points at a non-default registry or carries
// inline credentials — a classic vector for pulling from an attacker-controlled
// mirror or leaking tokens (#174).
const REGISTRY_REDIRECT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /--registry(=|\s)/i,
    reason: 'custom package registry (--registry) — verify it is trusted',
  },
  { re: /\b_authToken\b|\bnpm_config_registry\b/i, reason: 'inline registry credentials/override' },
  {
    re: /\bpip\b[^\n|;&]*--(index-url|extra-index-url)(=|\s)/i,
    reason: 'custom pip index URL — verify it is trusted',
  },
  {
    re: /\bcargo\b[^\n|;&]*--registry(=|\s)/i,
    reason: 'custom cargo registry — verify it is trusted',
  },
]

// `hasHard` is true when at least one matched signal is a definite escape
// (network download, install, git push, command substitution, …) rather than a
// fuzzy `ambiguous` matcher. It decides whether the verdict is `external`
// (prompt + run outside) or merely `ambiguous` (auto-run inside the sandbox).
function collectExternalReasons(command: string): { reasons: string[]; hasHard: boolean } {
  const reasons: string[] = []
  let hasHard = false
  const variants = [command, normalizeShellCommandForAnalysis(command)]
  for (const text of variants) {
    for (const { re, reason, ambiguous } of EXTERNAL_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) {
        reasons.push(reason)
        if (!ambiguous) hasHard = true
      }
    }
    for (const { re, reason } of REGISTRY_REDIRECT_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) {
        reasons.push(reason)
        hasHard = true
      }
    }
  }
  if (/\$\(|`/.test(command)) {
    reasons.push('command substitution (may hide network or outside-path tools)')
    hasHard = true
  }
  return { reasons, hasHard }
}

function referencesOutsideWorkspace(command: string, workspaceRoot: string | null): string | null {
  for (const { re, reason } of OUTSIDE_PATH_PATTERNS) {
    if (re.test(command)) return reason
  }

  if (!workspaceRoot) return null

  const root = resolve(workspaceRoot)
  const home = homedir()
  // Absolute paths in the command that aren't under the workspace root.
  const absPaths = command.match(/(?:^|[\s'"=])(\/[^\s'"|;&]+)/g) ?? []
  for (const raw of absPaths) {
    const p = raw.trim().replace(/^[\s'"=]+/, '')
    if (p.startsWith('/dev/') || p.startsWith('/proc/')) continue
    const resolved = resolve(p)
    if (resolved.startsWith(root + '/') || resolved === root) continue
    if (resolved.startsWith(home + '/') && !resolved.startsWith(root + '/')) {
      return `absolute path outside workspace: ${p}`
    }
    if (!resolved.startsWith(root)) return `absolute path outside workspace: ${p}`
  }

  return null
}

/**
 * Commands that are destructive or resource-exhausting even when fully contained
 * inside the workspace sandbox. macOS seatbelt blocks network + out-of-workspace
 * FS, but does nothing about `rm -rf` inside the repo, fork bombs, or piping a
 * downloaded script straight into a shell. These must still prompt even when the
 * OS sandbox is active (see issue #103: sandboxed auto-allow was a blanket bypass
 * of the classifier).
 */
const DANGEROUS_IN_SANDBOX_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-\S*[rf]/i, reason: 'recursive/forced delete (rm -rf)' },
  { re: /\bgit\s+clean\s+-\S*[dfx]/i, reason: 'git clean removes untracked files' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards changes' },
  { re: /\bgit\s+checkout\s+--\s+\./i, reason: 'git checkout discards local changes' },
  { re: />\s*\/dev\/(?:sda|disk|null\s+2>&1\s*&\s*$)/i, reason: 'raw device write' },
  { re: /\bfind\b[^\n|;&]*\s-delete\b/i, reason: 'find -delete bulk removal' },
  { re: /\btruncate\b|\bshred\b/i, reason: 'file truncation/shredding' },
  // Pipe-to-shell: `curl … | sh`, `wget … | bash`, etc. (the curl is also caught
  // as external, but this fires even for in-workspace scripts piped to a shell).
  {
    re: /\|\s*(?:sh|bash|zsh|python3?|node|ruby|perl)\b/i,
    reason: 'piping output into an interpreter',
  },
  // Classic shell fork bomb and obvious busy-loop fork patterns.
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'fork bomb' },
  { re: /\bwhile\s+(?:true|:)\s*;?\s*do\b/i, reason: 'unbounded loop (CPU exhaustion)' },
  { re: /\byes\b\s*\|/i, reason: 'unbounded `yes` output' },
]

/** Destructive/resource-exhausting patterns that warrant a prompt even when sandboxed. */
export function dangerousInSandboxReasons(command: string): string[] {
  const reasons: string[] = []
  const variants = [command, normalizeShellCommandForAnalysis(command)]
  for (const text of variants) {
    for (const { re, reason } of DANGEROUS_IN_SANDBOX_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  return reasons
}

export function analyzeShellCommand(
  command: string,
  workspaceRoot: string | null,
): ShellScopeAnalysis {
  const trimmed = command.trim()
  if (!trimmed) {
    return { verdict: 'sandbox', reasons: ['empty command'] }
  }

  const { reasons, hasHard } = collectExternalReasons(trimmed)

  // Outside-workspace filesystem access is always a hard escape: we want such
  // commands to prompt and run outside the sandbox, not attempt-then-retry.
  const outsidePath = referencesOutsideWorkspace(trimmed, workspaceRoot)
  if (outsidePath) reasons.push(outsidePath)

  if (reasons.length === 0) {
    // Local-only commands with no escape signals are sandbox-contained.
    return { verdict: 'sandbox', reasons: ['no network or outside-path signals detected'] }
  }

  // Only fuzzy "may reach" matchers fired → ambiguous: safe to auto-run inside an
  // OS sandbox (it contains any real escape) but still prompt without one.
  return { verdict: hasHard || outsidePath !== null ? 'external' : 'ambiguous', reasons }
}
