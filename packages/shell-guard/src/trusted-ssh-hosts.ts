/**
 * Text serialization for the trusted SSH hosts list (Settings → Permissions).
 *
 * Kept free of Node built-ins so the Settings renderer can import it. The rule
 * that consults the list lives in `host-reach.ts`: under Guarded YOLO, `ssh`,
 * `scp`, `rsync`, and `sftp` to a host on this list run without a confirmation;
 * every other host asks. The list is empty by default.
 */

/** Setting key holding the trusted SSH hosts (array of lower-case host names or aliases). */
export const TRUSTED_SSH_HOSTS_SETTING = 'trustedSshHosts'

// A host name, an IP literal, or an `~/.ssh/config` alias: no user@, port,
// path, whitespace, or shell metacharacters — the same bare form `host-reach.ts`
// extracts from a destination before it compares.
const VALID_HOST = /^[a-z0-9._:-]+$/

export function normalizeSshHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '')
}

function collect(entries: Iterable<unknown>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const host = normalizeSshHost(entry)
    if (!host || out.includes(host) || !VALID_HOST.test(host)) continue
    out.push(host)
  }
  return out
}

/** Parse the one-per-line textarea. Blank lines and `#` comments are skipped. */
export function parseTrustedSshHosts(text: string): string[] {
  return collect(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
}

/** Validate a value from the settings store, dropping malformed entries. */
export function sanitizeTrustedSshHosts(value: unknown): string[] {
  return Array.isArray(value) ? collect(value) : []
}
