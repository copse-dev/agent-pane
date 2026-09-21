import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEADLESS_EXIT, headlessEventSchema } from '@copse/agent/headless-contract.ts'
import { main, reviewPermissionProfile } from './cli.ts'
import { decodeFindings } from './finding.ts'
import { REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'

const CHECK_SCRIPT = `
const { readFileSync } = require('node:fs')
let spec = {}
try { spec = JSON.parse(readFileSync('checks.json', 'utf8')) } catch {}
process.exit((spec[process.argv[2]] ?? { exit: 0 }).exit ?? 0)
`

const repos: TestRepo[] = []
const scratch: string[] = []
after(async () => {
  await Promise.all([
    ...repos.map((repo) => repo.remove()),
    ...scratch.map((dir) => rm(dir, { recursive: true, force: true })),
  ])
})

async function fixture(headChecks: Record<string, unknown>): Promise<TestRepo> {
  const repo = await createTestRepo({
    'package.json': JSON.stringify(
      { name: 'fixture', scripts: { test: 'node check.cjs test' } },
      null,
      2,
    ),
    'check.cjs': CHECK_SCRIPT,
    [REVIEW_CONFIG_FILENAME]: JSON.stringify({
      commands: {
        prepare: null,
        build: null,
        lint: null,
        typecheck: null,
        test: [process.execPath, 'check.cjs', 'test'],
      },
    }),
    'checks.json': '{}',
    'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
  })
  repos.push(repo)
  repo.git('checkout', '-q', '-b', 'feature')
  await repo.write({
    'checks.json': JSON.stringify(headChecks),
    'src/math.ts': 'export const add = (a: number, b: number): number => a - b\n',
  })
  repo.commit('head change')
  return repo
}

interface Captured {
  out: string
  err: string
  code: number
}

async function run(
  repo: TestRepo,
  args: string[],
  env: Record<string, string> = {},
): Promise<Captured> {
  let out = ''
  let err = ''
  const code = await main(args, {
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
    env: { PATH: process.env['PATH'], ...env },
    cwd: repo.root,
  })
  return { out, err, code }
}

describe('copse-review CLI', () => {
  it('prints usage and rejects unknown flags with the usage exit code', async () => {
    const repo = await fixture({})
    const help = await run(repo, ['--help'])
    assert.equal(help.code, HEADLESS_EXIT.SUCCESS)
    assert.match(help.out, /^usage: copse-review/)
    const bad = await run(repo, ['--bogus'])
    assert.equal(bad.code, HEADLESS_EXIT.USAGE)
    assert.match(bad.err, /copse-review: /)
    const badProvider = await run(repo, ['--provider', 'carrier-pigeon'])
    assert.equal(badProvider.code, HEADLESS_EXIT.USAGE)
  })

  it('refuses to execute without consent and says so with the approval exit code', async () => {
    const repo = await fixture({})
    const result = await run(repo, ['--base', 'main', '--no-model'])
    assert.equal(result.code, HEADLESS_EXIT.APPROVAL_REQUIRED)
    assert.match(result.out, /Not executed: .*consent/)
  })

  it('runs Stage 0 alone with --no-model and writes JSON and SARIF', async () => {
    const repo = await fixture({ test: { exit: 1 } })
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--no-model',
      '--json',
      join(dir, 'report.json'),
      '--sarif',
      join(dir, 'report.sarif'),
    ])
    assert.equal(result.code, HEADLESS_EXIT.SUCCESS, result.err)
    assert.match(result.out, /test ✗ regressed/)
    assert.match(result.out, /1 finding\(s\):\n1\. \[test/)
    const report: unknown = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))
    assert.ok(typeof report === 'object' && report !== null)
    const findings = decodeFindings(Reflect.get(report, 'findings'))
    assert.equal(findings?.length, 1)
    assert.equal(Reflect.get(report, 'review'), null)
    const sarif: unknown = JSON.parse(await readFile(join(dir, 'report.sarif'), 'utf8'))
    assert.ok(typeof sarif === 'object' && sarif !== null)
    assert.equal(Reflect.get(sarif, 'version'), '2.1.0')
  })

  it('runs the scripted reviewer end to end, emitting a conformant event stream', async () => {
    const repo = await fixture({})
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        {
          type: 'tool_call',
          name: 'run_command',
          args: { argv: [process.execPath, '-e', 'console.log(1-1)'] },
        },
        {
          type: 'tool_call',
          name: 'report_finding',
          args: {
            path: 'src/math.ts',
            startLine: 1,
            class: 'contract',
            severity: 'high',
            confidence: 'high',
            claim: 'add subtracts its second argument.',
            reason: 'The body is a - b.',
            commandCallIds: ['call-1'],
          },
        },
        { type: 'text', text: 'Checked src/math.ts and ran a probe.' },
      ]),
    )
    const events = join(dir, 'events.jsonl')
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--provider',
      'mock',
      '--mock-script',
      script,
      '--events',
      events,
      '--json',
      join(dir, 'report.json'),
    ])
    assert.equal(result.code, HEADLESS_EXIT.SUCCESS, result.err)
    assert.match(
      result.out,
      /model review: mock under correctness — completed \(end_turn\), 2 tool call\(s\), 1 candidate\(s\)/,
    )
    assert.match(result.out, /1\. \[contract · high · high\] src\/math\.ts:1 — add subtracts/)
    assert.match(result.out, /unverified: The body is a - b\./)
    assert.match(result.out, /1 command\(s\) as evidence/)
    const lines = (await readFile(events, 'utf8')).trim().split('\n')
    const parsed = lines.map((line) => headlessEventSchema.parse(JSON.parse(line)))
    assert.equal(parsed[0]?.type, 'turn_start')
    assert.equal(parsed.at(-1)?.type, 'turn_end')
    assert.ok(parsed.some((event) => event.type === 'tool_call' && event.name === 'run_command'))
  })

  it('reports a model failure with the failure exit code and no findings from it', async () => {
    const repo = await fixture({})
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--provider',
      'openrouter',
    ])
    assert.equal(result.code, HEADLESS_EXIT.FAILURE)
    assert.match(result.err, /model review did not run: --model is required/)
    assert.match(result.out, /No findings from Stage 0\./)
  })

  it('derives the permission profile from the execution decision, failing closed', () => {
    assert.equal(reviewPermissionProfile(true).shell, 'allow')
    assert.equal(reviewPermissionProfile(false).shell, 'deny')
    assert.equal(reviewPermissionProfile(true).default, 'deny')
    assert.equal(reviewPermissionProfile(true).fileWrite, undefined)
  })
})
