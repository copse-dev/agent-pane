import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { HEADLESS_EXIT } from '@copse/agent/headless-contract.ts'
import { writeFakeContainerEngine } from './fake-container-engine.ts'
import { localPullRequestMain, parsePrArgs, pullRequestNumber, type LocalPrIo } from './local-pr.ts'
import { REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { acquireReviewLock } from './review-lock.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Review Test',
  GIT_AUTHOR_EMAIL: 'review@example.invalid',
  GIT_COMMITTER_NAME: 'Review Test',
  GIT_COMMITTER_EMAIL: 'review@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

const runSchema = z.object({
  pr: z.number().nullable(),
  headCommit: z.string(),
  mergeBase: z.string(),
  profile: z.string().nullable(),
  image: z.string(),
  exitCode: z.number(),
  reviewArgs: z.array(z.string()),
})

const reportSchema = z.object({
  stage0: z.object({
    headCommit: z.string(),
    execution: z.object({ decision: z.object({ execute: z.boolean(), reason: z.string() }) }),
  }),
  reviews: z.array(z.object({ model: z.string(), lens: z.string() })),
})

interface Call {
  readonly file: string
  readonly args: readonly string[]
}

describe('copse-review pr', () => {
  let origin: TestRepo
  let root = ''
  let clone = ''
  let copseDir = ''
  let registry = ''
  let script = ''
  let headCommit = ''
  const calls: Call[] = []
  let io: LocalPrIo
  let out = ''
  let err = ''

  before(async () => {
    origin = await createTestRepo({
      'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node check.cjs' } }),
      'check.cjs': 'process.exit(0)\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({
        commands: {
          prepare: null,
          build: null,
          lint: null,
          typecheck: null,
          test: [process.execPath, 'check.cjs'],
        },
      }),
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
    })
    origin.git('checkout', '-q', '-b', 'contributor')
    await origin.write({
      'src/math.ts': 'export const add = (a: number, b: number): number => a - b\n',
    })
    headCommit = origin.commit('contributor change')
    origin.git('update-ref', 'refs/pull/7/head', 'contributor')
    origin.git('checkout', '-q', 'main')

    root = await realpath(await mkdtemp(join(tmpdir(), 'review-local-pr-')))
    clone = join(root, 'clone')
    execFileSync('git', ['clone', '-q', origin.root, clone], {
      env: { ...process.env, ...GIT_ENV },
    })
    copseDir = join(root, 'copse')
    registry = join(root, 'registry')
    await mkdir(registry)
    script = join(root, 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        {
          type: 'tool_call',
          name: 'finish_review',
          args: { checked: 'src/math.ts', couldNotVerify: 'Nothing' },
        },
        { type: 'text', text: 'Done.' },
      ]),
    )
    const engine = await writeFakeContainerEngine(registry)
    io = {
      stdout: (text: string): void => {
        out += text
      },
      stderr: (text: string): void => {
        err += text
      },
      env: { PATH: process.env['PATH'], COPSE_DIR: copseDir, ...GIT_ENV },
      cwd: clone,
      containerEngines: [{ argv: engine, dialect: 'docker' }],
      runHost: (file, args, options): void => {
        calls.push({ file, args })
        // The store is filled by pnpm from the registry; nothing here may reach one.
        if (file === 'pnpm' || file === 'npm') return
        execFileSync(file, [...args], { cwd: options.cwd, stdio: 'ignore' })
      },
    }
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
    await origin.remove()
  })

  const review = (extra: string[] = []): Promise<number> => {
    out = ''
    err = ''
    return localPullRequestMain(
      ['7', '--provider', 'mock', '--mock-script', script, '--no-verify', ...extra],
      io,
    )
  }

  /** The repository's directory under reviews/, named after the remote's last two path parts. */
  async function repositoryDir(): Promise<string> {
    const [slug] = await readdir(join(copseDir, 'reviews'))
    assert.ok(slug !== undefined, 'no repository directory under reviews/')
    return join(copseDir, 'reviews', slug)
  }

  async function reportDir(): Promise<string> {
    const parent = join(await repositoryDir(), 'pr-7')
    const [entry] = (await readdir(parent)).filter((name) => !name.endsWith('.json'))
    assert.ok(entry !== undefined, `no report under ${parent}`)
    return join(parent, entry)
  }

  it('fetches the pull request, prepares the cell and reviews it in a container', async () => {
    const code = await review()
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /fetching pull request 7 and main from origin/)
    assert.match(err, /building the validation image copse-review-cell:/)
    assert.match(out, /reviewer mock under correctness/)

    const dir = await reportDir()
    assert.ok(dir.includes(headCommit.slice(0, 12)))
    const run = runSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')))
    assert.equal(run.pr, 7)
    assert.equal(run.headCommit, headCommit)
    assert.equal(run.profile, 'pnpm')
    assert.equal(run.exitCode, HEADLESS_EXIT.SUCCESS)
    assert.ok(run.reviewArgs.includes('--foreign'))
    // The review runs on the commits resolved up front, not on refs that may move.
    assert.equal(run.reviewArgs[run.reviewArgs.indexOf('--head') + 1], headCommit)
    assert.equal(run.reviewArgs[run.reviewArgs.indexOf('--base') + 1], run.mergeBase)
    assert.equal(run.reviewArgs.includes('--trusted-prepare'), false)
    const report = reportSchema.parse(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')))
    assert.equal(report.stage0.headCommit, headCommit)
    assert.deepEqual(report.stage0.execution.decision, {
      execute: true,
      reason: 'foreign diff inside an ephemeral container',
    })
    assert.deepEqual(
      report.reviews.map((entry) => [entry.model, entry.lens]),
      [['mock', 'correctness']],
    )
    await access(join(dir, 'report.sarif'))
    await access(join(dir, 'events.jsonl'))
    assert.match(await readFile(join(dir, 'report.txt'), 'utf8'), /reviewer mock/)
    await access(join(await repositoryDir(), 'pr-7.latest.json'))

    // The store was filled for the cell's Linux, from the two lockfiles only.
    const fetches = calls.filter((call) => call.file === 'pnpm')
    assert.equal(fetches.length, 2)
    const storeDir = fetches[0]?.args[fetches[0].args.indexOf('--store-dir') + 1] ?? ''
    assert.match(storeDir, /cache\/review\/pnpm-store-linux-(arm64|x64)-glibc$/)
    assert.ok(storeDir.startsWith(copseDir))
    // The private ref namespace holds the fetched head; the user's refs are untouched.
    assert.equal(
      execFileSync('git', ['rev-parse', 'refs/copse-review/pr-7/head'], {
        cwd: clone,
        encoding: 'utf8',
      }).trim(),
      headCommit,
    )
    await assert.rejects(access(join(copseDir, 'cache', 'review', 'review.lock')), /ENOENT/)
  })

  it('answers the same question from the saved report', async () => {
    const before = calls.length
    const code = await review()
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /was already reviewed with these settings/)
    assert.match(out, /reviewer mock under correctness/)
    assert.equal(calls.length, before, 'nothing was prepared or built again')
  })

  it('reviews again with --fresh, reusing the filled store and the built image', async () => {
    const before = calls.length
    const code = await review(['--fresh'])
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.doesNotMatch(err, /already reviewed|building the validation image|filling the/)
    assert.match(out, /reviewer mock under correctness/)
    assert.equal(calls.length, before)
  })

  it('treats different review settings as a different question', async () => {
    const code = await review(['--lenses', 'contracts'])
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.doesNotMatch(err, /already reviewed/)
    assert.match(out, /reviewer mock under contracts/)
  })

  it('does not answer from a saved report made with other settings or another model', async () => {
    const out = join(root, 'fixed-out')
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /already reviewed/)
    // Same directory, other options: a different question, reviewed again.
    assert.equal(await review(['--out', out, '--max-steps', '5']), HEADLESS_EXIT.SUCCESS, err)
    assert.doesNotMatch(err, /already reviewed/)
    // Same command line, another model chosen by the environment.
    const previousEnv = io.env
    io = { ...io, env: { ...previousEnv, LM_STUDIO_MODEL: 'another-model' } }
    try {
      assert.equal(await review(['--out', out, '--max-steps', '5']), HEADLESS_EXIT.SUCCESS, err)
      assert.doesNotMatch(err, /already reviewed/)
    } finally {
      io = { ...io, env: previousEnv }
    }
  })

  it('gives a change with no lockfile an empty store, never the host’s own', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'no-lockfile', 'refs/copse-review/pr-7/head'], {
      cwd: clone,
      env: { ...process.env, ...GIT_ENV },
    })
    execFileSync('git', ['rm', '-q', 'pnpm-lock.yaml'], { cwd: clone })
    execFileSync('git', ['commit', '-q', '-m', 'drop the lockfile'], {
      cwd: clone,
      env: { ...process.env, ...GIT_ENV },
    })
    out = ''
    err = ''
    const code = await localPullRequestMain(['no-lockfile', '--base', 'main', '--no-model'], io)
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /nothing to install/)
    const dir = join(await repositoryDir(), 'no-lockfile')
    const [entry] = await readdir(dir)
    assert.ok(entry !== undefined)
    const run = runSchema.parse(JSON.parse(await readFile(join(dir, entry, 'run.json'), 'utf8')))
    assert.equal(run.profile, null)
    assert.equal(
      run.reviewArgs[run.reviewArgs.indexOf('--store') + 1],
      join(copseDir, 'cache', 'review', 'empty-store'),
    )
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: clone })
  })

  it('refuses the options it sets itself, and a pull request the remote does not have', async () => {
    out = ''
    err = ''
    assert.equal(await localPullRequestMain(['7', '--head', 'x'], io), HEADLESS_EXIT.USAGE)
    assert.match(err, /--head is set by copse-review pr/)
    err = ''
    assert.equal(await localPullRequestMain(['99', '--no-model'], io), HEADLESS_EXIT.USAGE)
    assert.match(err, /copse-review pr:/)
  })
})

