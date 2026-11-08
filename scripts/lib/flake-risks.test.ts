import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  FLAKE_RISK_BASELINE_PATH,
  FLAKE_RULE_ADVICE,
  baselineFromFindings,
  compareWithBaseline,
  flakeBaselineGrowth,
  flakeRiskBaselineSchema,
  formatFlakeRiskBaseline,
  isE2ePath,
  isUnitTestPath,
  scanFlakeRisks,
  type FlakeRiskBaseline,
  type FlakeRule,
} from './flake-risks.mts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

const spec = 'tests/e2e/example.e2e.ts'
const unit = 'src/main/example.test.ts'

function lines(path: string, text: string, rule?: FlakeRule): number[] {
  return scanFlakeRisks(path, text)
    .filter((finding) => rule === undefined || finding.rule === rule)
    .map((finding) => finding.line)
}

function baseline(rules: Partial<Record<FlakeRule, Record<string, number>>>): FlakeRiskBaseline {
  return {
    version: 1,
    rules: {
      'e2e-fixed-pause': rules['e2e-fixed-pause'] ?? {},
      'unit-wall-clock-sleep': rules['unit-wall-clock-sleep'] ?? {},
      'e2e-checkout-seed': rules['e2e-checkout-seed'] ?? {},
      'e2e-fixed-port': rules['e2e-fixed-port'] ?? {},
    },
  }
}

describe('scope', () => {
  it('scans unit tests and e2e TypeScript only', () => {
    assert.equal(isUnitTestPath('packages/llm/src/a.test.ts'), true)
    assert.equal(isUnitTestPath('src/main/a.ts'), false)
    assert.equal(isE2ePath('tests/e2e/helpers/screenshot.ts'), true)
    assert.equal(isE2ePath('tests/e2e/fixture.cjs'), false)
    assert.deepEqual(scanFlakeRisks('src/main/a.ts', 'await browser.pause(100)'), [])
  })
})

describe('e2e-fixed-pause', () => {
  it('flags a fixed settle wait and spares a poll interval inside a deadline loop', () => {
    const text = [
      "import { browser } from '@wdio/globals'",
      'export async function prepare(): Promise<void> {',
      '  await browser.execute(() => window.dispatchEvent(new Event("resize")))',
      '  await browser.pause(100)',
      '}',
      'export async function settle(ready: () => Promise<boolean>): Promise<void> {',
      '  const deadline = Date.now() + 3_000',
      '  while (Date.now() < deadline) {',
      '    if (await ready()) return',
      '    await browser.pause(34)',
      '  }',
      '}',
      'export async function settleInBody(ready: () => Promise<boolean>): Promise<boolean> {',
      '  const deadline = Date.now() + 3_000',
      '  for (;;) {',
      '    if (await ready()) return true',
      '    if (Date.now() >= deadline) return false',
      '    await browser.pause(100)',
      '  }',
      '}',
    ].join('\n')
    assert.deepEqual(lines('tests/e2e/helpers/screenshot.ts', text), [4])
  })

  it('does not treat an attempt-count loop or a deadline outside the function as polling', () => {
    const text = [
      'for (let attempt = 0; attempt < 6; attempt++) {',
      '  await browser.pause(500)',
      '}',
      'while (Date.now() < deadline) {',
      '  setTimeout(async () => { await browser.pause(10) })',
      '}',
    ].join('\n')
    assert.deepEqual(lines(spec, text), [2, 5])
  })

  it('follows import aliases, local aliases, destructuring and element access', () => {
    const text = [
      "import { browser as b } from '@wdio/globals'",
      'await b.pause(100)',
      'const driver = b',
      'await driver.pause(100)',
      'const { pause: wait } = b',
      'await wait(100)',
      "await b['pause'](100)",
      'animation.pause()',
    ].join('\n')
    assert.deepEqual(lines(spec, text), [2, 4, 6, 7])
  })

  it('uses the WDIO global only when no import shadows the name', () => {
    assert.deepEqual(lines(spec, 'await browser.pause(100)'), [1])
    assert.deepEqual(
      lines(spec, "import { browser } from './fake-browser.ts'\nawait browser.pause(100)"),
      [],
    )
  })
})

