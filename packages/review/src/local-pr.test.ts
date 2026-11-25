import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { HEADLESS_EXIT } from '@copse/agent/headless-contract.ts'
import { writeFakeContainerEngine } from './fake-container-engine.ts'
import {
  defaultPrCellLimits,
  fitCellLimits,
  parseEngineCapacity,
  localPullRequestMain,
  nothingConcluded,
  parsePrArgs,
  pullRequestNumber,
  pullRequestRepository,
  questionArgs,
  reportNotReusable,
  type LocalPrIo,
} from './local-pr.ts'
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
  reusable: z.boolean(),
  limits: z.object({ memory: z.string(), cpus: z.number(), pids: z.number() }),
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

  const out_ = (): string => out

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
    assert.equal(run.reusable, true)
    assert.match(run.limits.memory, /^\d+g$/)
    assert.doesNotMatch(err, /no check reached a verdict/)
    assert.ok(run.reviewArgs.includes('--foreign'))
    // Paths recorded are the published report's, not the run's staging directory.
    assert.equal(run.reviewArgs[run.reviewArgs.indexOf('--json') + 1], join(dir, 'report.json'))
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

  it('leaves the saved report as it was when a re-run is cancelled, with nothing half-made', async () => {
    const dir = await reportDir()
    const saved = await readFile(join(dir, 'run.json'), 'utf8')
    const controller = new AbortController()
    // Cancel once the re-run has written its own report, before it is published.
    const code = await localPullRequestMain(
      ['7', '--provider', 'mock', '--mock-script', script, '--no-verify', '--fresh'],
      {
        ...io,
        signal: controller.signal,
        stdout: () => {
          controller.abort(new Error('cancelled by the test'))
        },
      },
    )
    assert.equal(code, HEADLESS_EXIT.CANCELLED)
    assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), saved)
    assert.deepEqual(
      (await readdir(dirname(dir))).filter((name) => name.includes('.partial-')),
      [],
    )
  })

  it('leaves the saved report as it was when its own time limit cuts a re-run short', async (t) => {
    const dir = await reportDir()
    const saved = await readFile(join(dir, 'run.json'), 'utf8')
    // The one-minute deadline fires at once; every other timeout is untouched.
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(ms === 60_000 ? 0 : ms))
    const code = await review(['--fresh', '--time-limit', '1'])
    assert.equal(code, HEADLESS_EXIT.CANCELLED, err)
    assert.match(err, /time limit was reached/)
    assert.match(err, /any saved report is unchanged/)
    assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), saved)
    assert.deepEqual(
      (await readdir(dirname(dir))).filter((name) => name.includes('.partial-')),
      [],
    )
  })

  it('keeps a saved report when a re-run is refused before it starts, and leaves nothing new', async () => {
    const out = join(root, 'failed-out')
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    const saved = await readFile(join(out, 'run.json'), 'utf8')
    // An option the review refuses is caught by the pre-flight, before the
    // lock, the store or a run directory.
    const code = await review(['--out', out, '--fresh', '--max-verify', 'lots'])
    assert.equal(code, HEADLESS_EXIT.USAGE, err)
    assert.match(err, /--max-verify/)
    assert.equal(await readFile(join(out, 'run.json'), 'utf8'), saved)
    assert.ok(await readFile(join(out, 'report.json'), 'utf8'))
    const first = join(root, 'failed-first')
    assert.equal(await review(['--out', first, '--max-verify', 'lots']), HEADLESS_EXIT.USAGE)
    await assert.rejects(access(first), /ENOENT/)
  })

  it('fetches only from a remote this repository has, so the name never reaches git as an option', async () => {
    const marker = join(root, 'ran-a-host-command')
    // A value that `git fetch` would read as --upload-pack and run on the host.
    const hostile = await localPullRequestMain(
      ['7', `--remote=--upload-pack=touch ${marker}`, '--no-model'],
      io,
    )
    assert.equal(hostile, HEADLESS_EXIT.USAGE)
    await assert.rejects(access(marker), /ENOENT/)
    out = ''
    err = ''
    const unknown = await localPullRequestMain(['7', '--remote', 'upstream', '--no-model'], io)
    assert.equal(unknown, HEADLESS_EXIT.USAGE, err)
    assert.match(err, /upstream is not a remote of this repository \(it has origin\)/)
  })

  it('runs only the pre-flight for pr --preflight, and refuses --summary-only', async () => {
    const out = join(root, 'preflight-out')
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    const saved = await readFile(join(out, 'run.json'), 'utf8')
    assert.equal(await review(['--out', out, '--fresh', '--preflight']), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /the model routes can run this review/)
    assert.doesNotMatch(err, /reviewing [0-9a-f]{12} against/)
    assert.equal(await readFile(join(out, 'run.json'), 'utf8'), saved)
    assert.ok(await readFile(join(out, 'report.json'), 'utf8'))
    assert.equal(await review(['--summary-only']), HEADLESS_EXIT.USAGE)
    assert.match(err, /--summary-only is not supported here/)
  })

  it('saves the text report of a --quiet run, so a later plain ask still reads it', async () => {
    const out = join(root, 'quiet-out')
    assert.equal(await review(['--out', out, '--quiet']), HEADLESS_EXIT.SUCCESS, err)
    assert.equal(out_(), '', 'nothing on stdout for the quiet caller')
    assert.match(await readFile(join(out, 'report.txt'), 'utf8'), /reviewer mock under correctness/)
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /was already reviewed with these settings/)
    assert.match(out_(), /reviewer mock under correctness/)
  })

  it("shows the cells only the reviewed history, never the caller's other branches", async () => {
    // The caller's clone holds private work the change must not be able to read.
    execFileSync('git', ['branch', 'private-work'], { cwd: clone })
    // A change whose test prints every ref its checkout's git directory holds.
    origin.git('checkout', '-q', '-b', 'peek', 'main')
    await origin.write({
      'check.cjs':
        "const { execFileSync } = require('node:child_process');\n" +
        "console.log(execFileSync('git', ['for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }));\n" +
        'process.exit(1)\n',
    })
    origin.commit('print the refs')
    origin.git('update-ref', 'refs/pull/8/head', 'peek')
    origin.git('checkout', '-q', 'main')
    out = ''
    err = ''
    const target = join(root, 'peek-out')
    const code = await localPullRequestMain(['8', '--no-model', '--out', target], io)
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    const report = z
      .object({
        stage0: z.object({
          repositoryRoot: z.string(),
          checks: z.array(
            z.object({ kind: z.string(), head: z.object({ output: z.string() }).nullable() }),
          ),
        }),
      })
      .parse(JSON.parse(await readFile(join(target, 'report.json'), 'utf8')))
    // The report names the caller's clone, not the scratch repository the run removed.
    assert.equal(report.stage0.repositoryRoot, clone)
    assert.match(
      await readFile(join(target, 'report.sarif'), 'utf8'),
      new RegExp(`"file://${clone}/"`),
    )
    const seen = report.stage0.checks.find((check) => check.kind === 'test')?.head?.output ?? ''
    assert.match(seen, /refs\/copse-review\/head/)
    assert.doesNotMatch(seen, /private-work|refs\/remotes\/|refs\/copse-review\/pr-/)
    // Nothing of the review repository is left once the run ends.
    const cache = await readdir(join(copseDir, 'cache', 'review'))
    assert.deepEqual(
      cache.filter((name) => name.startsWith('repo-')),
      [],
    )
  })

  it('publishes into an existing --out directory without touching what else it holds', async () => {
    const out = join(root, 'shared-out')
    await mkdir(join(out, 'notes'), { recursive: true })
    await writeFile(join(out, 'notes.txt'), 'mine\n')
    await writeFile(join(out, 'notes', 'deep.txt'), 'also mine\n')
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), 'mine\n')
    assert.equal(await readFile(join(out, 'notes', 'deep.txt'), 'utf8'), 'also mine\n')
    // A second run replaces only the run's own files.
    assert.equal(await review(['--out', out, '--fresh']), HEADLESS_EXIT.SUCCESS, err)
    assert.deepEqual((await readdir(out)).sort(), [
      'events.jsonl',
      'notes',
      'notes.txt',
      'report.json',
      'report.sarif',
      'report.txt',
      'run.json',
    ])
  })

  it('publishes through an --out that links to another filesystem', async (t) => {
    const elsewhere = '/dev/shm'
    const device = await stat(elsewhere).then(
      (info) => info.dev,
      () => null,
    )
    if (device === null || device === (await stat(root)).dev) {
      t.skip('no second filesystem to link --out to')
      return
    }
    const target = await mkdtemp(join(elsewhere, 'review-out-'))
    try {
      const link = join(root, 'linked-out')
      await symlink(target, link)
      assert.equal(await review(['--out', link]), HEADLESS_EXIT.SUCCESS, err)
      assert.ok((await lstat(link)).isSymbolicLink())
      assert.deepEqual((await readdir(target)).sort(), [
        'events.jsonl',
        'report.json',
        'report.sarif',
        'report.txt',
        'run.json',
      ])
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  it('refuses an --out that is a file before reviewing anything', async () => {
    const file = join(root, 'out-file')
    await writeFile(file, 'mine\n')
    assert.equal(await review(['--out', file]), HEADLESS_EXIT.USAGE)
    assert.match(err, /--out .*out-file is not a directory/)
    assert.doesNotMatch(err, /reviewing [0-9a-f]{12} against/)
    assert.equal(await readFile(file, 'utf8'), 'mine\n')
  })

  it('clears what a killed run left inside the same --out, and nothing else there', async () => {
    const out = join(root, 'killed-out')
    const leftover = join(out, '.copse-review.partial-dead')
    await mkdir(leftover, { recursive: true })
    await writeFile(join(leftover, 'report.json'), '{}\n')
    await writeFile(join(out, 'notes.txt'), 'mine\n')
    assert.equal(await review(['--out', out]), HEADLESS_EXIT.SUCCESS, err)
    await assert.rejects(access(leftover), /ENOENT/)
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), 'mine\n')
    assert.ok(await readFile(join(out, 'run.json'), 'utf8'))
  })

  it('reviews from a partial clone, fetching what it lacks of the reviewed history first', async () => {
    origin.git('config', 'uploadpack.allowFilter', 'true')
    origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true')
    const partial = join(root, 'partial')
    execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${origin.root}`, partial], {
      env: { ...process.env, ...GIT_ENV },
    })
    out = ''
    err = ''
    const target = join(root, 'partial-out')
    const code = await localPullRequestMain(['7', '--no-model', '--out', target], {
      ...io,
      cwd: partial,
    })
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.match(
      err,
      /this partial clone lacks [1-9]\d* object\(s\) of the reviewed history; fetching them from origin/,
    )
    assert.ok(await readFile(join(target, 'report.json'), 'utf8'))
  })

  it('refuses an engine name it does not know without a stack trace', async () => {
    const { containerEngines: _detected, ...detecting } = io
    const refused = async (args: string[], env: LocalPrIo['env']): Promise<void> => {
      out = ''
      err = ''
      const code = await localPullRequestMain(['7', '--no-model', ...args], { ...detecting, env })
      assert.equal(code, HEADLESS_EXIT.USAGE, err)
      assert.match(err, /bogus/)
      assert.doesNotMatch(err, /\n\s+at /)
    }
    await refused(['--engine', 'bogus'], io.env)
    await refused([], { ...io.env, COPSE_CONTAINER_ENGINE: 'bogus' })
  })

  it('removes the cells and scratch a hard-killed earlier review left behind', async () => {
    // As SIGKILL leaves things: a journalled cell container still there (Apple
    // container has no --rm) and its scratch checkout.
    const engine = io.containerEngines?.[0]?.argv
    assert.ok(engine)
    const reviewCache = join(copseDir, 'cache', 'review')
    const journal = join(reviewCache, 'containers.journal')
    await writeFile(
      journal,
      `${JSON.stringify({ name: 'copse-review-pr-dead-1', engine, dialect: 'docker' })}\nnot a record\n`,
    )
    await writeFile(join(registry, 'copse-review-pr-dead-1.active'), '')
    await mkdir(join(reviewCache, 'scratch', 'review-dead', 'head'), { recursive: true })
    // Its store-fill seed and its staging directory, which only its own
    // `finally` would have removed.
    const seed = join(reviewCache, 'seed-dead')
    await mkdir(seed)
    const staging = join(await repositoryDir(), 'pr-7', 'abc-dead.copse-review.partial-dead')
    await mkdir(staging, { recursive: true })
    // Its review repository, which only its own `finally` would have removed.
    const repository = join(reviewCache, 'repo-dead')
    await mkdir(repository)
    // What stays: the filled stores and the saved reports.
    const keptBefore = (await readdir(reviewCache)).filter(
      (name) => name.includes('store') || name.includes('cache'),
    )
    assert.ok(keptBefore.length > 0)
    const savedBefore = (await readdir(join(await repositoryDir(), 'pr-7'))).filter(
      (name) => !name.includes('.partial-'),
    )

    assert.equal(await review(['--fresh']), HEADLESS_EXIT.SUCCESS, err)
    assert.match(
      err,
      /cleared what an earlier review left: 1 container\(s\), 1 scratch directory\(ies\), 3 half-made run directory\(ies\)/,
    )
    await assert.rejects(access(seed), /ENOENT/)
    await assert.rejects(access(staging), /ENOENT/)
    await assert.rejects(access(repository), /ENOENT/)
    for (const name of keptBefore) await access(join(reviewCache, name))
    for (const name of savedBefore) await access(join(await repositoryDir(), 'pr-7', name))
    await access(join(registry, 'copse-review-pr-dead-1.removed'))
    await assert.rejects(access(join(registry, 'copse-review-pr-dead-1.active')), /ENOENT/)
    assert.deepEqual(await readdir(join(reviewCache, 'scratch')), [])
    // This run's own cells were removed as it went, so nothing is left listed.
    assert.equal(await readFile(journal, 'utf8'), '')
  })

  it('drops a cell container from the journal as soon as it is gone', async () => {
    const journal = join(copseDir, 'cache', 'review', 'containers.journal')
    const removedBefore = new Set(readdirSync(registry).filter((n) => n.endsWith('.removed')))
    const snapshots: string[][] = []
    out = ''
    err = ''
    const code = await localPullRequestMain(
      ['7', '--provider', 'mock', '--mock-script', script, '--no-verify', '--fresh'],
      {
        ...io,
        // The report is printed after Stage 0's cells have come and gone: a run
        // killed here must leave only containers that may still exist listed.
        stdout: (text: string): void => {
          out += text
          if (snapshots.length > 0) return
          snapshots.push(
            readFileSync(journal, 'utf8')
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => z.object({ name: z.string() }).parse(JSON.parse(line)).name),
          )
        },
      },
    )
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    const removedThisRun = readdirSync(registry).filter(
      (n) => n.endsWith('.removed') && !removedBefore.has(n),
    )
    assert.ok(removedThisRun.length > 0, 'the run made and removed cell containers')
    const [listedWhileRunning] = snapshots
    assert.ok(listedWhileRunning !== undefined)
    for (const name of listedWhileRunning) {
      assert.ok(!removedThisRun.includes(`${name}.removed`), `${name} was gone but still listed`)
    }
  })

  it('refuses a missing local model before waiting for a review already running', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        request.url === '/api/v1/models'
          ? JSON.stringify({ models: [{ type: 'llm', key: 'loaded-model' }] })
          : '{}',
      )
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    // Another review holds this machine: a queued run would wait for it.
    const release = await acquireReviewLock(join(copseDir, 'cache', 'review', 'review.lock'), {
      label: 'the review ahead',
    })
    try {
      out = ''
      err = ''
      const code = await localPullRequestMain(
        [
          '7',
          '--provider',
          'lmstudio',
          '--model',
          'absent-model',
          '--base-url',
          `http://127.0.0.1:${String(address.port)}/v1`,
          '--fresh',
        ],
        io,
      )
      assert.equal(code, HEADLESS_EXIT.USAGE, err)
      assert.match(err, /has no model absent-model/)
      assert.doesNotMatch(err, /waiting for the review already running/)
    } finally {
      await release()
      server.close()
    }
  })

  it('treats different review settings as a different question', async () => {
    const code = await review(['--lenses', 'contracts'])
    assert.equal(code, HEADLESS_EXIT.SUCCESS, err)
    assert.doesNotMatch(err, /already reviewed/)
    assert.match(out, /reviewer mock under contracts/)
  })

  it('answers whatever the output flags, but not for another engine', async () => {
    assert.equal(await review(['--quiet']), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /already reviewed/)
    assert.equal(await review(['--time-limit', '30']), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /already reviewed/)
    assert.equal(await review(['--engine', 'podman']), HEADLESS_EXIT.SUCCESS, err)
    assert.doesNotMatch(err, /already reviewed/)
  })

  it('takes a forge URL for the remote’s own repository, and refuses one for another', async () => {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: clone })
      .toString()
      .trim()
      .split('/')
      .slice(-2)
      .join('/')
    const args = ['--provider', 'mock', '--mock-script', script, '--no-verify']
    out = ''
    err = ''
    const own = `https://forge.example/${remote.toUpperCase()}/pull/7`
    assert.equal(await localPullRequestMain([own, ...args], io), HEADLESS_EXIT.SUCCESS, err)
    assert.match(err, /already reviewed/)
    err = ''
    const other = 'https://github.com/someone-else/unrelated/pull/7'
    assert.equal(await localPullRequestMain([other, ...args], io), HEADLESS_EXIT.USAGE)
    assert.match(err, /is a pull request of someone-else\/unrelated, but origin is /)
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
    assert.equal(
      pullRequestRepository('https://github.com/Copse-Dev/Agent-Pane/pull/4205'),
      'copse-dev/agent-pane',
    )
    assert.equal(
      pullRequestRepository('https://gitlab.example/g/sub/r/-/merge_requests/3'),
      'sub/r',
    )
    assert.equal(pullRequestRepository('https://code.example/o/r/pulls/12/files'), 'o/r')
    assert.equal(pullRequestRepository('123'), null)
    assert.equal(pullRequestRepository('feature/branch'), null)
  })

  it('sizes a default cell from this machine, within 4g–16g and 2–8 CPUs', () => {
    const gib = 1024 ** 3
    assert.deepEqual(defaultPrCellLimits({ memoryBytes: 96 * gib, cpus: 28 }), {
      memory: '16g',
      cpus: 8,
      pids: 512,
    })
    assert.deepEqual(defaultPrCellLimits({ memoryBytes: 32 * gib, cpus: 10 }), {
      memory: '8g',
      cpus: 5,
      pids: 512,
    })
    assert.deepEqual(defaultPrCellLimits({ memoryBytes: 8 * gib, cpus: 2 }), {
      memory: '4g',
      cpus: 2,
      pids: 512,
    })
    assert.deepEqual(parsePrArgs(['7'], { memoryBytes: 64 * gib, cpus: 16 }).limits, {
      memory: '16g',
      cpus: 8,
      pids: 512,
    })
  })

  it('fits a default cell to a smaller engine VM, and notes a limit the caller set beyond it', () => {
    const gib = 1024 ** 3
    // colima's default VM: 2 CPUs, 2 GiB. Docker and Podman say so differently.
    const colima = parseEngineCapacity(
      JSON.stringify({ NCPU: 2, MemTotal: 2 * gib, Name: 'colima' }),
    )
    assert.deepEqual(colima, { cpus: 2, memoryBytes: 2 * gib })
    assert.deepEqual(
      parseEngineCapacity(JSON.stringify({ host: { cpus: 4, memTotal: 8 * gib } })),
      { cpus: 4, memoryBytes: 8 * gib },
    )
    assert.equal(parseEngineCapacity('not json'), null)
    const sized = { memory: '16g', cpus: 8, pids: 512 }
    const defaults = { memory: false, cpus: false }
    const fitted = fitCellLimits(sized, defaults, colima)
    assert.deepEqual(fitted.limits, { memory: '1g', cpus: 2, pids: 512 })
    // The run says what it lowered, not only run.json.
    assert.deepEqual(fitted.notes, [
      "the default --cell-memory 16g is lowered to 1g, three quarters of the engine VM's memory",
      "the default --cell-cpus 8 is lowered to the engine VM's 2",
    ])
    const asked = fitCellLimits(sized, { memory: true, cpus: true }, colima)
    assert.deepEqual(asked.limits, sized)
    assert.equal(asked.notes.length, 2)
    assert.match(asked.notes.join('\n'), /--cell-cpus 8 is more than the engine's VM has \(2\)/)
    // Apple container sizes a VM per cell: nothing to fit.
    assert.deepEqual(fitCellLimits(sized, defaults, null), { limits: sized, notes: [] })
  })

  it('reuses only a report whose Stage 0 preparation passed and whose checks all ran', () => {
    const passed = { status: 'passed' }
    const settled = (
      head: { status: string } | null,
      verdicts: string[],
    ): Parameters<typeof reportNotReusable>[0] => ({
      stage0: {
        preparation: { head, base: null },
        checks: verdicts.map((verdict) => ({ kind: 'test', verdict })),
      },
    })
    assert.equal(reportNotReusable(settled(passed, ['clean', 'regressed'])), null)
    assert.equal(reportNotReusable(settled(null, ['clean'])), null)
    // A flaky install is asked again, not saved as the answer.
    assert.match(reportNotReusable(settled({ status: 'failed' }, ['not-run'])) ?? '', /preparation/)
    assert.match(reportNotReusable(settled(passed, ['not-run'])) ?? '', /test did not run/)
    // A check that ran out of memory, timed out, or whose head runs disagreed
    // depends on that run; the 4g cell's report must not answer the next ask.
    assert.match(
      reportNotReusable({
        stage0: {
          preparation: { head: passed, base: null },
          checks: [
            { kind: 'typecheck', verdict: 'undetermined', transient: true },
            { kind: 'test', verdict: 'undetermined' },
          ],
        },
      }) ?? '',
      /^typecheck did not settle on this run$/,
    )
    assert.match(reportNotReusable(null) ?? '', /could not be read/)
    // Exit 0 with no verdict anywhere is not a clean change, and the run says so.
    assert.equal(nothingConcluded(settled(passed, ['undetermined', 'not-run'])), true)
    assert.equal(nothingConcluded(settled(passed, ['undetermined', 'clean'])), false)
    assert.equal(nothingConcluded(settled(null, [])), false)
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
    // Both reach git, where a leading dash is an option.
    assert.throws(() => parsePrArgs(['1', '--remote=--upload-pack=touch x']), /--remote must not/)
    assert.throws(() => parsePrArgs(['1', '--base', '-x']), /--base must not/)
  })

  it('leaves output-only options out of the question a saved report answers', () => {
    assert.deepEqual(
      questionArgs([
        '--model',
        'm',
        '--quiet',
        '--time-limit',
        '60',
        '--time-limit=5',
        '--lenses',
        'all',
      ]),
      ['--model', 'm', '--lenses', 'all'],
    )
  })
})

describe('review lock', () => {
  it('waits for a live holder and takes over one that died', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-lock-'))
    try {
      const path = join(dir, 'review.lock')
      const release = await acquireReviewLock(path, { label: 'first' })
      // Await the wait itself rather than a wall-clock pause.
      const { promise: waitedOn, resolve: noteWait } = Promise.withResolvers<string>()
      const second = acquireReviewLock(path, {
        label: 'second',
        pollMs: 10,
        onWait: (owner) => {
          noteWait(owner?.label ?? '')
        },
      })
      assert.equal(await waitedOn, 'first')
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
