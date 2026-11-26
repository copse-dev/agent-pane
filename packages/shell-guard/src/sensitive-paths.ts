import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

/**
 * Credential paths no read grant, contained-read root or standing sandbox read
 * root may cover. Shared by the outside-project read proof
 * (`read-outside-project.ts`), the shell-scope classifier's contained-read
 * waiver (`shell-scope.ts`) and the app's toolchain read guard.
 */

/** Basenames whose contents are credentials by convention. */
export const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  'shadow',
  'master.key',
  'secring.gpg',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SENSITIVE_BASENAME_PATTERNS: readonly RegExp[] = [
  // `.env`, `.env.local`, `.env.production`, `.env*` …
  /^\.env(?:[.*]|$)/i,
  // Private keys and keystores in any of their usual suffixes.
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc)$/i,
  /^id_[a-z0-9]+$/i,
  /(?:^|[.\-_])secrets?(?:[.\-_]|$)/i,
  /(?:^|[.\-_])credentials?(?:[.\-_]|$)/i,
]

/** Directory names that hold credentials for a whole toolchain. */
export const SENSITIVE_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.password-store',
  '.kube',
  '.docker',
  '.chef',
  'keychains',
  'gcloud',
])

/** Whole-path fragments where only the pairing is sensitive (`.config/gh` holds a token). */
export const SENSITIVE_PATH_FRAGMENTS: readonly string[] = ['/.config/gh/', '/.config/gcloud/']

/**
 * Why this target must never be covered by a blanket grant, or null when it is
 * an ordinary file. Both the token as written and its resolved path are tested,
 * so a glob (`~/.env*`) is caught even though it names no single file.
 */
export function sensitiveTargetReason(token: string, resolved: string): string | null {
  const lowerResolved = resolved.toLowerCase()
  const configured = process.env['COPSE_DIR']?.trim()
  const lanRoot = resolve(
    configured && configured.length > 0 ? configured : join(homedir(), '.copse'),
    'lan',
  ).toLowerCase()
  if (
    lowerResolved === lanRoot ||
    lowerResolved.startsWith(`${lanRoot}${sep}`) ||
    lanRoot.startsWith(`${lowerResolved}${sep}`)
  ) {
    return `Copse LAN credentials (${token})`
  }
  for (const fragment of SENSITIVE_PATH_FRAGMENTS) {
    if (lowerResolved.includes(fragment)) return `credential store (${token})`
  }
  for (const segment of lowerResolved.split(sep)) {
    if (SENSITIVE_DIR_SEGMENTS.has(segment)) return `credential directory (${token})`
  }
  for (const name of [basename(token), basename(resolved)]) {
    const lower = name.toLowerCase()
    if (SENSITIVE_BASENAMES.has(lower)) return `credential file (${token})`
    if (SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(lower))) {
      return `credential file (${token})`
    }
  }
  return null
}
