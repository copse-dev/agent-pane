import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ESLint } from 'eslint'
import picomatch from 'picomatch'
import { z } from 'zod'
import { isRecord } from '../src/shared/unknown-value.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

/**
 * `.oxlintrc.json` is a hand-kept port of `eslint.config.mjs`. ESLint is the
 * lint gate, but the post-edit hook runs oxlint on every edit, so if the two
 * drift apart agents are shown findings the gate will not raise — or miss ones
 * it will. This pins them together at two levels:
 *
 * - **Structure.** Every block of `eslint.config.mjs` that sets rules or
 *   globals has an oxlint override with the same `files` (and `ignores` as
 *   `excludeFiles`), and the other way round; every such block is exercised by
 *   a sample below; the global ignore lists match; and `.oxlintrc.json` has no
 *   setting this test does not read (`extends`, an enabled category, another
 *   plugin).
 * - **Semantics, per sample file.** The rules each config enables, with their
 *   severities and options — each rule's own defaults applied as ESLint applies
 *   them — and, wherever `no-undef` is on, the globals.
 *
 * ESLint's side is its own resolved config (`calculateConfigForFile`). oxlint
 * prints no per-file config, so its side applies `.oxlintrc.json` the way
 * oxlint documents: base `rules`/`globals`, then every override whose `files`
 * match the path and whose `excludeFiles` do not, in order, later winning.
 *
 * Not comparable: `sourceType`. oxlint has no such setting and parses a `.js`
 * file as a module, so ESLint's `sourceType: 'script'` blocks get module
 * (strict) parsing there; the sloppy-mode-only checks this loses are listed in
 * ESLINT_ONLY.
 *
 * When this fails, change both configs in the same commit.
 */

/** One real file under each block of `eslint.config.mjs` (the coverage test enforces it). */
const SAMPLES = [
  'src/main/services/active-run-identity.ts', // agent path: Electron banned
  'src/main/services/plan-usage-bridge.ts', // plus readFileSync banned
  'src/main/ipc/about-handlers.ts', // the Electron surface
  'src/preload/api.d.ts',
  'src/renderer/agent-activity.ts', // no Node builtins, no native dialogs
  'src/renderer/agent-activity.test.ts', // renderer test: Node builtins allowed again
  'packages/hooks-dialects/src/dialect-adapter.ts', // method-signature-style
  'scripts/hook-file-check.mts',
  'scripts/lib/file-lock.test.ts',
  'tests/e2e/accent-color.e2e.ts',
  'tests/demo/acp-catalog-labels.demo.ts',
  'scripts/check-node-version.cjs',
  'tests/fixtures/acp-bridge-identity-agent.mjs',
  'packages/review/bin/copse-review.mjs',
  'benchmarks/shell-scope/scripts/lib/acp-text-judge.mts',
  'benchmarks/shell-scope/scripts/acp-transport.mjs',
  'benchmarks/escalation-review/regression/run.mjs',
  'assets/skills/reconcile-worktrees/scripts/audit-worktrees.mjs',
  'assets/explainers/drawing.js',
  'src/renderer/monaco/esm-worker-host.js',
  'site/hero-demo.js',
  'prototypes/default-announcement/prototype.js',
  'src/mobile/app.js',
  'src/renderer/theme-boot.js',
]

/**
 * ESLint rules with no oxlint counterpart, each for a stated reason. A rule
 * ESLint enables that is neither here nor in `.oxlintrc.json` fails the test.
 */
const ESLINT_ONLY = new Map([
  ['no-useless-assignment', "oxlint's implementation is nursery and misfires on loop counters"],
  ['no-octal', 'a parse error in TypeScript (TS1121) and in modules; oxlint has no rule'],
  ['no-dupe-args', 'a parse error in TypeScript and in modules; oxlint has no rule'],
])

/**
 * typescript-eslint extension rules that oxlint implements under the core
 * ESLint name only — `@typescript-eslint/no-unused-vars` is `no-unused-vars`.
 */
