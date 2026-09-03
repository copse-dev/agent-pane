import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { safeJsonParse } from '../src/shared/safe-json.ts'

const WORKSPACE_PACKAGES = [
  ['packages/agent', '@copse/agent'],
  ['packages/extract-zip', 'extract-zip'],
  ['packages/llm', '@copse/llm'],
  ['packages/plan-usage', '@copse/plan-usage'],
  ['packages/std', '@copse/std'],
  ['packages/hooks-dialects', '@copse/hooks-dialects'],
] as const

function field(source: unknown, name: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return Reflect.get(source, name)
}

function stringField(source: unknown, name: string): string | null {
  const value = field(source, name)
  return typeof value === 'string' ? value : null
}

function record(source: unknown): Readonly<Record<string, unknown>> {
  if (typeof source !== 'object' || source === null) return {}
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(source)) output[key] = Reflect.get(source, key)
  return output
}

function dependencyMap(source: unknown): Readonly<Record<string, unknown>> {
  return record(field(source, 'dependencies'))
}

function manifest(directory: string): unknown {
  const parsed = safeJsonParse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  assert.ok(parsed !== null, `${directory}/package.json must contain valid JSON`)
  return parsed
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      files.push(...sourceFiles(path))
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.mts') || entry.name.endsWith('.cjs'))
    ) {
      files.push(path)
    }
  }
  return files
}

function packageName(specifier: string): string | null {
  if (/^[./#]/.test(specifier) || specifier.startsWith('node:')) return null
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier)
}

function bareImports(directory: string): string[] {
  const imports = new Set<string>()
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, 'utf8')
    const specifiers: string[] = []
    let declaration = ''
    for (const line of source.split('\n')) {
      const trimmed = line.trimStart()
      if (
        declaration === '' &&
        (/^import\s+(?!\()/.test(trimmed) || /^export\s+(?:type\s+)?(?:\{|\*)/.test(trimmed))
      ) {
        declaration = trimmed
      } else if (declaration !== '') {
        declaration += `\n${trimmed}`
      }
      if (declaration === '') continue
      const from = declaration.match(/\bfrom\s+['"]([^'"]+)['"]/)?.[1]
      const sideEffect = declaration.match(/^import\s+['"]([^'"]+)['"]/)?.[1]
      const specifier = from ?? sideEffect
      if (specifier === undefined) continue
      specifiers.push(specifier)
      declaration = ''
    }
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (match[1] !== undefined) specifiers.push(match[1])
    }
    for (const specifier of specifiers) {
      const name = packageName(specifier)
      if (name !== null) imports.add(name)
    }
  }
  return [...imports].sort()
}

describe('workspace package manifests', () => {
  const root = manifest('.')

  it('registers every package directory as a pnpm workspace importer', () => {
    const workspace = readFileSync(resolve('pnpm-workspace.yaml'), 'utf8')
    assert.match(workspace, /^packages:\n {2}- 'packages\/\*'$/m)
    for (const [directory, name] of WORKSPACE_PACKAGES) {
      assert.equal(stringField(manifest(directory), 'name'), name)
    }
  })

  it('declares every app-consumed package through the workspace protocol', () => {
    const rootDependencies = {
      ...dependencyMap(root),
      ...record(field(root, 'devDependencies')),
    }
    for (const [, name] of WORKSPACE_PACKAGES) {
      assert.equal(
        Reflect.get(rootDependencies, name),
        'workspace:*',
        `${name} must be a direct workspace dependency of the app`,
      )
    }
  })

  it('declares every bare source import in its owning package manifest', () => {
    for (const [directory] of WORKSPACE_PACKAGES) {
      const imports = bareImports(directory)
      const declared = dependencyMap(manifest(directory))
      for (const imported of imports) {
        assert.ok(
          Object.hasOwn(declared, imported),
          `${directory} imports ${imported} without declaring it as a dependency`,
        )
      }
    }
  })

  it('uses the workspace protocol for inter-package dependencies', () => {
    for (const [directory] of WORKSPACE_PACKAGES) {
      for (const [name, specifier] of Object.entries(dependencyMap(manifest(directory)))) {
        if (!name.startsWith('@copse/')) continue
        assert.equal(specifier, 'workspace:*', `${directory} must link ${name} through pnpm`)
      }
    }
  })

  it('keeps shared third-party dependency ranges aligned with the app', () => {
    const rootDependencies = dependencyMap(root)
    for (const [directory] of WORKSPACE_PACKAGES) {
      for (const [name, specifier] of Object.entries(dependencyMap(manifest(directory)))) {
        if (!Object.hasOwn(rootDependencies, name)) continue
        assert.equal(
          specifier,
          Reflect.get(rootDependencies, name),
          `${directory} and the app declare different ${name} ranges`,
        )
      }
    }
  })

  it('exports both bare and TypeScript-suffixed source subpaths', () => {
    for (const [directory, name] of WORKSPACE_PACKAGES) {
      if (name === 'extract-zip') continue
      const exports = field(manifest(directory), 'exports')
      assert.equal(stringField(exports, '.'), './src/index.ts')
      assert.equal(stringField(exports, './*.ts'), './src/*.ts')
      assert.equal(stringField(exports, './*'), './src/*.ts')
    }
  })
})

describe('workspace package resolution', () => {
  it('has no tsconfig or esbuild source aliases for workspace packages', () => {
    for (const file of ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']) {
      assert.doesNotMatch(
        readFileSync(resolve(file), 'utf8'),
        /"@copse\/(?:agent|hooks-dialects|llm|plan-usage|std)/,
      )
    }
    for (const file of sourceFiles('scripts')) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /['"]@copse\/(?:agent|hooks-dialects|llm|plan-usage|std)['"]\s*:\s*(?:resolve|new URL)/,
        `${file} must resolve workspace packages through their manifests`,
      )
    }
  })

  it('has no relative imports that bypass package exports', () => {
    for (const file of sourceFiles('scripts')) {
      assert.doesNotMatch(
        readFileSync(file, 'utf8'),
        /from ['"][^'"]*packages\/(?:agent|hooks-dialects|llm|plan-usage|std)\/src\//,
        `${file} bypasses a workspace package boundary`,
      )
    }
  })
})
