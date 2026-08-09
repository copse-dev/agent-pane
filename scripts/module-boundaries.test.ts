import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

/**
 * Structural pins for the import direction between the four source zones and the
 * extracted packages. Companion to `agent-path-electron-surface.test.ts` (which owns the
 * Electron boundary) and to the `no-restricted-imports` rule in `eslint.config.mjs`.
 *
 * Why a test rather than more ESLint. The Electron rule bans a BARE MODULE NAME, so a
 * glob over the import specifier is exact. These rules are about the ZONE OF THE RESOLVED
 * FILE, which a specifier glob gets wrong in both directions here: the specifiers are
 * relative and vary by nesting depth (`../main/…` from `src/renderer/x.ts`,
 * `../../../main/…` from `src/renderer/a/b/x.ts`), and `src/renderer/main.ts` and
 * `src/renderer/demo/main.ts` both exist, so any pattern loose enough to catch the first
 * problem also blocks a renderer file importing its own entry point. Resolving the
 * specifier and asking which zone the file lands in has neither failure mode.
 *
 * What the boundary buys, concretely. Today `agent-tasks.ts` RESPECTS it by hand-copying
 * `stripTerminalControlSequences` out of `subprocess-output-cap.ts` — its comment says the
 * copy exists "to avoid importing a main-process module into the renderer bundle" — while
 * `settings-dialog.ts` reaches straight through it twice. One file pays for the rule in
 * duplicated code, the other ignores it, and nothing tells either of them.
 */

const ZONE_ROOTS = [
  ['src/main/', 'main'],
  ['src/renderer/', 'renderer'],
  ['src/preload/', 'preload'],
  ['src/shared/', 'shared'],
  ['packages/', 'packages'],
] as const

type Zone = (typeof ZONE_ROOTS)[number][1]

/**
 * Which zones each zone may import from. The shape is a layering, not a preference:
 * `shared` and the extracted `packages/*` are the common base, `main` / `renderer` /
 * `preload` are the three processes, and none of the three may reach into another.
 *
 * `renderer -> preload` is the bridge contract (`preload/api.d.ts`), which is how the
 * renderer is supposed to reach the main process. `preload` itself imports only
 * `@shared/*` and `electron`, so it gets no exception it does not use.
 *
 * `packages -> *` is deliberately just `packages`: `@copse/agent` and `@copse/llm` were
 * extracted so they could stand alone, and an import back into `src/` would quietly undo
 * that while still compiling.
 */
const ALLOWED_TARGETS: Readonly<Record<Zone, readonly Zone[]>> = {
  main: ['shared', 'packages'],
  renderer: ['shared', 'packages', 'preload'],
  preload: ['shared', 'packages'],
  shared: ['packages'],
  packages: ['packages'],
}

const ALIASES: readonly (readonly [string, string])[] = [
  ['@shared/', 'src/shared/'],
  ['@copse/agent/', 'packages/agent/src/'],
  ['@copse/llm/', 'packages/llm/src/'],
  ['@copse/plan-usage/', 'packages/plan-usage/src/'],
]

/**
 * Known crossings that are allowed to stand, each with the reason and the way out.
 *
 * This list is deliberately not a suppression baseline: the second test below fails when
 * an entry stops matching a real import, so fixing the import forces the exception to be
 * deleted in the same change. That mirrors `reportUnusedDisableDirectives` in
 * `eslint.config.mjs` — an exemption that no longer exempts anything is as misleading as a
 * missing rule.
 */
const EXCEPTIONS: readonly { from: string; to: string; reason: string }[] = [
  {
    from: 'src/renderer/views/settings-dialog.ts',
    to: 'src/main/services/advisor-strategy.ts',
    reason:
      'Pulls the pure `validateAdvisorPair` out of a main-process module. Harmless at ' +
      'runtime (advisor-strategy imports only @shared and @copse/llm) but pointed the ' +
      'wrong way. Fix by moving the validator to src/shared; sequenced behind the ' +
      'in-flight advisor work rather than done here.',
  },
  {
    from: 'src/renderer/views/settings-dialog.ts',
    to: 'src/main/services/orchestration-strategy.ts',
    reason:
      'Pulls the DEFAULT_ORCHESTRATION_WORKER_MODEL constant out of a main-process ' +
      'module. Same shape and same fix as the advisor import above: the constant is ' +
      'shared vocabulary and belongs in src/shared.',
  },
]

/**
 * Static `import ... from '…'`, side-effect `import '…'`, and re-exporting
 * `export ... from '…'`. Inline `import('…').Type` type expressions are deliberately not
 * matched: they are erased, and every one in the tree today points at `@shared/types`.
 */
const IMPORT_PATTERN =
  /^import\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|^export\s+(type\s+)?[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm

interface Crossing {
  readonly from: string
  readonly to: string
  readonly specifier: string
}

function zoneOf(path: string): Zone | null {
  const match = ZONE_ROOTS.find(([prefix]) => path.startsWith(prefix))
  return match ? match[1] : null
}

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

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...sourceFiles(path))
      continue
    }
    // Test files and their support modules are excluded: a double legitimately reaches
    // for the thing it stands in for, and the boundary exists to protect the shipped
    // bundle, which contains neither.
    if (!/\.(ts|mts)$/.test(entry.name)) continue
    if (/\.test\.ts$/.test(entry.name) || /\.test-support\.ts$/.test(entry.name)) continue
    out.push(path)
  }
  return out
}

function crossings(): Crossing[] {
  const found: Crossing[] = []
  for (const file of [...sourceFiles('src'), ...sourceFiles('packages')]) {
    const fromZone = zoneOf(file)
    if (fromZone === null) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[2] ?? match[3] ?? match[5]
      if (specifier === undefined) continue
      const target = resolveImport(specifier, file)
      if (target === null) continue
      const toZone = zoneOf(target)
      if (toZone === null || toZone === fromZone) continue
      if (ALLOWED_TARGETS[fromZone].includes(toZone)) continue
      found.push({ from: file, to: target, specifier })
    }
  }
  return found
}

describe('module boundaries', () => {
  it('keeps every zone importing only from the zones below it', () => {
    const unexpected = crossings()
      .filter((c) => !EXCEPTIONS.some((e) => e.from === c.from && e.to === c.to))
      .map((c) => `${c.from} -> ${c.specifier}`)
      .sort()
    assert.deepEqual(
      unexpected,
      [],
      'Import crosses a zone boundary in a direction that is not allowed. Move the shared ' +
        'piece into src/shared (or an extracted package) rather than reaching across, or — ' +
        'if the crossing is genuinely intended — add it to EXCEPTIONS above with a reason.',
    )
  })

  it('drops an exception as soon as the import it covers is gone', () => {
    const live = crossings()
    const stale = EXCEPTIONS.filter(
      (e) => !live.some((c) => c.from === e.from && c.to === e.to),
    ).map((e) => `${e.from} -> ${e.to}`)
    assert.deepEqual(
      stale,
      [],
      'These EXCEPTIONS no longer match a real import. Delete them: an exemption that ' +
        'exempts nothing reads like a boundary that is still being violated.',
    )
  })
})
