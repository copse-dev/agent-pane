import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { HEADLESS_EXIT, headlessEventSchema } from '@copse/agent/headless-contract.ts'
import { main, reviewPermissionProfile } from './cli.ts'
import { decodeFindings } from './finding.ts'
import { createEphemeralRunnerBackend } from './host-process-backend.ts'
import type { IsolationBackend } from './isolation.ts'
import { REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { createTestRepo, worktreeCount, type TestRepo } from './test-repo.ts'

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

function finishReviewStep(checked: string, couldNotVerify = 'Nothing'): Record<string, unknown> {
  return { type: 'tool_call', name: 'finish_review', args: { checked, couldNotVerify } }
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

  it('places disposable checkouts under an explicit scratch parent', async () => {
    const repo = await fixture({})
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'review-cli-scratch-parent-')))
    scratch.push(parent)
    let cellScratch = ''
    const delegate = createEphemeralRunnerBackend()
    const backend: IsolationBackend = {
      ...delegate,
      createCell: (spec) => {
        cellScratch = spec.scratchDir
        return delegate.createCell(spec)
      },
    }
    let out = ''
    let err = ''
    const code = await main(['--base', 'main', '--no-model', '--scratch-parent', parent], {
      stdout: (text) => {
        out += text
      },
      stderr: (text) => {
        err += text
      },
      env: { PATH: process.env['PATH'] },
      cwd: repo.root,
      backend,
    })
    assert.equal(code, HEADLESS_EXIT.SUCCESS, `${err}\n${out}`)
    assert.equal(dirname(cellScratch), parent)
    await assert.rejects(access(cellScratch), { code: 'ENOENT' })
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
        finishReviewStep('src/math.ts and a focused runtime probe.'),
        { type: 'text', text: 'Done.' },
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
      /reviewer mock under correctness — completed \(end_turn\), 3 tool call\(s\), 1 candidate\(s\)/,
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
            finishReviewStep('src/math.ts and the changed implementation.'),
            { type: 'text', text: 'Done.' },
          ],
          'review:contracts': [
            report_finding('The add function subtracts instead of adding its second argument.'),
            finishReviewStep('The add contract and all of its callers.'),
            { type: 'text', text: 'Done.' },
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

  it('fails closed and refuses to call an unattested model run clean', async () => {
    const repo = await fixture({})
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify([{ type: 'text', text: 'I looked around and found no defects.' }]),
    )
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--provider',
      'mock',
      '--mock-script',
      script,
      '--no-verify',
    ])
    assert.equal(result.code, HEADLESS_EXIT.FAILURE)
    assert.match(result.out, /reviewer mock under correctness — failed \(error\)/)
    assert.match(result.out, /without calling the required finish_review tool/)
    assert.match(result.out, /Review incomplete: 1 of 1 reviewer run\(s\)/)
    assert.match(result.out, /No findings were produced before the incomplete review stopped\./)
    assert.doesNotMatch(result.out, /\nNo findings\.\n/)
  })

  it('does not call a completed but materially limited review clean', async () => {
    const repo = await fixture({})
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        finishReviewStep(
          'The changed implementation and its direct callers.',
          'Dependency source was unavailable in the read-only workspace.',
        ),
        { type: 'text', text: 'Done.' },
      ]),
    )
    const result = await run(repo, [
      '--base',
      'main',
      '--allow-unisolated',
      '--provider',
      'mock',
      '--mock-script',
      script,
      '--no-verify',
    ])
    assert.equal(result.code, HEADLESS_EXIT.SUCCESS, result.err)
    assert.match(
      result.out,
      /Could not verify \(mock \/ correctness\): Dependency source was unavailable/,
    )
    assert.match(result.out, /No findings were reported; review limits remain\./)
    assert.doesNotMatch(result.out, /\nNo findings\.\n/)
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

  it('reviews a foreign ref read-only when no container answers, and says so', async () => {
    const repo = await fixture({ test: { exit: 1 } })
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    // The contributor's branch: HEAD stays elsewhere, the ref is what is reviewed.
    const contributed = repo.git('rev-parse', 'HEAD')
    repo.git('update-ref', 'refs/pull/7/head', contributed)
    repo.git('checkout', '-q', 'main')
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { type: 'tool_call', name: 'run_command', args: { argv: [process.execPath, '-e', '1'] } },
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
          },
        },
        finishReviewStep(
          'src/math.ts and the changed implementation.',
          'Commands, because execution was denied.',
        ),
        { type: 'text', text: 'Done.' },
      ]),
    )
    // `--allow-unisolated` is not consent for a foreign diff (B3); the image
    // named here exists nowhere, so `auto` finds no container.
    const result = await run(repo, [
      '--base',
      'main',
      '--head',
      'refs/pull/7/head',
      '--foreign',
      '--allow-unisolated',
      '--image',
      'copse-review-test:never-built',
      '--provider',
      'mock',
      '--mock-script',
      script,
      '--no-verify',
      '--json',
      join(dir, 'report.json'),
    ])
    assert.equal(result.code, HEADLESS_EXIT.APPROVAL_REQUIRED, result.err)
    assert.match(result.err, /a foreign diff is reviewed read-only/)
    assert.match(result.out, /Not executed: a foreign diff/)
    // The reviewer still ran over the checkouts, but its run_command was denied.
    assert.match(result.out, /reviewer mock under correctness — completed/)
    assert.match(result.out, /1\. \[contract · high · high\] src\/math\.ts:1 — add subtracts/)
    const report: unknown = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))
    assert.ok(typeof report === 'object' && report !== null)
    const stage0: unknown = Reflect.get(report, 'stage0')
    assert.ok(typeof stage0 === 'object' && stage0 !== null)
    assert.equal(Reflect.get(stage0, 'headCommit'), contributed)
    assert.equal(Reflect.get(stage0, 'dirtyWorkingTree'), false)
  })

  it('executes a foreign ref on the ephemeral-runner backend, whose report another run can import', async () => {
    const repo = await fixture({ test: { exit: 1 } })
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-'))
    scratch.push(dir)
    const contributed = repo.git('rev-parse', 'HEAD')
    repo.git('update-ref', 'refs/pull/7/head', contributed)
    repo.git('checkout', '-q', 'main')
    const ground = join(dir, 'ground.json')
    // Job A: the runner is the cell; Stage 0 only, report to a file.
    const first = await run(repo, [
      '--base',
      'main',
      '--head',
      'refs/pull/7/head',
      '--foreign',
      '--backend',
      'ephemeral-runner',
      '--no-model',
      '--json',
      ground,
      '--quiet',
    ])
    assert.equal(first.code, HEADLESS_EXIT.SUCCESS, first.err)

    // Job B: the model stages over the same ref, executing nothing, and one
    // review posted on the pull request through an injected client.
    const script = join(dir, 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { type: 'tool_call', name: 'run_command', args: { argv: ['node', '-e', '1'] } },
        finishReviewStep(
          'The imported Stage 0 report and changed source.',
          'Focused commands were unavailable in the default read-only import.',
        ),
        { type: 'text', text: 'Done.' },
      ]),
    )
    const importedEvents = join(dir, 'imported.events.jsonl')
    const posts: { url: string; body: string }[] = []
    let out = ''
    let err = ''
    const code = await main(
      [
        '--base',
        'main',
        '--head',
        'refs/pull/7/head',
        '--foreign',
        '--stage0-json',
        ground,
        '--provider',
        'mock',
        '--mock-script',
        script,
        '--events',
        importedEvents,
        '--no-verify',
        '--post-review',
        'github',
        '--repo',
        'copse-dev/fixture',
        '--pr',
        '7',
      ],
      {
        stdout: (text) => {
          out += text
        },
        stderr: (text) => {
          err += text
        },
        env: { PATH: process.env['PATH'], GITHUB_TOKEN: 'ghs_test' },
        cwd: repo.root,
        fetch: (url, init) => {
          posts.push({ url, body: init.body })
          return Promise.resolve({ status: 200, text: () => Promise.resolve('') })
        },
      },
    )
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.match(out, /Copse Reviewer · Stage 0 · ephemeral-runner \(container\)/)
    assert.match(out, /test ✗ regressed/)
    assert.match(out, /1 finding\(s\):\n1\. \[test/)
    assert.match(err, /posted the review on copse-dev\/fixture#7/)
    const [post] = posts
    assert.ok(post)
    assert.equal(post.url, 'https://api.github.com/repos/copse-dev/fixture/pulls/7/reviews')
    assert.match(post.body, /Executed in the `ephemeral-runner` backend/)
    assert.match(post.body, /pnpm run test|check\.cjs/)
    assert.match(await readFile(importedEvents, 'utf8'), /run_command is denied/)

    const unsafe = await run(repo, [
      '--base',
      'main',
      '--head',
      'refs/pull/7/head',
      '--foreign',
      '--stage0-json',
      ground,
      '--backend',
      'ephemeral-runner',
      '--no-model',
    ])
    assert.equal(unsafe.code, HEADLESS_EXIT.USAGE)
    assert.match(unsafe.err, /model job holds secrets.*needs --backend container/)

    // A programmatic container-strength backend stands in for Job B's real
    // Docker cell. Its fresh checkout is prepared from a caller-trusted script
    // before the reviewer runs one focused command and cites that evidence.
    const trustedPrepare = join(dir, 'trusted-prepare.mts')
    await writeFile(
      trustedPrepare,
      "import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'; mkdirSync('node_modules/.pnpm/fixture@1.0.0/node_modules/fixture', { recursive: true }); writeFileSync('node_modules/.pnpm/fixture@1.0.0/node_modules/fixture/index.js', 'dependency source ready\\n'); symlinkSync('.pnpm/fixture@1.0.0/node_modules/fixture', 'node_modules/fixture', process.platform === 'win32' ? 'junction' : 'dir'); writeFileSync('.focused-ready', 'ready')\n",
    )
    const focusedScript = join(dir, 'focused-script.json')
    await writeFile(
      focusedScript,
      JSON.stringify([
        {
          type: 'tool_call',
          name: 'read_dependency_file',
          args: { path: 'node_modules/fixture/index.js' },
        },
        {
          type: 'tool_call',
          name: 'run_command',
          args: {
            argv: [
              'node',
              '-e',
              "const fs=require('node:fs');if(fs.readFileSync('.focused-ready','utf8')!=='ready')process.exit(2);console.log('focused test passed')",
            ],
          },
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
            reason: 'The focused runtime probe exercised the changed implementation.',
            commandCallIds: ['call-2'],
          },
        },
        finishReviewStep('The changed implementation and a focused runtime probe.'),
        { type: 'text', text: 'Done.' },
      ]),
    )
    let focusedOut = ''
    let focusedErr = ''
    const focusedEvents = join(dir, 'focused.events.jsonl')
    let focusedReadOnlyPaths: readonly string[] = []
    const delegate = createEphemeralRunnerBackend()
    const focusedBackend: IsolationBackend = {
      ...delegate,
      createCell: (spec) => {
        focusedReadOnlyPaths = spec.readOnlyPaths
        return delegate.createCell(spec)
      },
    }
    const focusedCode = await main(
      [
        '--base',
        'main',
        '--head',
        'refs/pull/7/head',
        '--foreign',
        '--stage0-json',
        ground,
        '--trusted-prepare',
        trustedPrepare,
        '--provider',
        'mock',
        '--mock-script',
        focusedScript,
        '--events',
        focusedEvents,
        '--no-verify',
      ],
      {
        stdout: (text) => {
          focusedOut += text
        },
        stderr: (text) => {
          focusedErr += text
        },
        env: { PATH: process.env['PATH'] },
        cwd: repo.root,
        backend: focusedBackend,
      },
    )
    assert.equal(focusedCode, HEADLESS_EXIT.SUCCESS, focusedErr)
    assert.match(focusedOut, /reviewer mock under correctness — completed/)
    assert.match(focusedOut, /1 command\(s\) as evidence/)
    assert.doesNotMatch(focusedOut, /run_command is denied/)
    const focusedEventText = await readFile(focusedEvents, 'utf8')
    assert.match(focusedEventText, /read_dependency_file/)
    assert.match(focusedEventText, /dependency source ready/)
    assert.ok(focusedReadOnlyPaths.includes(await realpath(trustedPrepare)))
    assert.equal(focusedReadOnlyPaths.includes(await realpath(dir)), false)

    // A report for another commit is refused before any model is called.
    const mismatch = await run(repo, [
      '--base',
      'main',
      '--head',
      'main',
      '--stage0-json',
      ground,
      '--no-model',
    ])
    assert.equal(mismatch.code, HEADLESS_EXIT.USAGE)
    assert.match(mismatch.err, /is a Stage 0 report for/)
  })

  it('rejects a bad backend, forge or repository before doing anything', async () => {
    const repo = await fixture({})
    const backend = await run(repo, ['--backend', 'vm'])
    assert.equal(backend.code, HEADLESS_EXIT.USAGE)
    assert.match(backend.err, /unknown backend vm/)
    const forge = await run(repo, ['--post-review', 'gitlab', '--repo', 'a/b', '--pr', '1'])
    assert.equal(forge.code, HEADLESS_EXIT.USAGE)
    assert.match(forge.err, /--post-review must be one of github, forgejo/)
    const noRepo = await run(repo, ['--post-review', 'github', '--pr', '1'])
    assert.match(noRepo.err, /needs --repo/)
    const noToken = await run(repo, ['--post-review', 'github', '--repo', 'a/b', '--pr', '1'])
    assert.match(noToken.err, /needs a token/)
    const noUrl = await run(repo, ['--post-review', 'forgejo', '--repo', 'a/b', '--pr', '1'], {
      FORGEJO_TOKEN: 'x',
    })
    assert.match(noUrl.err, /needs --forge-url/)
    const container = await run(repo, [
      '--backend',
      'container',
      '--image',
      'copse-review-test:never-built',
      '--no-model',
    ])
    assert.equal(container.code, HEADLESS_EXIT.APPROVAL_REQUIRED)
    assert.match(container.err, /no container backend for copse-review-test:never-built/)
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
      assert.equal(worktreeCount(repo), 1)
    } finally {
      controller.abort()
    }
  })
})
