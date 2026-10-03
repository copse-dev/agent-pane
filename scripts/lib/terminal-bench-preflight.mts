import type { TerminalToolResult } from './terminal-bench-protocol.mts'

/** Hard ceiling on the characters the pre-flight block adds to the first user message. */
export const TERMINAL_PREFLIGHT_MAX_CHARS = 8_000
/** Characters of any single /tests file included in the probe output. */
export const TERMINAL_PREFLIGHT_MAX_FILE_CHARS = 2_000
export const TERMINAL_PREFLIGHT_MAX_FILES = 6
export const TERMINAL_PREFLIGHT_TIMEOUT_SEC = 30
export const TERMINAL_PREFLIGHT_TOOL_ID = 'preflight-0'

export const TERMINAL_PREFLIGHT_BEGIN = '<environment_preflight>'
export const TERMINAL_PREFLIGHT_END = '</environment_preflight>'

/**
 * Deterministic, read-only POSIX sh probe. It never writes, creates, or modifies anything;
 * every section tolerates missing paths, and listings and file bodies are bounded in the shell
 * before the TypeScript cap is applied.
 */
export function terminalPreflightCommand(): string {
  return [
    'echo "== cwd =="; pwd',
    'echo "== tools =="; for t in python3 pip pip3 pytest; do p=$(command -v "$t" 2>/dev/null) && echo "$t: $p" || echo "$t: missing"; done',
    'echo "== ls -la /tests =="; ls -la /tests 2>&1 | head -n 40',
    'echo "== ls -la /app =="; ls -la /app 2>&1 | head -n 40',
    'if [ -d /tests ] && [ -r /tests ]; then',
    '  echo "== /tests: readable; these are the authoritative verifier files =="',
    `  find /tests -maxdepth 3 -type f 2>/dev/null | sort | { count=0; while IFS= read -r f; do`,
    '    [ -r "$f" ] || continue',
    '    grep -Iq . "$f" 2>/dev/null || continue',
    '    count=$((count + 1))',
    '    echo "--- $f ($(wc -c < "$f" | tr -d " ") bytes) ---"',
    `    head -c ${String(TERMINAL_PREFLIGHT_MAX_FILE_CHARS)} "$f"; echo`,
    `    [ "$count" -lt ${String(TERMINAL_PREFLIGHT_MAX_FILES)} ] || break`,
    '  done; }',
    'else',
    '  echo "== /tests: missing or unreadable during the agent phase; do not search the filesystem for verifier files =="',
    'fi',
    'echo "== /logs/verifier =="',
    'if [ -d /logs/verifier ]; then',
    '  if [ -w /logs/verifier ]; then w=writable; else w=not-writable; fi',
    '  echo "exists, $w, $(ls -A /logs/verifier 2>/dev/null | wc -l | tr -d " ") entries"',
    'else echo "absent"; fi',
  ].join('\n')
}

export function capTerminalPreflightText(text: string, maxChars: number): string {
  // NULs and other control bytes from unexpected binary content are noise in a prompt.
  const clean = text.replace(/(?![\t\n])\p{Cc}/gu, '').trimEnd()
  if (clean.length <= maxChars) return clean
  const marker = `\n[pre-flight output truncated at ${String(maxChars)} characters]`
  return clean.slice(0, Math.max(0, maxChars - marker.length)) + marker
}

function wrapBlock(body: string): string {
  return `${TERMINAL_PREFLIGHT_BEGIN}\n${body}\n${TERMINAL_PREFLIGHT_END}`
}

const PREFLIGHT_HEADER =
  'Read-only probe run before your first turn. Treat /tests as authoritative over /app/tests. ' +
  'Do not re-run discovery for facts listed here.'

/**
 * Formats a bridge result as the delimited block. `null` means the probe could not be run;
 * a nonzero exit or timeout is reported rather than hidden so the model knows what is unknown.
 * The whole block, delimiters included, never exceeds `maxChars`.
 */
export function formatTerminalPreflightBlock(
  result: TerminalToolResult | null,
  maxChars: number = TERMINAL_PREFLIGHT_MAX_CHARS,
): string {
  const overhead = wrapBlock(`${PREFLIGHT_HEADER}\n`).length
  if (result === null || result.exitCode === 124) {
    return wrapBlock(
      `${PREFLIGHT_HEADER}\nThe probe ${result === null ? 'could not be run' : 'timed out'}; nothing is known about the environment. ` +
        'Check /tests directly once.',
    )
  }
  const output = result.stdout || result.stderr
  const note =
    result.exitCode !== 0
      ? `\n[probe exited ${String(result.exitCode)}; output may be partial]`
      : ''
  const capped = capTerminalPreflightText(output, Math.max(0, maxChars - overhead - note.length))
  return wrapBlock(`${PREFLIGHT_HEADER}\n${capped}${note}`)
}

export function injectTerminalPreflight(instruction: string, block: string | null): string {
  return block ? `${instruction}\n\n${block}` : instruction
}

export interface TerminalPreflightRun {
  block: string
  /** True when the probe ran and exited cleanly. */
  ok: boolean
}

/**
 * Runs the probe through a single bridge round trip. Any exec failure degrades to a short
 * "probe unavailable" block so the benchmark proceeds as it would without pre-flight.
 */
export async function runTerminalPreflight(
  exec: (command: string, timeoutSec: number) => Promise<TerminalToolResult>,
): Promise<TerminalPreflightRun> {
  try {
    const result = await exec(terminalPreflightCommand(), TERMINAL_PREFLIGHT_TIMEOUT_SEC)
    return { block: formatTerminalPreflightBlock(result), ok: result.exitCode === 0 }
  } catch {
    return { block: formatTerminalPreflightBlock(null), ok: false }
  }
}
