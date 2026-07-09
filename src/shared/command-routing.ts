/**
 * Shared types and text serialization for the trusted-shell-command allow-list.
 *
 * Kept free of Node built-ins so the Settings renderer can import it; the
 * resolution logic (which depends on `shell-scope.ts` and `shell-quote`) lives
 * in `src/main/services/security/command-routing.ts`.
 *
 * The feature is an allow-list of command *basenames* (e.g. `xcodebuild`) that
 * the user trusts to run UNSANDBOXED with no approval prompt — for tools that
 * genuinely cannot run inside the workspace sandbox (host toolchain, code
 * signing, vendor endpoints) but are safe for a trusted project. It is honoured
 * only in a trusted workspace and only when auto-run is enabled. See the resolver
 * for the exact eligibility rules and the safety argument.
 */

/** Setting key holding the trusted-command allow-list (array of basenames). */
export const TRUSTED_COMMANDS_SETTING = 'trustedShellCommands'

// A command basename: no path separators, whitespace, or shell metacharacters.
// This is what the resolver matches against a segment's head, so keeping the
// stored form to bare names avoids a rule like `/usr/bin/xcodebuild` or
// `xcodebuild build` ever silently never matching.
const VALID_COMMAND = /^[A-Za-z0-9._+-]+$/

export function isValidTrustedCommand(name: string): boolean {
  return VALID_COMMAND.test(name)
}

/**
 * Parse the Settings textarea (one command per line) into a normalized list.
 * Tolerant: blank lines and `#` comments are skipped, a `command:tier`-style
 * suffix is trimmed to the bare command (forward-compatible with the fuller
 * routing design), invalid names are dropped, and duplicates collapse.
 */
export function parseTrustedCommands(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // Accept a bare `xcodebuild` or a `xcodebuild:allow` form; keep only the name.
    const name = (line.split(':', 1)[0] ?? '').trim()
    if (!name || seen.has(name) || !isValidTrustedCommand(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** Serialize the allow-list back to the one-per-line textarea format. */
export function formatTrustedCommands(commands: readonly string[]): string {
  return commands.join('\n')
}

/** Validate a value coming off the settings store, dropping malformed entries. */
export function sanitizeTrustedCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name || seen.has(name) || !isValidTrustedCommand(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