describe('copse-review pr arguments', () => {
  it('reads a pull request number from a number, #number or forge URL', () => {
    assert.equal(pullRequestNumber('123'), 123)
    assert.equal(pullRequestNumber('#45'), 45)
    assert.equal(pullRequestNumber('https://github.com/copse-dev/agent-pane/pull/4205'), 4205)
    assert.equal(pullRequestNumber('https://github.com/o/r/pull/9/files'), 9)
    assert.equal(pullRequestNumber('https://code.example/o/r/pulls/12'), 12)
    assert.equal(pullRequestNumber('https://gitlab.example/g/r/-/merge_requests/3'), 3)
    assert.equal(pullRequestNumber('feature/branch'), null)
    assert.equal(pullRequestNumber('0'), null)
  })

  it('separates its own options from the review’s, keeping the review’s order', () => {
    const options = parsePrArgs([
      '12',
      '--model',
      'qwen3-coder',
      '--remote=upstream',
      '--cell-memory',
      '12g',
      '--cell-cpus=6',
      '--fresh',
      '--lenses',
      'all',
    ])
    assert.equal(options.target, '12')
    assert.equal(options.remote, 'upstream')
    assert.deepEqual(options.limits, { memory: '12g', cpus: 6, pids: 512 })
    assert.equal(options.fresh, true)
    assert.deepEqual(options.review, ['--model', 'qwen3-coder', '--lenses', 'all'])
    assert.throws(() => parsePrArgs(['--model', 'x']), /name the pull request first/)
    assert.throws(() => parsePrArgs(['1', '--profile', 'yarn']), /--profile/)
    assert.throws(() => parsePrArgs(['1', '--cell-cpu', 'ia32']), /--cell-cpu/)
    assert.throws(() => parsePrArgs(['1', '--cell-memory', 'lots']), /--cell-memory/)
    assert.throws(() => parsePrArgs(['1', '--json', 'x']), /--json is set by/)
    assert.throws(() => parsePrArgs(['1', '--remote']), /--remote needs a value/)
  })
})

