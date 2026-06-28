// Dead-code guard: fail when a `src/**/*.ts` module is "unlinked" — i.e. nothing
// in the build graph (entry points, tests, scripts) imports it. Such files are
// usually leftovers from a refactor: they still typecheck and lint in isolation,
// so the normal gates never catch them, but they ship nothing and rot.
//
// How it works: starting from the real roots (the same entry points `build.mts`
// bundles, plus every test, script and shim), we walk import/require/dynamic-import
// specifiers, resolving the `@shared/*` alias and TS extensions exactly like the
// bundler does. Any tracked `src/**/*.ts` we never reach is reported.
//
// A file that is intentionally unreferenced needs a documented reason — add it to
// `ALLOWED_UNLINKED` below. `*.d.ts` ambient declarations are excluded wholesale:
// they are consumed via tsconfig `include`, not via imports, so "unlinked" is
// their normal state.
//
// Run with `npm run check:dead-code` (also part of `npm run check`).

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, relative } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SHARED = resolve(ROOT, 'src/shared')

// Files that are deliberately not imported anywhere. Each needs a reason so the
// next person knows it is intentional rather than forgotten dead code.
const ALLOWED_UNLINKED: Record<string, string> = {
  // ACP client-role protocol core (consume external ACP agents). Landed ahead of
  // the app wiring (model-picker `acp:*` routing + settings UI) and exercised via
  // the loopback test against the SDK directly, so nothing imports these yet.
  // Tracked in #264 (Track 1); drop these once the client is wired into the router.
  'src/shared/types/acp.ts':
    'AcpAgentConfig for the ACP client registry; consumed once client config persistence lands (#264)',
}

const abs = (p: string) => resolve(ROOT, p)
const isModuleTs = (p: string) => /\.(mts|cts|tsx|ts)$/.test(p) && !p.endsWith('.d.ts')

function git(...args: string[]): string[] {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}

const tracked = git('ls-files')

// The universe we police: tracked product modules under src/ (ambient `.d.ts`
// declarations and test files are handled separately below).
const candidates = tracked.filter(
  (p) => p.startsWith('src/') && isModuleTs(p) && !/\.test\.ts$/.test(p),
)

// Roots seed the reachability walk. These are the things that exist for reasons
// other than being imported by product code: the bundler entry points, every
// test (a module used only by its test is still "linked"), test shims wired in
// by build.mts, and the standalone scripts / e2e config.
const roots = [
  // Entry points — keep in sync with scripts/build.mts.
  'src/main/index.ts',
  'src/main/project-sandbox/sandbox-fs-worker.ts',
  'src/preload/index.ts',
  'src/renderer/main.ts',
  // Standalone bundle injected lazily at runtime (not imported by product code).
  'src/renderer/monaco/monaco-global.ts',
  ...tracked.filter((p) => /\.test\.ts$/.test(p)),
  ...tracked.filter((p) => p.startsWith('src/') && /\.test-shim\.ts$/.test(p)),
  ...tracked.filter((p) => p.startsWith('tests/') && isModuleTs(p)),
  ...tracked.filter((p) => p.startsWith('scripts/') && isModuleTs(p)),
  'wdio.conf.ts',
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
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ]
  for (const candidate of tries) {
    if (existsSync(candidate) && /\.(mts|cts|tsx|ts)$/.test(candidate)) {
      return relative(ROOT, candidate)
    }
  }
  return null
}

const visited = new Set<string>()
const queue = [...roots]
while (queue.length > 0) {
  const file = queue.pop()!
  if (visited.has(file)) continue
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

const allowed = new Set(Object.keys(ALLOWED_UNLINKED))
const dead = candidates.filter((p) => !visited.has(p) && !allowed.has(p)).sort()

// Surface stale allowlist entries so the list cannot silently rot either.
const staleAllow = [...allowed].filter((p) => visited.has(p) || !candidates.includes(p)).sort()
if (staleAllow.length > 0) {
  console.warn('Stale ALLOWED_UNLINKED entries (now reachable or removed — drop them):')
  for (const p of staleAllow) console.warn(`  ${p}`)
  console.warn('')
}

if (dead.length === 0) {
  console.log(`check-dead-code: OK — all ${candidates.length} src modules are reachable.`)
  if (staleAllow.length > 0) process.exit(1)
  process.exit(0)
}

console.error(`check-dead-code: found ${dead.length} unlinked file(s) under src/:\n`)
for (const p of dead) console.error(`  ${p}`)
console.error(
  '\nNothing in the build graph (entry points, tests, scripts) imports these files.\n' +
    'Either delete them, or — if a file is intentionally unreferenced — add it to\n' +
    'ALLOWED_UNLINKED in scripts/check-dead-code.mts with a reason.',
)
process.exit(1)
