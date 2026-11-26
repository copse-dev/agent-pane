import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * Pins the Electron boundary in `eslint.config.mjs` against the forms that slipped past it.
 *
 * `no-restricted-imports` only inspects static `import`/`export … from` declarations, so
 * `await import('electron')` slipped past it in three agent-path files, and its exact
 * `paths` entry also let `electron/main` and the other declared subpaths through. The
 * config now adds an `electron/*` pattern and bans the dynamic forms through
 * `no-restricted-syntax`. ESLint replaces both rules' options wholesale per block, so each
 * case below lints a virtual file at a path owned by one block. A block that forgets to
 * repeat either addition (or that drops `NO_DYNAMIC_IN` while lifting them) fails here
 * rather than silently.
 *
 * Linted through `eslint.hook.config.mjs` — the project config with the type-aware rules
 * off — because those rules need each file in a tsconfig project and these paths do not
 * exist. Neither rule under test is type-aware, so the block resolution is the real one.
 */

const ESLINT_CLI = resolve('node_modules/eslint/bin/eslint.js')

/** One of each runtime form: a static subpath, then a bare, a subpath and a template import. */
const ELECTRON_IMPORTS = [
  "import { app } from 'electron/main'",
  'export async function load(): Promise<unknown[]> {',
  "  return [app, await import('electron'), await import('electron/common'), await import(`electron`)]",
  '}',
  '',
].join('\n')

const REJECTED_RULES = [
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-syntax',
  'no-restricted-syntax',
]

const DYNAMIC_IN = [
  'export function has(record: Record<string, number>, key: string): boolean {',
  '  return key in record',
  '}',
  '',
].join('\n')

const lintOutputSchema = z.array(
  z.object({
    messages: z.array(
      z.object({ ruleId: z.string().nullable(), severity: z.number(), message: z.string() }),
    ),
  }),
)

interface LintError {
  ruleId: string | null
  message: string
}

function lintErrors(filePath: string, code: string): LintError[] {
  const result = spawnSync(
    process.execPath,
    [
      ESLINT_CLI,
      '--config',
      'eslint.hook.config.mjs',
      '--format',
      'json',
      '--stdin',
      '--stdin-filename',
      filePath,
    ],
    { input: code, encoding: 'utf8' },
  )
  // 0: clean, 1: lint errors. Anything else is ESLint itself failing (a config error).
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout)
  const output = safeJsonParse(result.stdout, decodeWithSchema(lintOutputSchema))
  assert.ok(output, `ESLint printed no JSON report:\n${result.stdout}`)
  return output
    .flatMap((file) => file.messages)
    .filter((message) => message.severity === 2)
    .map(({ ruleId, message }) => ({ ruleId, message }))
}

function assertRejectsElectronImports(filePath: string): void {
  const errors = lintErrors(filePath, ELECTRON_IMPORTS)
  assert.deepEqual(
    errors.map((error) => error.ruleId),
    REJECTED_RULES,
    JSON.stringify(errors, null, 2),
  )
  for (const error of errors) assert.match(error.message, /Electron/)
}

describe('Electron boundary lint: subpaths and dynamic imports', () => {
  // One path per config block that restates either rule for shipped or tested code.
  for (const filePath of [
    'src/main/services/agent-path-fixture.ts',
    'packages/agent/src/agent-path-fixture.ts',
    'src/main/services/plan-usage-bridge.ts',
    'src/renderer/views/agent-path-fixture.ts',
    // The static ban covers tests outside the surface, so the dynamic one must too.
    'src/main/services/agent-path-fixture.test.ts',
  ]) {
    it(`rejects every runtime Electron import form in ${filePath}`, () => {
      assertRejectsElectronImports(filePath)
    })
  }

  for (const filePath of [
    'src/main/ipc/surface-fixture.ts',
    'src/main/ipc/surface-fixture.test.ts',
  ]) {
    it(`allows them on the Electron surface (${filePath})`, () => {
      assert.deepEqual(lintErrors(filePath, ELECTRON_IMPORTS), [])
    })
  }

  it('keeps the dynamic-key `in` ban on the Electron surface, where only the import ban lifts', () => {
    const errors = lintErrors('src/main/ipc/surface-fixture.ts', DYNAMIC_IN)
    assert.deepEqual(
      errors.map((error) => error.ruleId),
      ['no-restricted-syntax'],
    )
    assert.match(errors[0]?.message ?? '', /Object\.hasOwn/)
  })

  it('keeps the dynamic-key `in` ban on the agent path alongside the import ban', () => {
    const errors = lintErrors('src/main/services/agent-path-fixture.ts', DYNAMIC_IN)
    assert.deepEqual(
      errors.map((error) => error.ruleId),
      ['no-restricted-syntax'],
    )
    assert.match(errors[0]?.message ?? '', /Object\.hasOwn/)
  })

  it('still allows Electron types, which TypeScript erases, and the separate electron-* packages', () => {
    const code = [
      "import type { App } from 'electron/main'",
      "export { autoUpdater } from 'electron-updater'",
      'export type MainApp = App',
      "export type ElectronShell = typeof import('electron')['shell']",
      'export async function loadStore(): Promise<unknown> {',
      "  return await import('electron-store')",
      '}',
      '',
    ].join('\n')
    assert.deepEqual(lintErrors('src/main/services/agent-path-fixture.ts', code), [])
  })
})