describe('review lock', () => {
  it('waits for a live holder and takes over one that died', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-lock-'))
    try {
      const path = join(dir, 'review.lock')
      const release = await acquireReviewLock(path, { label: 'first' })
      let waitedOn = ''
      const second = acquireReviewLock(path, {
        label: 'second',
        pollMs: 10,
        onWait: (owner) => {
          waitedOn = owner?.label ?? ''
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(waitedOn, 'first')
      await release()
      const releaseSecond = await second
      await releaseSecond()

      await mkdir(path)
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ pid: 999_999, startedAt: 0, label: 'gone' }),
      )
      const takeover = await acquireReviewLock(path, { label: 'third', isAlive: () => false })
      await takeover()
      await assert.rejects(access(path), /ENOENT/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes over a holder from before the last boot, and never releases another’s lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-lock-'))
    try {
      const path = join(dir, 'review.lock')
      // This process is alive, but the record says it started before the boot.
      await mkdir(path)
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: 1_000, label: 'before boot' }),
      )
      const release = await acquireReviewLock(path, { label: 'after boot', bootedAt: 2_000 })
      // Someone else's lock now stands where ours was: our release leaves it.
      await writeFile(
        join(path, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now(), label: 'other', nonce: 'x' }),
      )
      await release()
      await access(join(path, 'owner.json'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops waiting when cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-lock-'))
    try {
      const path = join(dir, 'review.lock')
      const release = await acquireReviewLock(path, { label: 'held' })
      const controller = new AbortController()
      const waiting = acquireReviewLock(path, {
        label: 'waiting',
        pollMs: 10,
        signal: controller.signal,
      })
      controller.abort(new Error('cancelled'))
      await assert.rejects(waiting, /cancelled|aborted/)
      await release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
