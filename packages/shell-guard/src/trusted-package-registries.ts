/**
 * Trusted package registries (Settings → Permissions).
 *
 * Kept free of Node built-ins so the Settings renderer can import it. The rule
 * that consults the list lives in `remote-change.ts`: under Guarded YOLO, an
 * install pointed at a registry other than the public default asks once, unless
 * every registry the command names is on this list. Only settings that choose a
 * registry are covered; ones that weaken verification (`--trusted-host`,
 * `GOSUMDB=off`, `GOINSECURE`) still ask. The list is empty by default.
 */

/** Setting key holding the trusted registry origins (`https://npm.corp.example`). */
export const TRUSTED_PACKAGE_REGISTRIES_SETTING = 'trustedPackageRegistries'

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w.-]+\.localhost)$/i

/**
 * The origin a registry setting names, lower-case, or null when it is not a URL
 * Copse can compare. `https:` only, except plain `http:` to a loopback mirror.
 * A bare host is read as `https://host`; it needs a dot, so Go's `direct` and
 * other keywords are never mistaken for one.
 */
export function packageRegistryOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const loopback = LOOPBACK_HOST.test(url.hostname)
  if (!loopback && !url.hostname.includes('.')) return null
  if (url.protocol === 'http:' && !loopback) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.origin.toLowerCase()
}

function collect(entries: Iterable<unknown>): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const origin = packageRegistryOrigin(entry)
    if (origin === null || out.includes(origin)) continue
    out.push(origin)
  }
  return out
}

/** Parse the one-per-line textarea. Blank lines and `#` comments are skipped. */
export function parseTrustedPackageRegistries(text: string): string[] {
  return collect(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
}

/** Validate a value from the settings store, dropping malformed entries. */
export function sanitizeTrustedPackageRegistries(value: unknown): string[] {
  return Array.isArray(value) ? collect(value) : []
}
