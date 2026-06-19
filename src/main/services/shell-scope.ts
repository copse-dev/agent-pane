import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type ScopeVerdict = 'sandbox' | 'external' | 'ambiguous'

export interface ShellScopeAnalysis {
  verdict: ScopeVerdict
  reasons: string[]
}

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
  { re: /\bgit\s+(push|pull|fetch|clone|remote)\b/i, reason: 'git network operation' },
  { re: /\bdocker\s+(pull|push|run)\b/i, reason: 'docker network/container operation' },
  { re: /\bkubectl\b|\bhelm\s+install\b/i, reason: 'kubernetes remote operation' },
  { re: /\b(aws|gcloud|az)\s+/i, reason: 'cloud CLI (may reach external services)' },
  { re: /\bgh\s+(auth|pr|repo)\b/i, reason: 'GitHub CLI (may reach GitHub)' },
  { re: /\bopen\s+https?:|\bxdg-open\s+https?:/i, reason: 'open external URL' },
  { re: /\bnc\b|\bnetcat\b|\btelnet\b/i, reason: 'raw network utility' },
  { re: /\bpkill\b|\bkillall\b|\bkill\s+-9\b/i, reason: 'process kill (system-wide)' },
  { re: /\bsudo\b|\bsu\s+-/i, reason: 'privilege escalation' },
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
  { re: /\.\.\/\.\./, reason: 'path traversal (../..)' },
]

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
  const reasons: string[] = []
  const trimmed = command.trim()
  if (!trimmed) {
    return { verdict: 'sandbox', reasons: ['empty command'] }
  }

  for (const { re, reason } of EXTERNAL_PATTERNS) {
    if (re.test(trimmed)) reasons.push(reason)
  }

  const outsidePath = referencesOutsideWorkspace(trimmed, workspaceRoot)
  if (outsidePath) reasons.push(outsidePath)

  if (reasons.length > 0) {
    return { verdict: 'external', reasons }
  }

  // Local-only commands with no escape signals are sandbox-contained.
  return { verdict: 'sandbox', reasons: ['no network or outside-path signals detected'] }
}
