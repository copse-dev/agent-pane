import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ESLint } from 'eslint'
import { isRecord } from '@copse/std/unknown-value.ts'

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
 * The lint is the real `eslint.config.mjs`, so each path gets the options its blocks
 * resolve to. Every other rule is off, and so is type information: these paths are in no
 * tsconfig project, and neither rule under test is type-aware. `.oxlintrc.json` mirrors
 * the same options, which `oxlint-config-parity.test.ts` pins.
 */

/** The two rules the boundary is made of. Everything else is switched off. */
const BOUNDARY_RULES = new Set(['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax'])

/** One path per config block that restates either rule for shipped or tested code. */
const REJECTING_PATHS = [
  'src/main/services/agent-path-fixture.ts',
  'packages/agent/src/agent-path-fixture.ts',
  'src/main/services/plan-usage-bridge.ts',
  'src/renderer/views/agent-path-fixture.ts',
  // The static ban covers tests outside the surface, so the dynamic one must too.
  'src/main/services/agent-path-fixture.test.ts',
]

const SURFACE_PATHS = ['src/main/ipc/surface-fixture.ts', 'src/main/ipc/surface-fixture.test.ts']

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

interface LintError {
  ruleId: string | null
  message: string
}

let boundaryLinter: Promise<ESLint> | undefined

/** ESLint on `eslint.config.mjs` with only the boundary rules left on. */
function boundaryEslint(): Promise<ESLint> {
  boundaryLinter ??= (async (): Promise<ESLint> => {
    const full = new ESLint()
    const others = new Set<string>()
    for (const filePath of [...REJECTING_PATHS, ...SURFACE_PATHS]) {
      const resolved: unknown = await full.calculateConfigForFile(filePath)
      if (!isRecord(resolved) || !isRecord(resolved['rules'])) continue
      for (const name of Object.keys(resolved['rules'])) {
        if (!BOUNDARY_RULES.has(name)) others.add(name)
      }
    }
    return new ESLint({
      overrideConfig: {
        languageOptions: {
          parserOptions: { project: false, projectService: false, program: null },
        },
        rules: Object.fromEntries([...others].map((name): [string, 'off'] => [name, 'off'])),
      },
    })
  })()
  return boundaryLinter
}

async function lintErrors(filePath: string, code: string): Promise<LintError[]> {
  const [result] = await (await boundaryEslint()).lintText(code, { filePath })
  assert.ok(result, `ESLint returned no result for ${filePath}`)
  const fatal = result.messages.filter((message) => message.fatal === true)
  assert.deepEqual(fatal, [], `${filePath} did not parse`)
  return result.messages
    .filter((message) => message.severity === 2)
    .map(({ ruleId, message }) => ({ ruleId, message }))
}

async function assertRejectsElectronImports(filePath: string): Promise<void> {
  const errors = await lintErrors(filePath, ELECTRON_IMPORTS)
  assert.deepEqual(
    errors.map((error) => error.ruleId),
    REJECTED_RULES,
    JSON.stringify(errors, null, 2),
  )
  for (const error of errors) assert.match(error.message, /Electron/)
}

describe('Electron boundary lint: subpaths and dynamic imports', () => {
  for (const filePath of REJECTING_PATHS) {
    it(`rejects every runtime Electron import form in ${filePath}`, async () => {
      await assertRejectsElectronImports(filePath)
    })
  }

  for (const filePath of SURFACE_PATHS) {
    it(`allows them on the Electron surface (${filePath})`, async () => {
      assert.deepEqual(await lintErrors(filePath, ELECTRON_IMPORTS), [])
    })
  }

  it('keeps the dynamic-key `in` ban on the Electron surface, where only the import ban lifts', async () => {
    const errors = await lintErrors('src/main/ipc/surface-fixture.ts', DYNAMIC_IN)
    assert.deepEqual(
      errors.map((error) => error.ruleId),
      ['no-restricted-syntax'],
    )
    assert.match(errors[0]?.message ?? '', /Object\.hasOwn/)
  })

  it('keeps the dynamic-key `in` ban on the agent path alongside the import ban', async () => {
    const errors = await lintErrors('src/main/services/agent-path-fixture.ts', DYNAMIC_IN)
    assert.deepEqual(
      errors.map((error) => error.ruleId),
      ['no-restricted-syntax'],
    )
    assert.match(errors[0]?.message ?? '', /Object\.hasOwn/)
  })

  it('still allows Electron types, which TypeScript erases, and the separate electron-* packages', async () => {
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
    assert.deepEqual(await lintErrors('src/main/services/agent-path-fixture.ts', code), [])
  })
})
