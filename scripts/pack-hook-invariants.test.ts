import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * electron-builder loads the hooks named in the `build` block as standalone
 * files from the project root, outside the dependency graph, so they resolve a
 * bare import through top-level `node_modules/` alone. pnpm's isolated linker
 * symlinks only *direct* dependencies there, and a transitive one still
 * resolves in local dev — Node walks up into a parent checkout's
 * `node_modules/` — so the failure surfaces first as a broken release build.
 * That is how `import('builder-util')` reached signing before it was pinned to
 * electron-builder, which is declared and re-exports the same `Arch`.
 */
describe('electron-builder hook invariants', () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  /** One field of a parsed JSON object, without assuming the shape around it. */
  function field(source: unknown, name: string): unknown {
    if (typeof source !== 'object' || source === null) return undefined
    return Reflect.get(source, name)
  }

  /** The package names keying a `{ name: range }` dependency map. */
  function dependencyNames(source: unknown): string[] {
    if (typeof source !== 'object' || source === null) return []
    return Object.keys(source)
  }

  const declared = new Set(
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((name) =>
      dependencyNames(field(manifest, name)),
    ),
  )

  /** Every `*.cjs` path anywhere under the `build` block — the hooks. */
  function hookFiles(node: unknown, found: string[] = []): string[] {
    if (typeof node === 'string') {
      if (node.endsWith('.cjs')) found.push(node)
    } else if (Array.isArray(node)) {
      for (const item of node) hookFiles(item, found)
    } else if (typeof node === 'object' && node !== null) {
      for (const value of Object.values(node)) hookFiles(value, found)
    }
    return found
  }

  /** Package names behind the bare `import()`/`require()`/`from` specifiers. */
  function bareImports(source: string): string[] {
    const names = new Set<string>()
    for (const [, specifier] of source.matchAll(
      /(?:import\(|require\(|from\s+)['"]([^'"]+)['"]/g,
    )) {
      // Relative paths, subpath imports, and `node:`/`data:` URLs never reach
      // node_modules; everything else is a package name, bare or scoped.
      if (specifier === undefined || /^[./#]/.test(specifier) || specifier.includes(':')) continue
      const segments = specifier.split('/')
      // `split` always yields a first segment; the fallback is for the type only.
      names.add(
        specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier),
      )
    }
    return [...names]
  }

  const hooks = hookFiles(field(manifest, 'build'))

  it('names hooks that are on disk', () => {
    assert.ok(hooks.length > 0, 'expected at least one .cjs hook in the build block')
    for (const hook of hooks) {
      assert.ok(existsSync(resolve(hook)), `${hook} is named in the build block but missing`)
    }
  })

  it('imports only packages package.json declares', () => {
    for (const hook of hooks) {
      for (const name of bareImports(readFileSync(resolve(hook), 'utf8'))) {
        assert.ok(
          declared.has(name),
          `${hook} imports "${name}", which package.json does not declare as a direct ` +
            `dependency — pnpm gives it no top-level symlink, so packaging fails on a ` +
            `clean install even though it resolves locally`,
        )
      }
    }
  })
})
