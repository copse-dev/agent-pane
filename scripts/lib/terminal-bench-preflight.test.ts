import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  capTerminalPreflightText,
  formatTerminalPreflightBlock,
  injectTerminalPreflight,
  runTerminalPreflight,
  TERMINAL_PREFLIGHT_BEGIN,
  TERMINAL_PREFLIGHT_END,
  TERMINAL_PREFLIGHT_MAX_CHARS,
  TERMINAL_PREFLIGHT_TIMEOUT_SEC,
  terminalPreflightCommand,
} from './terminal-bench-preflight.mts'
import type { TerminalToolResult } from './terminal-bench-protocol.mts'
import { terminalBenchProfile } from './terminal-bench-profiles.mts'

function result(overrides: Partial<TerminalToolResult>): TerminalToolResult {
  return {
    type: 'tool_result',
    id: 'preflight-0',
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

describe('terminal benchmark pre-flight probe', () => {
  it('builds a read-only command covering the environment facts', () => {
    const command = terminalPreflightCommand()
    for (const needle of [
      'ls -la /tests',
      'ls -la /app',
      'pwd',
      'python3',
      '/logs/verifier',
      'head -c',
    ]) {
      assert.ok(command.includes(needle), needle)
    }
    assert.doesNotMatch(command, /(?:^|[\s;|&])(?:rm|mv|cp|mkdir|touch|tee|chmod|sed -i)\s/m)
    assert.doesNotMatch(command, /(?<![0-9&])>\s*[^&\s]/)
  })

  it('runs under sh, never writes, and states a missing /tests explicitly', () => {
    const output = execFileSync('sh', ['-c', terminalPreflightCommand()], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.match(output, /== cwd ==/)
    assert.match(output, /== \/logs\/verifier ==/)
    if (!output.includes('/tests: readable')) {
      assert.match(output, /\/tests: missing or unreadable.*do not search the filesystem/)
    }
  })

  it('caps output and strips control bytes', () => {
    const capped = capTerminalPreflightText(`a\0b${'x'.repeat(500)}`, 100)
    assert.ok(capped.length <= 100)
    assert.ok(!capped.includes('\0'))
    assert.match(capped, /truncated at 100 characters/)
    assert.equal(capTerminalPreflightText('short\n', 100), 'short')
  })

  it('never exceeds the hard cap, delimiters included', () => {
    const block = formatTerminalPreflightBlock(result({ stdout: 'y'.repeat(100_000) }))
    assert.ok(block.length <= TERMINAL_PREFLIGHT_MAX_CHARS)
    assert.ok(block.startsWith(TERMINAL_PREFLIGHT_BEGIN))
    assert.ok(block.endsWith(TERMINAL_PREFLIGHT_END))
    assert.match(block, /truncated/)
    const tiny = formatTerminalPreflightBlock(result({ stdout: 'y'.repeat(1000) }), 400)
    assert.ok(tiny.length <= 400)
  })

  it('formats unavailable and timed-out probes without hiding the gap', () => {
    assert.match(formatTerminalPreflightBlock(null), /could not be run/)
    assert.match(
      formatTerminalPreflightBlock(result({ exitCode: 124, stderr: 'Command timed out' })),
      /timed out; nothing is known/,
    )
    assert.match(
      formatTerminalPreflightBlock(result({ exitCode: 2, stdout: 'partial' })),
      /partial[\s\S]*probe exited 2/,
    )
  })

  it('injects the block after the task and leaves the task untouched without one', () => {
    const block = formatTerminalPreflightBlock(result({ stdout: '== cwd ==\n/app' }))
    const message = injectTerminalPreflight('Fix the bug.', block)
    assert.ok(message.startsWith('Fix the bug.\n\n<environment_preflight>'))
    assert.match(message, /Treat \/tests as authoritative over \/app\/tests/)
    assert.equal(injectTerminalPreflight('Fix the bug.', null), 'Fix the bug.')
  })

  it('makes exactly one exec call with the bounded timeout', async () => {
    const calls: Array<[string, number]> = []
    const run = await runTerminalPreflight(async (command, timeoutSec) => {
      calls.push([command, timeoutSec])
      return result({ stdout: '== cwd ==\n/app' })
    })
    assert.deepEqual(calls, [[terminalPreflightCommand(), TERMINAL_PREFLIGHT_TIMEOUT_SEC]])
    assert.equal(run.ok, true)
    assert.match(run.block, /\/app/)
  })

  it('degrades to an unavailable block when the bridge fails', async () => {
    const run = await runTerminalPreflight(async () => {
      throw new Error('bridge closed')
    })
    assert.equal(run.ok, false)
    assert.match(run.block, /could not be run/)
  })

  it('is enabled only for main-legacy@2 and keeps @1 hash and alias stable', () => {
    assert.equal(terminalBenchProfile('main-legacy@2').preflightProbe, true)
    for (const id of ['main-legacy', 'main-legacy@1', 'pr-1149', 'product-aligned']) {
      assert.equal(terminalBenchProfile(id).preflightProbe, false, id)
    }
    assert.equal(terminalBenchProfile('main-legacy').versionedId, 'main-legacy@1')
    assert.notEqual(
      terminalBenchProfile('main-legacy@2').contentHash,
      terminalBenchProfile('main-legacy@1').contentHash,
    )
    const prompt = terminalBenchProfile('main-legacy@2').systemPrompt
    assert.match(prompt, /environment_preflight/)
    assert.match(
      prompt,
      /authoritative over similarly named files elsewhere, including \/app\/tests/,
    )
    assert.doesNotMatch(prompt, /Start by checking \/tests directly/)
  })
})
