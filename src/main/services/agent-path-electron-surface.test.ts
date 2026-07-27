import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, it } from 'node:test'

// Benchmarks reach the model through their own bridge rather than the path a
// user's work takes (#1272), and the first thing blocking a shared path is that
// the product's own agent construction cannot be imported without Electron
// (#1313). This pins that surface so it can only shrink.
//
// A count alone would not do: an edge removed here and re-added there nets to
// zero. Pinning the exact set makes both directions visible.

const ROOTS = [
  'src/main/services/registry-bootstrap.ts',
  'src/main/services/agent-system-prompt.ts',
]

/**
 * Files reachable from the roots that import Electron directly. Each one is
 * either a feature a headless caller does not need, a prompt no headless caller
 * can answer, or a layering slip. Removing one is progress on #1313 — update
 * this list when you do.
 */
const ELECTRON_SURFACE = [
  // Prompts a human. A non-interactive run never reaches these.
  'src/main/services/approval.ts',
  'src/main/services/ask-user.ts',
  'src/main/services/ssh-workspace/ssh-prompt.ts',
  // Optional features, each behind an enablement check already.
  'src/main/services/browser/session-manager.ts',
  'src/main/services/diagnostics/checkup.ts',
  'src/main/services/mcp/custom-tools-registry.ts',
  'src/main/services/mcp/mcp-registry.ts',
  'src/main/services/search/semantic-index.ts',
  'src/main/services/video/video-decoder.ts',
  // Renderer plumbing pulled in by the file tools; 7 importers, so the fix is
  // to make the module Electron-free rather than to cut the edges.
  'src/main/services/diff-queue.ts',
  'src/main/ipc/ipc-guards.ts',
  // Window/UI, reachable only through the three above. Layering slips rather
  // than things a tool genuinely needs.
  'src/main/app-icon.ts',
  'src/main/windows/app-frames.ts',
  'src/main/windows/boot-theme.ts',
  'src/main/windows/browser-web-contents.ts',
  'src/main/windows/create-main-window.ts',
  'src/main/windows/web-contents-lockdown.ts',
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

function electronImporters(roots: string[]): string[] {
  const seen = new Set(roots)
  const queue = [...roots]
  const found: string[] = []
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined) break
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (/from 'electron'/.test(source)) found.push(file)
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const resolved = resolveImport(match[1] ?? '', file)
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push(resolved)
      }
    }
  }
  return found.sort()
}

describe('agent construction Electron surface', () => {
  it('reaches exactly the Electron imports we have not yet cut', () => {
    const actual = electronImporters(ROOTS)
    const expected = [...ELECTRON_SURFACE].sort()
    const added = actual.filter((file) => !expected.includes(file))
    const removed = expected.filter((file) => !actual.includes(file))
    assert.deepEqual(
      added,
      [],
      `New Electron dependency reachable from the product's agent construction. ` +
        `This blocks running benchmarks on the real agent path (#1313). Inject the ` +
        `dependency the way secret-cipher.ts and shell-output-context.ts do, or ` +
        `import it lazily behind its enablement check.`,
    )
    assert.deepEqual(
      removed,
      [],
      `An Electron dependency was removed — good. Delete it from ELECTRON_SURFACE ` +
        `so the surface cannot silently grow back.`,
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
