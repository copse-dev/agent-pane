import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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
    assert.deepEqual(Reflect.get(report, 'reviews'), [])
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
      '--no-verify',
    ])
    assert.equal(result.code, HEADLESS_EXIT.SUCCESS, result.err)
    assert.match(
      result.out,
      /reviewer mock under correctness — completed \(end_turn\), 2 tool call\(s\), 1 candidate\(s\)/,
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

  it('fans out over lenses, clusters duplicate candidates, and verifies them', async () => {
    const repo = await fixture({})
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const report_finding = (claim: string): Record<string, unknown> => ({
      type: 'tool_call',
      name: 'report_finding',
      args: {
        path: 'src/math.ts',
        startLine: 1,
        class: 'contract',
        severity: 'high',
        confidence: 'high',
        claim,
        reason: 'The body is a - b.',
      },
    })
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify({
        roles: {
          'review:correctness': [
            report_finding('add subtracts its second argument instead of adding it.'),
            { type: 'text', text: 'Checked src/math.ts.' },
          ],
          'review:contracts': [
            report_finding('The add function subtracts instead of adding its second argument.'),
            { type: 'text', text: 'Checked callers of add.' },
          ],
          reproduce: [{ type: 'text', text: 'No reproducer.' }],
          challenge: [
            {
              type: 'tool_call',
              name: 'verdict',
              args: {
                status: 'stands',
                reason: 'src/math.ts line 1 subtracts; the test expects a sum.',
              },
            },
            { type: 'text', text: 'Stands.' },
          ],
        },
      }),
    )
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--provider',
      'mock',
      '--mock-script',
      script,
      '--lenses',
      'correctness,contracts',
      '--json',
      join(dir, 'report.json'),
    ])
    assert.equal(result.code, HEADLESS_EXIT.SUCCESS, result.err)
    assert.match(result.out, /reviewer mock under correctness/)
    assert.match(result.out, /reviewer mock under contracts/)
    assert.match(
      result.out,
      /verification: 1 attempted — 0 confirmed by reproducer, 0 refuted, 1 survived challenge/,
    )
    assert.match(result.out, /1 finding\(s\):/)
    assert.match(result.out, /corroborated by mock/)
    assert.match(result.out, /survived challenge by mock/)
    const report: unknown = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))
    assert.ok(typeof report === 'object' && report !== null)
    const findings = decodeFindings(Reflect.get(report, 'findings'))
    const [only] = findings ?? []
    assert.ok(only)
    assert.equal(findings?.length, 1)
    assert.equal(only.provenance.challengedBy.length, 1)
  })

  it('rejects an unknown lens with the usage exit code', async () => {
    const repo = await fixture({})
    const result = await run(repo, ['--lenses', 'vibes'])
    assert.equal(result.code, HEADLESS_EXIT.USAGE)
    assert.match(result.err, /unknown lens vibes/)
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
  it('does not load repository pnpm hooks during store discovery', async () => {
    const repo = await fixture({})
    const marker = join(repo.root, 'pnpm-hook-ran')
    await repo.write({
      '.pnpmfile.cjs': `require('fs').writeFileSync(${JSON.stringify(marker)},'host code ran');module.exports={hooks:{}}`,
    })
    const denied = await run(repo, ['--base', 'main', '--no-model'])
    assert.equal(denied.code, HEADLESS_EXIT.APPROVAL_REQUIRED)
    const allowed = await run(repo, ['--base', 'main', '--allow-unisolated', '--no-model'])
    assert.equal(allowed.code, HEADLESS_EXIT.SUCCESS)
    await assert.rejects(access(marker))
  })

  it('accepts forwarded pnpm separators through the actual executable', () => {
    const bin = resolve('packages/review/bin/copse-review.mjs')
    const direct = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    const forwarded = execFileSync(process.execPath, [bin, '--', '--help'], { encoding: 'utf8' })
    assert.equal(forwarded, direct)
    assert.match(forwarded, /^usage: copse-review/)
  })

  it('cancels Stage 0 without running the next check', { timeout: 15000 }, async () => {
    const repo = await fixture({})
    const ready = join(repo.root, 'cancel-ready')
    const later = join(repo.root, 'ran-after-cancel')
    await repo.write({
      'review.config.json': JSON.stringify({
        commands: {
          prepare: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},60000)`,
          ],
          test: [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(later)},'ran')`,
          ],
        },
      }),
    })
    const controller = new AbortController()
    const running = main(['--base', 'main', '--allow-unisolated', '--no-model'], {
      cwd: repo.root,
      env: process.env,
      signal: controller.signal,
      stdout: () => undefined,
      stderr: () => undefined,
    })
    try {
      for (let i = 0; i < 700; i++) {
        if (
          await access(ready).then(
            () => true,
            () => false,
          )
        )
          break
        await delay(10)
      }
      assert.equal(await readFile(ready, 'utf8'), 'ready')
      controller.abort(new Error('cancel review'))
      assert.equal(await running, HEADLESS_EXIT.CANCELLED)
      await assert.rejects(access(later))
      assert.doesNotMatch(repo.git('worktree', 'list'), /copse-review/)
    } finally {
      controller.abort()
    }
  })
})
