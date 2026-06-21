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

// Commands that clearly reach outside the workspace or network.
const EXTERNAL_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcurl\b|\bwget\b|\bfetch\b/i, reason: 'network download (curl/wget/fetch)' },
  {
    re: /\b(npm|yarn|pnpm)\s+(i|install|ci|update|publish|add)\b/i,
    reason: 'package install/update (may fetch from network)',
  },
  { re: /\bpip3?\s+install\b/i, reason: 'pip install (may fetch from network)' },
  { re: /\bcargo\s+install\b/i, reason: 'cargo install (may fetch from network)' },
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
  { re: /\b(aws|gcloud|az)\s+/i, reason: 'cloud CLI (may reach external services)' },
  { re: /\bgh\b/i, reason: 'GitHub CLI (may reach GitHub)' },
  { re: /\bopen\s+https?:|\bxdg-open\s+https?:/i, reason: 'open external URL' },
  { re: /\bnc\b|\bnetcat\b|\btelnet\b/i, reason: 'raw network utility' },
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

function collectExternalReasons(command: string): string[] {
  const reasons: string[] = []
  const variants = [command, normalizeShellCommandForAnalysis(command)]
  for (const text of variants) {
    for (const { re, reason } of EXTERNAL_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  if (/\$\(|`/.test(command)) {
    reasons.push('command substitution (may hide network or outside-path tools)')
  }
  return reasons
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

export function analyzeShellCommand(
  command: string,
  workspaceRoot: string | null,
): ShellScopeAnalysis {
  const trimmed = command.trim()
  if (!trimmed) {
    return { verdict: 'sandbox', reasons: ['empty command'] }
  }

  const reasons = collectExternalReasons(trimmed)

  const outsidePath = referencesOutsideWorkspace(trimmed, workspaceRoot)
  if (outsidePath) reasons.push(outsidePath)

  if (reasons.length > 0) {
    return { verdict: 'external', reasons }
  }

  // Local-only commands with no escape signals are sandbox-contained.
  return { verdict: 'sandbox', reasons: ['no network or outside-path signals detected'] }
}