const EXTENSION_RULES_AS_CORE = new Set([
  'no-array-constructor',
  'no-restricted-imports',
  'no-unused-expressions',
  'no-unused-vars',
  'no-useless-constructor',
])

/** An ESLint rule id as oxlint names it. */
function oxlintName(eslintRule: string): string {
  if (eslintRule === 'no-restricted-syntax') return 'copse/restricted-syntax'
  const typed = /^@typescript-eslint\/(.+)$/.exec(eslintRule)?.[1]
  if (typed === undefined) return eslintRule
  return EXTENSION_RULES_AS_CORE.has(typed) ? typed : `typescript/${typed}`
}

const ruleEntrySchema = z.union([z.string(), z.number(), z.array(z.unknown())])
type RuleEntry = z.infer<typeof ruleEntrySchema>
const rulesSchema = z.record(z.string(), ruleEntrySchema)
const globalsSchema = z.record(z.string(), z.unknown())

/** `error` / `warn` / `off`, from either tool's spelling (ESLint numbers, oxlint deny/allow). */
function severityOf(value: unknown): 'error' | 'warn' | 'off' {
  if (value === 2 || value === 'error' || value === 'deny') return 'error'
  if (value === 1 || value === 'warn') return 'warn'
  assert.ok(
    value === 0 || value === 'off' || value === 'allow',
    `unknown severity ${String(value)}`,
  )
  return 'off'
}

type Rule = { severity: 'error' | 'warn'; options: unknown[] }

function enabledOf(
  rules: Record<string, RuleEntry>,
  rename: (rule: string) => string,
): Map<string, Rule & { source: string }> {
  const enabled = new Map<string, Rule & { source: string }>()
  for (const [rule, entry] of Object.entries(rules)) {
    const [severity, ...options] = Array.isArray(entry) ? entry : [entry]
    const level = severityOf(severity)
    // Two ESLint ids can share an oxlint name (`no-unused-vars` and its
    // typescript-eslint twin); keep whichever is on.
    if (level !== 'off') enabled.set(rename(rule), { severity: level, options, source: rule })
  }
  return enabled
}

/** `readonly` / `writable` / `off`, from flat config's several spellings. */
function normalizeGlobals(globals: Record<string, unknown>): Record<string, string> {
  const spelled = (value: unknown): string => {
    if (value === true || value === 'writable' || value === 'writeable') return 'writable'
    if (value === false || value === 'readonly' || value === 'readable') return 'readonly'
    return String(value)
  }
  return Object.fromEntries(
    Object.entries(globals).map(([name, value]): [string, string] => [name, spelled(value)]),
  )
}

/** ESLint's `deepMergeArrays`: defaults under options, plain objects merged key by key. */
function withDefaults(defaults: readonly unknown[], options: readonly unknown[]): unknown[] {
  const merge = (base: unknown, over: unknown): unknown => {
    if (!isRecord(base) || !isRecord(over)) return over === undefined ? base : over
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(over)) merged[key] = merge(base[key], value)
    return merged
  }
  return Array.from({ length: Math.max(defaults.length, options.length) }, (_, i) =>
    merge(defaults[i], options[i]),
  )
}

// --- oxlint's side -----------------------------------------------------------

const overrideSchema = z
  .object({
    files: z.array(z.string()),
    excludeFiles: z.array(z.string()).optional(),
    rules: rulesSchema.optional(),
    globals: globalsSchema.optional(),
  })
  .strict()
// `.strict()`: a key this test does not read (`extends`, `settings`, a per-override
// plugin) fails the parse, so it cannot change what oxlint runs unnoticed.
const oxlintConfigSchema = z
  .object({
    $schema: z.string().optional(),
    plugins: z.array(z.string()),
    jsPlugins: z.array(z.string()),
    categories: z.record(z.string(), z.string()),
    options: z.object({ typeAware: z.boolean() }).strict(),
    env: z.record(z.string(), z.boolean()),
    globals: globalsSchema.optional(),
    ignorePatterns: z.array(z.string()),
    rules: rulesSchema,
    overrides: z.array(overrideSchema),
  })
  .strict()

