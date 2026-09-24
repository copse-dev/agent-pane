// Dead-code guard: fail when a product module is unlinked, reachable only from
// support code, or exposes a runtime export that product code never references.
// These leftovers still typecheck and lint in isolation, and tests can make an
// otherwise unshipped module or export look alive, so the normal gates miss them.
//
// How it works: one import walk starts from shipped entry points, and a second
// adds tests, scripts and shims. The difference exposes modules kept alive only
// by support code. A conservative AST pass also finds direct runtime exports in
// `src/` whose identifier appears nowhere else in tracked TypeScript.
//
// A file that is intentionally unreferenced needs a documented reason — add it to
// `ALLOWED_UNLINKED` below. `*.d.ts` ambient declarations are excluded wholesale:
// they are consumed via tsconfig `include`, not via imports, so "unlinked" is
// their normal state.
//
// Run with `pnpm run check:dead-code` (also part of `pnpm run check`).

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'
import ts from 'typescript'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'

const ROOT = resolve(import.meta.dirname, '..')
const SHARED = resolve(ROOT, 'src/shared')

// Files that are deliberately not imported anywhere. Each needs a reason so the
// next person knows it is intentional rather than forgotten dead code.
const ALLOWED_UNLINKED: Record<string, string> = {
  'src/main/services/container-runtime/cli.ts':
    'esbuild entry that scripts/run-thread-container.mts bundles by path (pnpm run thread:container)',
}

// Product modules intentionally exercised only by tests/scripts. Prefer wiring
// or deleting them; this list is for real non-shipping boundaries and every
// entry needs a reason.
const ALLOWED_SUPPORT_ONLY: Record<string, string> = {
  'packages/review/src/fake-container-engine.ts': 'test fixture for the review package',
  'packages/review/src/test-repo.ts': 'test repository fixture for the review package',
  'src/main/services/acp/acp-behavior-matrix.ts': 'manual ACP behavior-probe report formatter',
  'src/main/services/acp/acp-behavior-probe.ts': 'manual ACP behavior probe',
  'src/main/services/acp/acp-capability-probe.ts': 'manual ACP capability probe',
  'src/main/services/acp/acp-long-run-probe.ts': 'manual ACP long-run probe',
  'src/main/services/acp/acp-protocol-negotiate.ts': 'ACP v2 readiness prototype',
  'src/main/services/acp/acp-support-matrix.ts': 'manual ACP capability report formatter',
  'src/main/services/acp/acp-v2-session-adapter.ts': 'ACP v2 readiness prototype',
  'src/main/services/container-runtime/scripted-acp-agent.ts': 'container integration-test fixture',
  'src/main/services/container-runtime/scripted-model-server.ts':
    'container integration-test fixture',
  'src/main/services/providers/test-response.ts': 'shared provider test response fixture',
  'src/main/services/ssh-workspace/fake-ssh-transport.ts': 'SSH integration-test transport',
  'src/main/services/supervisor/event-inbox-store.ts':
    'event automation inbox is not startup-wired yet',
  'src/main/services/supervisor/event-inbox.ts': 'event automation inbox is not startup-wired yet',
  'src/shared/agent/doctrine-compliance.ts': 'nightly and local doctrine evaluation support',
  'src/shared/supervisor/event-inbox-schema.ts': 'event automation inbox is not startup-wired yet',
  'src/shared/types/cursor-hooks.ts': 'documented compatibility re-export for hook dialect types',
}

// Runtime exports in `src/` intentionally consumed outside statically visible
// product TypeScript (for example, by a generated or reflective boundary).
const ALLOWED_UNREFERENCED_EXPORTS: Record<string, string> = {}

const abs = (p: string): string => resolve(ROOT, p)
const isModuleTs = (p: string): boolean => /\.(mts|cts|tsx|ts)$/.test(p) && !p.endsWith('.d.ts')
const isTestModule = (p: string): boolean =>
  /\.(?:test|spec)\.(?:mts|cts|tsx|ts)$/.test(p) ||
  /\.(?:test-shim|test-support)\.(?:mts|cts|tsx|ts)$/.test(p)
