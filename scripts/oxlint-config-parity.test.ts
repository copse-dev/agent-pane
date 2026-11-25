import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import picomatch from 'picomatch'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

/**
 * `.oxlintrc.json` is a hand-kept port of `eslint.config.mjs`. ESLint is the
 * lint gate, but the post-edit hook runs oxlint on every edit, so if the two
 * drift apart agents are shown findings the gate will not raise — or miss ones
 * it will. This pins them together, file by file: for one real file under each
 * block of `eslint.config.mjs`, the rules oxlint enables must be the rules
 * ESLint enables, with the same restricted selectors and imports, and the two
 * global ignore lists must match.
 *
 * ESLint's side is its own resolved config (`calculateConfigForFile`). oxlint
 * prints no per-file config, so its side applies `.oxlintrc.json` the way
 * oxlint documents: base `rules`, then every override whose `files` glob
 * matches the path (relative to the config file), in order, later winning.
 *
 * When this fails, change both configs in the same commit.
 */

/** One real file under each block of `eslint.config.mjs`. */
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
  ['no-octal', 'parse error in TypeScript (TS1121); oxlint has no rule for the JS overrides'],
  ['no-dupe-args', 'a parse error in strict mode, which every linted file is'],
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

/** Whether an ESLint or oxlint rule entry switches the rule on, and its options. */
function readEntry(entry: RuleEntry): { on: boolean; options: unknown[] } {
  const [severity, ...options] = Array.isArray(entry) ? entry : [entry]
  return { on: !(severity === 0 || severity === 'off' || severity === 'allow'), options }
}

/** Enabled rules by oxlint name, each with its options. */
type Enabled = Map<string, unknown[]>

function enabledOf(rules: Record<string, RuleEntry>, rename: (rule: string) => string): Enabled {
  const enabled: Enabled = new Map()
  for (const [rule, entry] of Object.entries(rules)) {
    const { on, options } = readEntry(entry)
    // Two ESLint ids can share an oxlint name (`no-unused-vars` and its
    // typescript-eslint twin); keep whichever is on.
    if (on) enabled.set(rename(rule), options)
  }
  return enabled
}

const oxlintConfigSchema = z.object({
  ignorePatterns: z.array(z.string()),
  rules: rulesSchema,
  overrides: z.array(z.object({ files: z.array(z.string()), rules: rulesSchema.optional() })),
})
const oxlint = safeJsonParse(
  readFileSync(resolve('.oxlintrc.json'), 'utf8'),
  decodeWithSchema(oxlintConfigSchema),
)

function oxlintEnabled(file: string): Enabled {
  assert.ok(oxlint !== null, '.oxlintrc.json no longer has the shape this test reads')
  let rules = { ...oxlint.rules }
  for (const override of oxlint.overrides) {
    if (override.files.some((glob) => picomatch.isMatch(file, glob, { dot: true }))) {
      rules = { ...rules, ...override.rules }
    }
  }
  return enabledOf(rules, (rule) => rule)
}

const eslint = new ESLint()
const eslintConfigSchema = z.object({ rules: rulesSchema })

async function eslintEnabled(file: string): Promise<Enabled> {
  const config = eslintConfigSchema.parse(await eslint.calculateConfigForFile(file))
  const enabled = enabledOf(config.rules, oxlintName)
  for (const rule of ESLINT_ONLY.keys()) enabled.delete(rule)
  return enabled
}

/** The restricted selectors, order-free: ESLint and oxlint list them per block. */
function selectors(options: unknown[] | undefined): string[] {
  return (options ?? [])
    .map((option) => z.object({ selector: z.string() }).parse(option).selector)
    .sort()
}

describe('.oxlintrc.json mirrors eslint.config.mjs', () => {
  it('reads every sample file this test is pinned to', () => {
    for (const file of SAMPLES) assert.ok(existsSync(resolve(file)), `${file} moved: pick another`)
  })

  for (const file of SAMPLES) {
    it(`enables the same rules for ${file}`, async () => {
      const fromEslint = await eslintEnabled(file)
      const fromOxlint = oxlintEnabled(file)
      assert.deepEqual(
        [...fromOxlint.keys()].sort(),
        [...fromEslint.keys()].sort(),
        `the two configs enable different rules for ${file}`,
      )
      assert.deepEqual(
        selectors(fromOxlint.get('copse/restricted-syntax')),
        selectors(fromEslint.get('copse/restricted-syntax')),
        `no-restricted-syntax selectors differ for ${file}`,
      )
      assert.deepEqual(
        fromOxlint.get('no-restricted-imports'),
        fromEslint.get('no-restricted-imports'),
        `no-restricted-imports options differ for ${file}`,
      )
    })
  }

  it('ignores the same paths', async () => {
    assert.ok(oxlint !== null)
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