function readOxlintConfig(): z.infer<typeof oxlintConfigSchema> {
  const config = safeJsonParse(
    readFileSync(resolve('.oxlintrc.json'), 'utf8'),
    decodeWithSchema(oxlintConfigSchema),
  )
  assert.ok(config !== null, '.oxlintrc.json has a setting this test does not read, or bad JSON')
  return config
}
const oxlint = readOxlintConfig()

const matches = (file: string, globs: readonly string[] | undefined): boolean =>
  (globs ?? []).some((glob) => picomatch.isMatch(file, glob, { dot: true }))

function oxlintResolved(file: string): {
  rules: Map<string, Rule & { source: string }>
  globals: Record<string, unknown>
} {
  let rules = { ...oxlint.rules }
  let globals = { ...oxlint.globals }
  for (const override of oxlint.overrides) {
    if (!matches(file, override.files) || matches(file, override.excludeFiles)) continue
    rules = { ...rules, ...override.rules }
    globals = { ...globals, ...override.globals }
  }
  return { rules: enabledOf(rules, (rule) => rule), globals }
}

// --- ESLint's side -----------------------------------------------------------

const eslint = new ESLint()
const resolvedSchema = z
  .object({
    rules: rulesSchema,
    plugins: z.record(z.string(), z.unknown()),
    languageOptions: z.object({ globals: globalsSchema.optional() }).loose().optional(),
  })
  .loose()

/** The `meta.defaultOptions` ESLint merges under a rule's configured options. */
function defaultOptions(plugins: Record<string, unknown>, eslintRule: string): unknown[] {
  const typed = /^@typescript-eslint\/(.+)$/.exec(eslintRule)?.[1]
  const plugin = plugins[typed === undefined ? '@' : '@typescript-eslint']
  const rules: unknown = isRecord(plugin) ? plugin['rules'] : undefined
  const id = typed ?? eslintRule
  const rule: unknown =
    rules instanceof Map ? rules.get(id) : isRecord(rules) ? rules[id] : undefined
  const parsed = z
    .object({ meta: z.object({ defaultOptions: z.array(z.unknown()).optional() }).optional() })
    .safeParse(rule)
  return parsed.success ? (parsed.data.meta?.defaultOptions ?? []) : []
}

async function eslintResolved(file: string): Promise<{
  rules: Map<string, Rule & { source: string }>
  globals: Record<string, unknown>
  defaults: (eslintRule: string) => unknown[]
}> {
  const resolved: unknown = await eslint.calculateConfigForFile(file)
  const config = resolvedSchema.parse(resolved)
  const rules = enabledOf(config.rules, oxlintName)
  for (const rule of ESLINT_ONLY.keys()) rules.delete(rule)
  return {
    rules,
    globals: config.languageOptions?.globals ?? {},
    defaults: (eslintRule) => defaultOptions(config.plugins, eslintRule),
  }
}

/** The blocks of `eslint.config.mjs` that set rules or globals, as `files` + `ignores`. */
async function eslintBlocks(): Promise<{ files: string[]; ignores?: string[] }[]> {
  const module: unknown = await import(pathToFileURL(resolve('eslint.config.mjs')).href)
  const configs = z.object({ default: z.array(z.unknown()) }).parse(module).default
  const blockSchema = z
    .object({
      files: z.array(z.string()),
      ignores: z.array(z.string()).optional(),
      rules: z.record(z.string(), z.unknown()).optional(),
      languageOptions: z.object({ globals: globalsSchema.optional() }).loose().optional(),
    })
    .loose()
  const blocks = new Map<string, { files: string[]; ignores?: string[] }>()
  for (const config of configs) {
    const parsed = blockSchema.safeParse(config)
    if (!parsed.success) continue
    const { files, ignores, rules, languageOptions } = parsed.data
    // A block that only sets parser options (each TS project's tsconfig) has
    // nothing to port: oxlint finds the tsconfig itself.
    if (
      Object.keys(rules ?? {}).length === 0 &&
      Object.keys(languageOptions?.globals ?? {}).length === 0
    )
      continue
    // `extends` expands one block into several objects with the same files.
    blocks.set(
      JSON.stringify([files, ignores ?? []]),
      ignores === undefined ? { files } : { files, ignores },
    )
  }
  return [...blocks.values()]
}