describe('unit-wall-clock-sleep', () => {
  it('flags awaited setTimeout promises and spares zero-delay yields', () => {
    const text = [
      'await new Promise((resolve) => setTimeout(resolve, 50))',
      'await new Promise<void>((r) => { setTimeout(() => r(), 20) })',
      'await new Promise((resolve) => setTimeout(resolve, 0))',
      'await new Promise((resolve) => setImmediate(resolve))',
      'await new Promise((resolve) => globalThis.setTimeout(resolve, DELAY))',
      'const timeout = new Promise((resolve) => setTimeout(resolve, 50))',
    ].join('\n')
    assert.deepEqual(lines(unit, text), [1, 2, 5])
  })

  it('follows node:timers/promises aliases and namespaces', () => {
    const text = [
      "import { setTimeout as delay } from 'node:timers/promises'",
      "import * as timers from 'timers/promises'",
      'await delay(25)',
      'await delay(0)',
      'await timers.setTimeout(10)',
      'setTimeout(() => {}, 10)',
    ].join('\n')
    assert.deepEqual(lines(unit, text), [3, 5])
  })

  it('maps sleep helpers to their call arguments and defaults', () => {
    const text = [
      'const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))',
      'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))',
      'const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms))',
      'function wait(): Promise<void> {',
      '  return new Promise((resolve) => setTimeout(resolve, 15))',
      '}',
      'await tick()',
      'await sleep(10)',
      'await sleep(0)',
      'await settle()',
      'await wait()',
    ].join('\n')
    assert.deepEqual(lines(unit, text), [8, 10, 11])
  })

  it('points to node:test mock timers', () => {
    const [finding] = scanFlakeRisks(unit, 'await new Promise((r) => setTimeout(r, 5))')
    assert.equal(finding?.rule, 'unit-wall-clock-sleep')
    assert.match(FLAKE_RULE_ADVICE['unit-wall-clock-sleep'], /mock\.timers/)
  })

  it('counts each call of an async helper that awaits a sleep, not its body', () => {
    const text = [
      'async function wait(ms: number): Promise<void> {',
      '  await new Promise((r) => setTimeout(r, ms))',
      '}',
      'const pause = async (ms = 20) => { log(ms); await new Promise((r) => setTimeout(r, ms)) }',
      'const arrow = async () => await new Promise((r) => setTimeout(r, 15))',
      'await wait(500)',
      'await wait(900)',
      'await wait(0)',
      'await pause()',
      'await arrow()',
    ].join('\n')
    assert.deepEqual(lines(unit, text), [6, 7, 9, 10])
  })
})

describe('e2e wall-clock sleeps', () => {
  it('counts them as fixed pauses outside a deadline loop', () => {
    const text = [
      "import { setTimeout as delay } from 'node:timers/promises'",
      'await new Promise((r) => setTimeout(r, 500))',
      'await delay(200)',
      'await browser.execute(async () => { await new Promise((r) => setTimeout(r, 50)) })',
      'const deadline = Date.now() + 5_000',
      'while (Date.now() < deadline) {',
      '  await new Promise((r) => setTimeout(r, 100))',
      '}',
      'await new Promise((r) => setTimeout(r, 0))',
    ].join('\n')
    const findings = scanFlakeRisks(spec, text)
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.line]),
      [
        ['e2e-fixed-pause', 2],
        ['e2e-fixed-pause', 3],
        ['e2e-fixed-pause', 4],
      ],
    )
  })
})

describe('e2e-checkout-seed', () => {
  it('flags seeders given the shared checkout, through aliases', () => {
    const text = [
      "import { seedEmptyProject as seed, seedStableWorkspace } from './helpers/seed-config.ts'",
      "import * as seeds from './helpers/seed-config.ts'",
      "seed(process.cwd(), 'p')",
      'const root = process.cwd()',
      "seeds.seedEmptyProject(root, 'p')",
      "seed(seedStableWorkspace(), 'p')",
      'let mutable = process.cwd()',
      "seed(mutable, 'p')",
      "other(process.cwd(), 'p')",
    ].join('\n')
    assert.deepEqual(lines(spec, text), [3, 5])
  })
})