const isProductModule = (p: string): boolean =>
  (p.startsWith('src/') || /^packages\/[^/]+\/src\//.test(p)) && isModuleTs(p) && !isTestModule(p)

function git(...args: string[]): string[] {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}

// `git ls-files` includes unstaged deletions. The guard evaluates the working
// tree the developer is about to commit, so paths already removed do not count.
const tracked = git('ls-files').filter((p) => existsSync(abs(p)))

// The universe we police: tracked app and private-workspace package modules.
const candidates = tracked.filter(isProductModule)

// Product roots are runtime entry points that exist for reasons other than
// being imported by another product module.
const productRoots = [
  // Entry points — keep in sync with scripts/build.mts.
  'src/main/index.ts',
  // Spawned by path rather than imported, so only this list links them.
  ...STANDALONE_MAIN_BUNDLES.map((bundle) => bundle.entry),
  'src/preload/index.ts',
  'src/preload/video-decoder.ts',
  // Tauri sidecar bundle entries — keep in sync with scripts/build-tauri.mts.
  'src/sidecar/index.ts',
  'src/sidecar/ws-bridge/entry.ts',
  // Substituted for the `electron` module by esbuild alias rather than
  // imported, so only this list links them (see scripts/build-tauri.mts).
  'src/sidecar/electron-shim/index.ts',
  'src/sidecar/electron-shim/electron-updater.ts',
  'src/sidecar/ws-bridge/electron.ts',
  'src/renderer/main.ts',
  'src/renderer/demo/main.ts',
  // Standalone bundle injected lazily at runtime (not imported by product code).
  'src/renderer/monaco/monaco-global.ts',
  // Hidden video-decoder window's page bundle (main/services/video opens it).
  'src/renderer/video/decoder.ts',
  'src/renderer/markdown/mermaid-frame-entry.ts',
  // Each private package's manifest exports its barrel as the package root.
  ...tracked.filter((p) => /^packages\/[^/]+\/src\/index\.ts$/.test(p)),
  // Private-package command entry points are invoked by package.json `bin`,
  // rather than imported by the desktop bundles.
  ...tracked.filter((p) => /^packages\/[^/]+\/bin\/.*\.(?:mjs|cjs|js)$/.test(p)),
].filter((p) => existsSync(abs(p)))

const supportRoots = [
  ...tracked.filter(isTestModule),
  ...tracked.filter((p) => p.startsWith('tests/') && isModuleTs(p)),
  ...tracked.filter((p) => p.startsWith('scripts/') && isModuleTs(p)),
  'wdio.conf.ts',
  'wdio.demo.conf.ts',
  'wdio.eval.conf.ts',
].filter((p) => existsSync(abs(p)))

// Matches the specifier string in `from 'x'`, `import 'x'`, `import('x')`,
// `require('x')` and `export … from 'x'` — including the type-position
// `import('x').Foo` form, which still references the file textually.
const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s+[^;'"]*\bfrom\s+)['"]([^'"]+)['"]/g

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string
  if (spec === '@shared' || spec.startsWith('@shared/')) {
    base = resolve(SHARED, spec.slice('@shared'.length).replace(/^\//, ''))
  } else if (spec.startsWith('@copse/')) {
    const match = /^@copse\/([^/]+)(?:\/(.*))?$/.exec(spec)
    if (!match?.[1]) return null
    base = resolve(ROOT, 'packages', match[1], 'src', match[2] ?? 'index')
  } else if (spec.startsWith('.')) {
    base = resolve(dirname(abs(fromFile)), spec)
  } else {
    return null // bare specifier → external dependency
  }
  const tries = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
    resolve(base, 'index.mts'),
    resolve(base, 'index.cts'),
  ]
  for (const candidate of tries) {
    if (existsSync(candidate) && /\.(mts|cts|tsx|ts)$/.test(candidate)) {
      return relative(ROOT, candidate)
    }
  }
  return null
}

async function walk(roots: readonly string[]): Promise<Set<string>> {
  const visited = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || visited.has(file)) continue
    visited.add(file)
    let source: string
    try {
      source = await readFile(abs(file), 'utf8')
    } catch {
      continue
    }
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1]
      if (!spec) continue
      const resolved = resolveSpecifier(spec, file)
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return visited
}