// --- the tests ---------------------------------------------------------------

describe('.oxlintrc.json mirrors eslint.config.mjs', () => {
  it('turns on nothing beyond its explicit rules', () => {
    assert.deepEqual(oxlint.plugins, ['typescript'])
    assert.deepEqual(oxlint.env, { builtin: true })
    for (const [category, level] of Object.entries(oxlint.categories)) {
      assert.equal(severityOf(level), 'off', `category ${category} is enabled`)
    }
  })

  it('has one override per ESLint block, with the same files and ignores', async () => {
    const key = (files: readonly string[], excluded: readonly string[] | undefined): string =>
      JSON.stringify([files, excluded ?? []])
    const fromEslint = (await eslintBlocks()).map((block) => key(block.files, block.ignores)).sort()
    const fromOxlint = oxlint.overrides
      .map((override) => key(override.files, override.excludeFiles))
      .sort()
    assert.deepEqual(fromOxlint, fromEslint)
  })

  it('samples a file under every ESLint block', async () => {
    for (const file of SAMPLES) assert.ok(existsSync(resolve(file)), `${file} moved: pick another`)
    for (const block of await eslintBlocks()) {
      assert.ok(
        SAMPLES.some((file) => matches(file, block.files) && !matches(file, block.ignores)),
        `no sample under the ESLint block for ${JSON.stringify(block.files)}: add one to SAMPLES`,
      )
    }
  })

  for (const file of SAMPLES) {
    it(`agrees on every rule, severity, option and global for ${file}`, async () => {
      const fromEslint = await eslintResolved(file)
      const fromOxlint = oxlintResolved(file)
      assert.deepEqual(
        [...fromOxlint.rules.keys()].sort(),
        [...fromEslint.rules.keys()].sort(),
        'the two configs enable different rules',
      )
      for (const [rule, expected] of fromEslint.rules) {
        const actual = fromOxlint.rules.get(rule)
        assert.ok(actual !== undefined)
        assert.equal(actual.severity, expected.severity, `${rule}: severity differs`)
        const defaults = fromEslint.defaults(expected.source)
        assert.ok(
          isDeepStrictEqual(
            withDefaults(defaults, actual.options),
            withDefaults(defaults, expected.options),
          ),
          `${rule}: options differ\n  eslint: ${JSON.stringify(expected.options)}\n  oxlint: ${JSON.stringify(actual.options)}`,
        )
      }
      if (fromEslint.rules.has('no-undef')) {
        assert.deepEqual(
          normalizeGlobals(fromOxlint.globals),
          normalizeGlobals(fromEslint.globals),
          'globals differ',
        )
      }
    })
  }

  it('ignores the same paths', async () => {
    const module: unknown = await import(pathToFileURL(resolve('eslint.config.mjs')).href)
    const configs = z.object({ default: z.array(z.unknown()) }).parse(module).default
    // A config object holding only `ignores` is a global ignore in flat config.
    const globalIgnores = configs.flatMap((config) => {
      const parsed = z
        .object({ ignores: z.array(z.string()) })
        .strict()
        .safeParse(config)
      return parsed.success ? parsed.data.ignores : []
    })
    assert.deepEqual([...oxlint.ignorePatterns].sort(), [...globalIgnores].sort())
  })
})