describe('e2e-fixed-port', () => {
  it('flags fixed listen ports, port constants and server options, not port 0', () => {
    const text = [
      'export const E2E_NAMES_API_PORT = 42781',
      'const fixturePort = 51_234',
      'server.listen(11434, "127.0.0.1")',
      'server.listen(0, "127.0.0.1")',
      'await startFakeApi({ port: 4000 })',
      'const ports = [{ port: 3000, label: "web" }]',
      'const EPHEMERAL_PORT = 0',
    ].join('\n')
    assert.deepEqual(lines('tests/e2e/helpers/e2e-env.ts', text), [1, 2, 3, 5])
  })
})

describe('compareWithBaseline', () => {
  const bare = "import { browser } from '@wdio/globals'\nawait browser.pause(100)\n"

  it('fails a new spec that adds a bare pause', () => {
    const result = compareWithBaseline(baseline({}), scanFlakeRisks(spec, bare))
    assert.deepEqual(result.added, [
      { rule: 'e2e-fixed-pause', file: spec, observed: 1, allowed: 0 },
    ])
  })

  it('fails a count above the baseline and accepts an equal count', () => {
    const findings = scanFlakeRisks(spec, `${bare}await browser.pause(50)\n`)
    assert.equal(
      compareWithBaseline(baseline({ 'e2e-fixed-pause': { [spec]: 1 } }), findings).added.length,
      1,
    )
    assert.deepEqual(
      compareWithBaseline(baseline({ 'e2e-fixed-pause': { [spec]: 2 } }), findings),
      {
        added: [],
        stale: [],
      },
    )
  })

  it('reports a drop as stale until the baseline is lowered', () => {
    const findings = scanFlakeRisks(spec, bare)
    const before = baseline({ 'e2e-fixed-pause': { [spec]: 3, 'tests/e2e/gone.e2e.ts': 1 } })
    assert.deepEqual(compareWithBaseline(before, findings).stale, [
      { rule: 'e2e-fixed-pause', file: spec, observed: 1, allowed: 3 },
      { rule: 'e2e-fixed-pause', file: 'tests/e2e/gone.e2e.ts', observed: 0, allowed: 1 },
    ])
    assert.deepEqual(compareWithBaseline(baselineFromFindings(findings), findings), {
      added: [],
      stale: [],
    })
  })
})

describe('flakeBaselineGrowth', () => {
  const base = baseline({ 'e2e-fixed-pause': { [spec]: 2 } })

  it('accepts an unchanged or lower baseline', () => {
    assert.deepEqual(flakeBaselineGrowth(base, base), [])
    assert.deepEqual(flakeBaselineGrowth(base, baseline({ 'e2e-fixed-pause': { [spec]: 1 } })), [])
    assert.deepEqual(flakeBaselineGrowth(base, baseline({})), [])
  })

  it('refuses a raised count or a new file', () => {
    assert.equal(
      flakeBaselineGrowth(base, baseline({ 'e2e-fixed-pause': { [spec]: 3 } })).length,
      1,
    )
    assert.equal(
      flakeBaselineGrowth(
        base,
        baseline({ 'e2e-fixed-pause': { [spec]: 2, 'tests/e2e/new.e2e.ts': 1 } }),
      ).length,
      1,
    )
  })

  it('carries a renamed file count, but not a copy or a larger one', () => {
    const renamed = 'tests/e2e/renamed.e2e.ts'
    const renames = new Map([[renamed, spec]])
    assert.deepEqual(
      flakeBaselineGrowth(base, baseline({ 'e2e-fixed-pause': { [renamed]: 2 } }), renames),
      [],
    )
    assert.equal(
      flakeBaselineGrowth(base, baseline({ 'e2e-fixed-pause': { [renamed]: 3 } }), renames).length,
      1,
    )
    assert.equal(
      flakeBaselineGrowth(
        base,
        baseline({ 'e2e-fixed-pause': { [spec]: 2, [renamed]: 2 } }),
        renames,
      ).length,
      1,
    )
  })
})

describe('committed baseline', () => {
  it('parses and is formatted canonically', () => {
    const text = readFileSync(FLAKE_RISK_BASELINE_PATH, 'utf8')
    const parsed = safeJsonParse(text, decodeWithSchema(flakeRiskBaselineSchema))
    assert.ok(parsed, `${FLAKE_RISK_BASELINE_PATH} must match the schema`)
    assert.equal(formatFlakeRiskBaseline(parsed), text)
  })
})
