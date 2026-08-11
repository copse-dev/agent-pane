import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

/**
 * Structural guard: a child process that owns its stdout as a wire protocol must
 * never log to stdout anywhere in its reachable module graph.
 *
 * Why a test rather than more ESLint. `console.info` / `console.log` write to
 * stdout, and several spawned helpers reserve stdout byte-for-byte for a framed
 * protocol (ACP NDJSON streams in `acp-session-host-worker.ts`,
 * `acp-probe-worker.ts`, `acp-agent-server.ts`; the sandbox fs worker; the plugin
 * tool worker; the ssh askpass helper). A single `console.info` hidden in a
 * shared module those workers import transitively injects one garbage line into
 * the protocol stream — exactly the regression `console.info` in
 * `network-scope.ts` caused when its `[network-scope]` log line was parsed as
 * ACP JSON-RPC. That shared module is NOT one of the worker files, so a file-glob
 * lint over `*-worker.ts` can never see it. This test resolves the import graph
 * from the known stdout-owning entry points and fails only when a *reachable*
 * non-entry module logs to stdout. Mirrors `module-boundaries.test.ts`'s approach
 * of resolving specifiers rather than globbing them.
 */

/** Entry points that own their stdout as a wire protocol. */
const STDOUT_PROTOCOL_ENTRIES: readonly string[] = [
  'src/main/services/acp/acp-session-host-worker.ts',
  'src/main/services/acp/acp-probe-worker.ts',
  'src/main/services/acp/acp-agent-server.ts',
  'src/main/project-sandbox/sandbox-fs-worker.ts',
  'src/main/services/plugins/plugin-tool-worker.ts',
  'src/main/services/ssh-workspace/askpass-helper.ts',
]

// Paths resolve against the repo root (the test runner's CWD), matching
// `module-boundaries.test.ts`. `import.meta.dirname` is unavailable because the
// tests are esbuild-bundled to CommonJS in `dist-test/`.
const ROOT = resolve('.')

const ALIASES: readonly (readonly [string, string])[] = [
  ['@shared/', 'src/shared/'],
  ['@copse/agent/', 'packages/agent/src/'],
  ['@copse/llm/', 'packages/llm/src/'],
  ['@copse/plan-usage/', 'packages/plan-usage/src/'],
]

const IMPORT_PATTERN =
  /^import\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|^export\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm

function resolveImport(specifier: string, from: string): string | null {
  let path: string
  if (specifier.startsWith('.')) {
    path = normalize(join(dirname(from), specifier))
  } else {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix))
    if (!alias) return null
    path = normalize(specifier.replace(alias[0], alias[1]))
  }
  if (!path.startsWith(ROOT)) path = resolve(ROOT, path)
  if (existsSync(path)) return path
  if (existsSync(path + '.ts')) return path + '.ts'
  if (existsSync(path + '.mts')) return path + '.mts'
  return null
}

function reachableFrom(entry: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [resolve(ROOT, entry)]
  while (stack.length > 0) {
    const file = stack.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    out.push(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[2] ?? match[3]
      if (specifier === undefined) continue
      const target = resolveImport(specifier, file)
      if (target !== null && (target.endsWith('.ts') || target.endsWith('.mts'))) {
        stack.push(target)
      }
    }
  }
  return out
}

/** Source locations of stdout-directed `console.info` / `console.log` calls. */
function stdoutConsoleLocations(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const re = /\bconsole\.(info|log)\s*\(/g
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const line = String(source.slice(0, match.index).split('\n').length)
    out.push(`${file.slice(ROOT.length + 1)}:${line} (console.${String(match[1])})`)
  }
  return out
}

describe('stdout-protocol child processes stay on stderr for diagnostics', () => {
  it("keeps console.info/console.log out of a stdout-owning worker's reachable graph", () => {
    // Dedupe across entry points: the same shared module can be reachable from
    // several workers, and one violation should read once, not once per parent.
    const set = new Set<string>()
    for (const entry of STDOUT_PROTOCOL_ENTRIES) {
      for (const file of reachableFrom(entry)) {
        for (const loc of stdoutConsoleLocations(file)) set.add(loc)
      }
    }
    const violations = [...set]
    assert.deepEqual(
      violations,
      [],
      'A module reachable from a stdout-protocol worker logs to stdout via ' +
        'console.info/console.log — these write to process.stdout and corrupt the ' +
        'framed protocol stream (see network-scope.ts history). Use ' +
        'console.error/console.warn for diagnostics so they go to stderr.',
    )
  })
})
