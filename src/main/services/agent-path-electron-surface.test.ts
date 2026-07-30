import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, normalize } from 'node:path'
import { describe, it } from 'node:test'

// Benchmarks reach the model through their own bridge rather than the path a
// user's work takes (#1272), and the first thing blocking a shared path is that
// the product's own agent construction cannot be imported without Electron
// (#1313). This pins the runtime surface at zero. Type-only Electron imports
// are harmless here: TypeScript erases them, so Node never resolves Electron.

const ROOTS = [
  'src/main/services/headless-agent-host.ts',
  'src/main/services/registry-bootstrap.ts',
  'src/main/services/agent-system-prompt.ts',
]

const ALIASES: [string, string][] = [
  ['@shared/', 'src/shared/'],
  ['@copse/agent/', 'packages/agent/src/'],
  ['@copse/llm/', 'packages/llm/src/'],
]

function resolveImport(specifier: string, from: string): string | null {
  let path: string
  if (specifier.startsWith('.')) {
    path = normalize(join(dirname(from), specifier))
  } else {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix))
    if (!alias) return null
    path = normalize(specifier.replace(alias[0], alias[1]))
  }
  return existsSync(path) ? path : null
}

interface StaticImport {
  specifier: string
  typeOnly: boolean
}

function staticImports(source: string): StaticImport[] {
  const imports: StaticImport[] = []
  const pattern = /import\s+['"]([^'"]+)['"]|import\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const sideEffectSpecifier = match[1]
    const fromSpecifier = match[3]
    const specifier = sideEffectSpecifier ?? fromSpecifier
    if (specifier !== undefined) {
      imports.push({
        specifier,
        typeOnly: sideEffectSpecifier === undefined && match[2] !== undefined,
      })
    }
  }
  return imports
}

function electronImportPaths(roots: string[]): string[] {
  const seen = new Set(roots)
  const queue = roots.map((file) => ({ file, path: [file] }))
  const found: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const { file, path } = current
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const imports = staticImports(source).filter((entry) => !entry.typeOnly)
    if (imports.some((entry) => entry.specifier === 'electron')) found.push(path.join(' -> '))
    for (const entry of imports) {
      const resolved = resolveImport(entry.specifier, file)
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push({ file: resolved, path: [...path, resolved] })
      }
    }
  }
  return found.sort()
}

describe('agent construction Electron surface', () => {
  it('constructs a registry and prompt under plain Node with Electron blocked', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-agent-path-import.mts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  })

  it('has no runtime Electron import reachable from any construction root', () => {
    const actual = electronImportPaths(ROOTS)
    assert.deepEqual(
      actual,
      [],
      `Runtime Electron dependency reachable from the product's agent construction. ` +
        `Inject the desktop capability at the Electron entry point; type-only imports are safe.`,
    )
  })

  it('keeps settings loadable without Electron, since 36 modules import it', () => {
    // The single highest-leverage edge: `safeStorage` sat at module scope in
    // settings.ts, so every importer inherited Electron. It now asks
    // secret-cipher.ts for whichever cipher is installed.
    const source = readFileSync('src/main/services/storage/settings.ts', 'utf8')
    assert.ok(!source.includes(`from 'electron'`), 'settings.ts must not import Electron')
  })
})
