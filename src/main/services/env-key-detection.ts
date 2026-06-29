import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Opt-in detection of LLM provider API keys the user already has exported in
 * their shell environment or in well-known shell start-up files. The renderer
 * triggers this only after the user explicitly approves it (first-run setup or
 * Settings); we then read a fixed allow-list of files plus `process.env`, map
 * any recognised provider env vars onto our provider slugs, and offer to import
 * them into Settings. Raw secret values never leave the main process — only the
 * masked preview produced by {@link maskSecret} is handed to the renderer.
 */

/** A provider key discovered in the environment (raw value — main process only). */
export interface DetectedKey {
  /** Provider slug as used by `apiKey.<slug>` storage (e.g. `anthropic`, `lmstudio`). */
  provider: string
  /** The environment variable the value was read from (e.g. `ANTHROPIC_API_KEY`). */
  envVar: string
  /** The discovered secret. Stays in the main process; never sent to the renderer. */
  value: string
  /** Where it was found: `environment` or the shell file label (e.g. `~/.zshrc`). */
  source: string
}

/**
 * Provider slug → the environment variable names that conventionally carry its
 * key. The first entry is the canonical name; later entries are accepted
 * aliases. Order of providers here also defines the order detections are
 * reported in. Keep these in sync with the provider env-var fallbacks in
 * `settings.ts` / `extra-providers.ts`.
 */
export const PROVIDER_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  lmstudio: ['LM_STUDIO_API_KEY', 'LMSTUDIO_API_KEY', 'LM_API_TOKEN'],
}

/** Reverse map: env var name (upper-case) → provider slug. */
const ENV_VAR_TO_PROVIDER: ReadonlyMap<string, string> = new Map(
  Object.entries(PROVIDER_ENV_VARS).flatMap(([provider, names]) =>
    names.map((name) => [name.toUpperCase(), provider] as const),
  ),
)

/**
 * Shell start-up / env files we read, relative to the user's home directory.
 * Restricted to the user's own dot-files — we never scan arbitrary project
 * files. `process.env` (the live, already-exported environment) is always
 * consulted first and takes priority over any file.
 */
export const WELL_KNOWN_ENV_FILES: readonly string[] = [
  '.zshenv',
  '.zshrc',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.config/fish/config.fish',
  '.env',
]

// Values that are obviously placeholders rather than real keys — skip them so an
// `export OPENAI_API_KEY=your-key-here` template line doesn't get imported.
const PLACEHOLDER_VALUES = new Set([
  'changeme',
  'replace-me',
  'replace_me',
  'xxx',
  'xxxxxxxx',
  'todo',
  'none',
  'null',
  'lm-studio',
])

// Common placeholder shapes (`your-api-key`, `your_key_here`, `example-key`, …).
const PLACEHOLDER_PATTERN = /^(your|my|the|some|example|dummy|sample|test|fake|placeholder)[-_]/i

/** Whether a parsed value looks like a usable secret rather than junk/placeholder. */
function isPlausibleSecret(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 8) return false
  // A real exported key has no internal whitespace; reject unresolved shell refs.
  if (/\s/.test(trimmed)) return false
  if (trimmed.startsWith('$')) return false
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return false
  if (PLACEHOLDER_PATTERN.test(trimmed)) return false
  return true
}

function stripQuotes(raw: string): string {
  const v = raw.trim()
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1)
  }
  // Unquoted: a trailing inline comment or extra tokens are not part of the value.
  return v.split(/\s+/)[0] ?? ''
}

/**
 * Parse the variable assignments out of a shell start-up file. Recognises the
 * common forms used to export environment variables:
 *   - `export FOO=bar`, `FOO=bar`            (sh/bash/zsh)
 *   - `setenv FOO bar`                       (csh/tcsh)
 *   - `set -x FOO bar` / `set -gx FOO bar`   (fish)
 * Values may be single- or double-quoted. Later assignments win.
 */
export function parseEnvAssignments(content: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const assign = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (assign) {
      out.set(assign[1]!, stripQuotes(assign[2]!))
      continue
    }
    const setenv = line.match(/^setenv\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/)
    if (setenv) {
      out.set(setenv[1]!, stripQuotes(setenv[2]!))
      continue
    }
    const fish = line.match(/^set\s+(?:-[A-Za-z]+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/)
    if (fish) {
      out.set(fish[1]!, stripQuotes(fish[2]!))
    }
  }
  return out
}

/** A named bag of environment variables (`process.env` or one parsed file). */
export interface EnvSource {
  source: string
  vars: Record<string, string | undefined> | Map<string, string>
}

function entriesOf(vars: EnvSource['vars']): Iterable<[string, string | undefined]> {
  return vars instanceof Map ? vars.entries() : Object.entries(vars)
}

/**
 * Map recognised provider env vars across the given sources onto provider slugs.
 * Sources are processed in order and the first plausible value found for a
 * provider wins, so callers should pass the highest-priority source (the live
 * `process.env`) first.
 */
export function collectDetectedKeys(sources: readonly EnvSource[]): DetectedKey[] {
  const byProvider = new Map<string, DetectedKey>()
  for (const { source, vars } of sources) {
    for (const [name, value] of entriesOf(vars)) {
      if (value === undefined) continue
      const provider = ENV_VAR_TO_PROVIDER.get(name.toUpperCase())
      if (!provider || byProvider.has(provider)) continue
      if (!isPlausibleSecret(value)) continue
      byProvider.set(provider, { provider, envVar: name, value: value.trim(), source })
    }
  }
  // Report in the stable provider order declared above.
  return Object.keys(PROVIDER_ENV_VARS)
    .map((provider) => byProvider.get(provider))
    .filter((d): d is DetectedKey => d !== undefined)
}

export interface ScanEnvDeps {
  env?: Record<string, string | undefined>
  homeDir?: string
  fileExists?: (path: string) => boolean
  readFile?: (path: string) => string
}

/**
 * Read `process.env` and the well-known shell files, returning every provider
 * key discovered. Filesystem access is injectable for tests; by default it uses
 * the real `process.env`, home directory, and `fs`.
 */
export function scanEnvForKeys(deps: ScanEnvDeps = {}): DetectedKey[] {
  const env = deps.env ?? process.env
  const home = deps.homeDir ?? homedir()
  const fileExists = deps.fileExists ?? existsSync
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))

  const sources: EnvSource[] = [{ source: 'environment', vars: env }]
  for (const rel of WELL_KNOWN_ENV_FILES) {
    const abs = join(home, rel)
    if (!fileExists(abs)) continue
    try {
      sources.push({ source: `~/${rel}`, vars: parseEnvAssignments(readFile(abs)) })
    } catch {
      // Unreadable file (permissions, transient IO) — skip it, keep scanning.
    }
  }
  return collectDetectedKeys(sources)
}

/** Mask a secret for display: keep a short prefix/suffix, hide the middle. */
export function maskSecret(value: string): string {
  const v = value.trim()
  if (v.length <= 6) return '•'.repeat(Math.max(v.length, 4))
  return `${v.slice(0, 3)}…${v.slice(-2)}`
}
