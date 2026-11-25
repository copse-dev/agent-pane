import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * Pins the Electron boundary in `eslint.config.mjs` against dynamic imports.
 *
 * `no-restricted-imports` only inspects static `import`/`export … from` declarations, so
 * `await import('electron')` slipped past it in three agent-path files. The config now
 * also bans that `ImportExpression` through `no-restricted-syntax`, whose array options
 * ESLint replaces wholesale per block. Each case below lints a virtual file at a path
 * owned by one of those blocks, so a block that forgets to repeat the selector (or that
 * drops `NO_DYNAMIC_IN` while lifting it) fails here rather than silently.
 *
 * Linted through `eslint.hook.config.mjs` — the project config with the type-aware rules
 * off — because those rules need each file in a tsconfig project and these paths do not
 * exist. Neither rule under test is type-aware, so the block resolution is the real one.
 */

const ESLINT_CLI = resolve('node_modules/eslint/bin/eslint.js')

const DYNAMIC_ELECTRON = [
  'export async function openExternal(url: string): Promise<void> {',
  "  const { shell } = await import('electron')",
  '  await shell.openExternal(url)',
  '}',
  '',
].join('\n')

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

function assertRejectsDynamicElectron(filePath: string): void {
  const errors = lintErrors(filePath, DYNAMIC_ELECTRON)
  assert.equal(errors.length, 1, JSON.stringify(errors, null, 2))
  assert.equal(errors[0]?.ruleId, 'no-restricted-syntax')
  assert.match(errors[0]?.message ?? '', /import\('electron'\)/)
}

describe('Electron boundary lint: dynamic imports', () => {
  // One path per config block that sets `no-restricted-syntax` for shipped or tested code.
  for (const filePath of [
    'src/main/services/agent-path-fixture.ts',
    'packages/agent/src/agent-path-fixture.ts',
    'src/main/services/plan-usage-bridge.ts',
    'src/renderer/views/agent-path-fixture.ts',
    // The static ban covers tests outside the surface, so the dynamic one must too.
    'src/main/services/agent-path-fixture.test.ts',
  ]) {
    it(`rejects a runtime import('electron') in ${filePath}`, () => {
      assertRejectsDynamicElectron(filePath)
    })
  }

  for (const filePath of [
    'src/main/ipc/surface-fixture.ts',
    'src/main/ipc/surface-fixture.test.ts',
  ]) {
    it(`allows it on the Electron surface (${filePath})`, () => {
      assert.deepEqual(lintErrors(filePath, DYNAMIC_ELECTRON), [])
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

  it('still allows Electron types through `typeof import`, which TypeScript erases', () => {
    const code = ["export type ElectronShell = typeof import('electron')['shell']", ''].join('\n')
    assert.deepEqual(lintErrors('src/main/services/agent-path-fixture.ts', code), [])
  })
})