const productVisited = await walk(productRoots)
const allVisited = await walk([...productRoots, ...supportRoots])

const allowed = new Set(Object.keys(ALLOWED_UNLINKED))
const dead = candidates.filter((p) => !allVisited.has(p) && !allowed.has(p)).sort()
const allowedSupportOnly = new Set(Object.keys(ALLOWED_SUPPORT_ONLY))
const supportOnly = candidates
  .filter((p) => allVisited.has(p) && !productVisited.has(p) && !allowedSupportOnly.has(p))
  .sort()

interface RuntimeExport {
  file: string
  name: string
}

const identifierCounts = new Map<string, number>()
const runtimeExports: RuntimeExport[] = []
for (const file of tracked.filter(isModuleTs)) {
  const source = ts.createSourceFile(
    file,
    await readFile(abs(file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      identifierCounts.set(node.text, (identifierCounts.get(node.text) ?? 0) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (!candidates.includes(file) || !file.startsWith('src/')) continue
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) runtimeExports.push({ file, name: statement.name.text })
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          runtimeExports.push({ file, name: declaration.name.text })
        }
      }
    }
  }
}

const allowedUnreferencedExports = new Set(Object.keys(ALLOWED_UNREFERENCED_EXPORTS))
const unusedRuntimeExports = runtimeExports.filter(({ name }) => identifierCounts.get(name) === 1)
const unusedExports = unusedRuntimeExports
  .filter(({ file, name }) => !allowedUnreferencedExports.has(`${file}:${name}`))
  .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

// Surface stale allowlist entries so the list cannot silently rot either.
const staleUnlinked = [...allowed]
  .filter((p) => allVisited.has(p) || !candidates.includes(p))
  .sort()
const staleSupportOnly = [...allowedSupportOnly]
  .filter((p) => productVisited.has(p) || !allVisited.has(p) || !candidates.includes(p))
  .sort()
const runtimeExportKeys = new Set(runtimeExports.map(({ file, name }) => `${file}:${name}`))
const staleUnreferencedExports = [...allowedUnreferencedExports]
  .filter(
    (key) =>
      !runtimeExportKeys.has(key) ||
      !unusedRuntimeExports.some(({ file, name }) => `${file}:${name}` === key),
  )
  .sort()
const staleAllow = [...staleUnlinked, ...staleSupportOnly, ...staleUnreferencedExports]
if (staleAllow.length > 0) {
  console.warn('Stale dead-code allowlist entries (now live or removed — drop them):')
  for (const entry of staleAllow) console.warn(`  ${entry}`)
  console.warn('')
}

if (dead.length === 0 && supportOnly.length === 0 && unusedExports.length === 0) {
  console.log(
    `check-dead-code: OK — all ${String(candidates.length)} product modules and runtime exports are reachable.`,
  )
  if (staleAllow.length > 0) process.exit(1)
  process.exit(0)
}

if (dead.length > 0) {
  console.error(`check-dead-code: found ${String(dead.length)} unlinked product module(s):\n`)
  for (const p of dead) console.error(`  ${p}`)
}
if (supportOnly.length > 0) {
  console.error(`check-dead-code: found ${String(supportOnly.length)} support-only module(s):\n`)
  for (const p of supportOnly) console.error(`  ${p}`)
}
if (unusedExports.length > 0) {
  console.error(
    `check-dead-code: found ${String(unusedExports.length)} unreferenced runtime export(s):\n`,
  )
  for (const { file, name } of unusedExports) console.error(`  ${file}:${name}`)
}
console.error(
  '\nDelete or wire each item. If a non-shipping boundary is intentional, add it to\n' +
    'the matching allowlist in scripts/check-dead-code.mts with a reason.',
)
process.exit(1)
