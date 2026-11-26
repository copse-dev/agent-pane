import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import ts from 'typescript'
import { FLAKE_RULE_ADVICE, scanFlakeRisks } from './flake-risks.mts'
import { formatPlatformInventory, scanPlatformGates } from './platform-gates.mts'

const unit = 'src/main/example.test.ts'

function scan(text: string): ReturnType<typeof scanPlatformGates> {
  return scanPlatformGates(ts.createSourceFile(unit, text, ts.ScriptTarget.Latest, true))
}

function rules(text: string): string[] {
  return scanFlakeRisks(unit, text).map((finding) => `${finding.rule}:${String(finding.line)}`)
}

const header = "import { describe, it } from 'node:test'\n"

describe('unit-platform-early-return', () => {
  it('flags a host-platform early return in a test body, with the preferred form', () => {
    const text = `${header}it('works', () => {\n  if (process.platform !== 'darwin') return\n  check()\n})\n`
    assert.deepEqual(rules(text), ['unit-platform-early-return:3'])
    assert.match(FLAKE_RULE_ADVICE['unit-platform-early-return'], /skip: <platform condition> &&/)
  })

  it('flags a block that asserts the other branch and returns', () => {
    const text = [
      header,
      "it('works', () => {",
      "  if (process.platform !== 'darwin') {",
      '    assert.deepEqual(entries(), [])',
      '    return',
      '  }',
      '})',
    ].join('\n')
    assert.deepEqual(rules(text), ['unit-platform-early-return:4'])
  })

  it('spares a t.skip() guard, a branch without a return and a return in a nested function', () => {
    const text = [
      header,
      "it('a', (t) => {",
      "  if (process.platform !== 'darwin') {",
      "    t.skip('macOS only')",
      '    return',
      '  }',
      '})',
      "it('b', () => {",
      "  if (process.platform === 'win32') expected = 'C:'",
      "  const pick = () => { if (process.platform === 'linux') return 1; return 2 }",
      '})',
      "function helper() { if (process.platform === 'linux') return true }",
    ].join('\n')
    assert.deepEqual(rules(text), [])
  })

  it('follows node:os platform() and local const aliases', () => {
    const text = [
      "import { platform } from 'node:os'",
      "import * as os from 'node:os'",
      header,
      "const isMac = platform() === 'darwin'",
      "it('a', () => { if (!isMac) return })",
      "it('b', () => { if (os.platform() === 'linux') return })",
    ].join('\n')
    assert.deepEqual(rules(text), ['unit-platform-early-return:6', 'unit-platform-early-return:7'])
  })
})

describe('unit-platform-suite-skip', () => {
  it('flags a describe skipped off darwin and says how many tests it hides', () => {
    const text = [
      header,
      "describe('signing', { skip: process.platform !== 'darwin' }, () => {",
      "  it('a', () => {})",
      "  it('b', () => {})",
      '})',
    ].join('\n')
    const findings = scanFlakeRisks(unit, text)
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.line]),
      [['unit-platform-suite-skip', 3]],
    )
    assert.equal(
      findings[0]?.text,
      "describe('signing') hides 2 tests on linux instead of reporting a skip",
    )
  })

  it('ignores a Windows-only skip and a skip that does not read the platform', () => {
    const text = [
      header,
      "describe('posix', { skip: process.platform === 'win32' }, () => { it('a', () => {}) })",
      "describe('probe', { skip: !hasDocker }, () => { it('b', () => {}) })",
    ].join('\n')
    assert.deepEqual(rules(text), [])
  })
})

describe('platform inventory', () => {
  it('counts per-test darwin, Linux and Windows gates, including a reason string', () => {
    const { inventory, sites } = scan(
      [
        header,
        "it('mac', { skip: process.platform !== 'darwin' && 'seatbelt' }, () => {})",
        "it('mac2', { skip: process.platform === 'darwin' ? false : 'seatbelt' }, () => {})",
        "it('linux', { skip: process.platform !== 'linux' }, () => {})",
        "it('win', { skip: process.platform !== 'win32' }, () => {})",
        "it('posix', { skip: process.platform === 'win32' }, () => {})",
        "it('either', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {})",
        "it('probe', { skip: !gitOk || process.platform === 'win32' }, () => {})",
      ].join('\n'),
    )
    assert.deepEqual(sites, [])
    assert.deepEqual(inventory, { darwin: 2, linux: 1, win32: 1 })
  })

  it('counts tests under a gated describe, a shared options const and a t.skip() guard', () => {
    const { inventory } = scan(
      [
        header,
        "const darwinOnly = { skip: process.platform !== 'darwin' && 'seatbelt' }",
        "it('a', darwinOnly, async (t) => {})",
        "it('b', darwinOnly, async (t) => {})",
        "describe('s', { skip: process.platform !== 'linux' }, () => { it('c', () => {}) })",
        "it('d', (t) => { if (process.platform !== 'darwin') { t.skip('mac'); return } })",
      ].join('\n'),
    )
    assert.deepEqual(inventory, { darwin: 3, linux: 1 })
  })

  it('a new per-test darwin gate raises the count by one and passes the ratchet', () => {
    const before = `${header}it('a', { skip: process.platform !== 'darwin' }, () => {})\n`
    const after = `${before}it('b', { skip: process.platform !== 'darwin' && 'seatbelt' }, () => {})\n`
    assert.equal(scan(before).inventory.darwin, 1)
    assert.equal(scan(after).inventory.darwin, 2)
    assert.deepEqual(rules(after), [])
  })

  it('prints one line per platform with per-file counts, largest first', () => {
    const lines = formatPlatformInventory(
      new Map([
        ['b.test.ts', { darwin: 1 }],
        ['a.test.ts', { darwin: 3, win32: 1 }],
      ]),
    )
    assert.deepEqual(lines, [
      'darwin-only: 4 tests in 2 files (a.test.ts 3, b.test.ts 1)',
      'Linux-only: 0 tests in 0 files',
      'Windows-only: 1 test in 1 file (a.test.ts 1)',
    ])
  })
})
