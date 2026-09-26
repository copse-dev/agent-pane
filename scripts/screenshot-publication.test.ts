import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

// Exercise the scripts Actions actually executes, including their API decisions.
const stepsSchema = z.array(
  z.object({
    name: z.string().optional(),
    id: z.string().optional(),
    uses: z.string().optional(),
    if: z.string().optional(),
    'continue-on-error': z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  }),
)
const steps = z
  .object({ jobs: z.object({ publish: z.object({ steps: stepsSchema }) }) })
  .parse(load(readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8'))).jobs
  .publish.steps
const closeSteps = z
  .object({ jobs: z.object({ close: z.object({ steps: stepsSchema }) }) })
  .parse(load(readFileSync('.github/workflows/close-orphaned-screenshot-reviews.yml', 'utf8'))).jobs
  .close.steps

async function runScript(script: unknown, bindings: Record<string, unknown>): Promise<void> {
  const source = z.string().parse(script)
  assert.doesNotMatch(source, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${source}\n})()`, bindings)
  await execution
}

async function execute(name: string, bindings: Record<string, unknown>): Promise<void> {
  await runScript(steps.find((candidate) => candidate.name === name)?.with?.['script'], bindings)
}

// A full object id: the discovery step refuses anything else before deriving refs.
const SHA = 'abc123abc123abc123abc123abc123abc123abc1'
const COMPARE_BRANCH = 'screenshot-compare/pr-123/abc123abc123'
const COMPARE_URL = `https://github.com/copse-dev/agent-pane/compare/${SHA}...${COMPARE_BRANCH}`
const COMPARE_COMMIT = 'def456def456def456def456def456def456def4'
const RAW = 'https://github.com/copse-dev/agent-pane/raw'

function candidateNames(entries: { name: string; new: boolean }[]): string {
  return JSON.stringify(entries)
}

interface Parent {
  state: string
  labels: { name: string }[]
  head: { ref: string; sha: string; repo: { full_name: string } }
}

function parent(
  overrides: { labels?: string[]; sha?: string; state?: string; repo?: string; ref?: string } = {},
): Parent {
  return {
    state: overrides.state ?? 'open',
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    head: {
      ref: overrides.ref ?? 'codex/feature',
      sha: overrides.sha ?? SHA,
      repo: { full_name: overrides.repo ?? 'copse-dev/agent-pane' },
    },
  }
}

const core = { notice: (): void => {}, setFailed: assert.fail }
const context = {
  repo: { owner: 'copse-dev', repo: 'agent-pane' },
  payload: { workflow_run: { pull_requests: [{ number: 123 }] } },
}

interface PrFile {
  filename: string
  status: string
}

async function discover(
  liveParent = parent(),
  artifacts = [{ id: 42, name: 'reference-screenshot-candidates-99', expired: false }],
  runHeadSha = SHA,
  setFailed: (message: string) => void = assert.fail,
  files: PrFile[] | Error = [],
): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  const listWorkflowRunArtifacts = (): void => {}
  const listFiles = (): void => {}
  await execute('Resolve the live parent PR and exact artifact', {
    context,
    process: { env: { RUN_ID: '99', RUN_HEAD_SHA: runHeadSha } },
    core: {
      ...core,
      setFailed,
      setOutput: (key: string, value: string) => outputs.set(key, value),
    },
    github: {
      rest: {
        pulls: { get: async () => ({ data: liveParent }), listFiles },
        actions: { listWorkflowRunArtifacts },
      },
      paginate: async (method: unknown) => {
        if (method === listWorkflowRunArtifacts) return artifacts
        assert.equal(method, listFiles)
        if (files instanceof Error) throw files
        return files
      },
    },
  })
  return outputs
}

describe('screenshot publication', () => {
  it('publishes evidence for an ordinary run without any review-PR outputs', async () => {
    const outputs = await discover()
    assert.equal(outputs.get('eligible'), 'true')
    assert.equal(outputs.get('has-artifact'), 'true')
    assert.equal(outputs.get('artifact-id'), '42')
    assert.equal(outputs.get('compare-branch'), COMPARE_BRANCH)
    assert.deepEqual(
      [...outputs.keys()].filter((key) => /review/.test(key)),
      [],
    )
  })

  it('names the reference PNGs and e2e specs the PR changes for the preview order', async () => {
    const outputs = await discover(parent(), undefined, SHA, assert.fail, [
      { filename: 'tests/e2e/screenshots/touched.png', status: 'modified' },
      { filename: 'tests/e2e/screenshots/added.png', status: 'added' },
      { filename: 'tests/e2e/screenshots/gone.png', status: 'removed' },
      { filename: 'tests/e2e/screenshots/nested/deep.png', status: 'modified' },
      { filename: 'tests/e2e/settings-styling.e2e.ts', status: 'modified' },
      { filename: 'tests/e2e/browser/pane.e2e.ts', status: 'added' },
      { filename: 'tests/e2e/../../etc/passwd.e2e.ts', status: 'modified' },
      { filename: 'tests/e2e/helpers/screenshot.ts', status: 'modified' },
      { filename: 'src/renderer/styles/brand.css', status: 'modified' },
    ])
    assert.equal(outputs.get('focus-screenshots'), 'touched.png\nadded.png')
    assert.equal(
      outputs.get('focus-specs'),
      'tests/e2e/settings-styling.e2e.ts\ntests/e2e/browser/pane.e2e.ts',
    )
  })

  it('still publishes, in name order, when the PR file listing fails', async () => {
    const outputs = await discover(parent(), undefined, SHA, assert.fail, new Error('boom'))
    assert.equal(outputs.get('has-artifact'), 'true')
    assert.equal(outputs.get('focus-screenshots'), '')
    assert.equal(outputs.get('focus-specs'), '')
  })

  it('treats a labelled refresh like any other run with candidates', async () => {
    const outputs = await discover(parent({ labels: ['update-screenshots'] }))
    assert.deepEqual(outputs, await discover())
  })

  it('refuses to derive bot refs from anything but a full hex head SHA', async () => {
    for (const runHeadSha of ['', 'abc123', `${SHA.slice(0, 39)}/`, SHA.toUpperCase()]) {
      const failures: string[] = []
      const outputs = await discover(
        parent({ sha: runHeadSha }),
        undefined,
        runHeadSha,
        (message) => {
          failures.push(message)
        },
      )
      assert.equal(failures.length, 1, runHeadSha)
      assert.equal(outputs.get('eligible'), 'false')
      assert.equal(outputs.has('compare-branch'), false)
    }
  })

  it('publishes nothing without an unexpired artifact', async () => {
    for (const artifacts of [
      [],
      [{ id: 42, name: 'reference-screenshot-candidates-99', expired: true }],
    ]) {
      const outputs = await discover(parent({ labels: ['update-screenshots'] }), artifacts)
      assert.equal(outputs.get('eligible'), 'true')
      assert.equal(outputs.get('has-artifact'), 'false')
    }
  })

  it('does not publish evidence for stale, closed, external, or integration parents', async () => {
    for (const overrides of [
      { sha: 'new-tip' },
      { state: 'closed' },
      { repo: 'fork/agent-pane' },
      { ref: 'main' },
      { ref: 'release' },
    ]) {
      const outputs = await discover(parent({ ...overrides, labels: ['update-screenshots'] }))
      assert.equal(outputs.get('eligible'), 'false')
      assert.equal(outputs.get('has-artifact'), 'false')
    }
  })

  it('never opens a PR or mints an App token', () => {
    assert.doesNotMatch(
      JSON.stringify(steps),
      /create-pull-request|create-github-app-token|app-token|secrets\.|pulls\.create\b/,
    )
  })

  it('gates artifact handling on the artifact and every API step on eligibility', () => {
    const artifactSteps = steps.filter(
      (step) =>
        ['candidates', 'compare'].includes(step.id ?? '') ||
        ['actions/checkout@v7.0.1', 'actions/download-artifact@v8'].includes(step.uses ?? ''),
    )
    assert.equal(artifactSteps.length, 4)
    for (const step of artifactSteps)
      assert.equal(step.if, "steps.discover.outputs.has-artifact == 'true'")
    for (const name of [
      'Close legacy screenshot review PRs',
      'Delete superseded screenshot compare branches',
      'Link screenshot evidence from the parent',
    ]) {
      const step = steps.find((candidate) => candidate.name === name)
      assert.ok(step)
      assert.equal(step.if, "steps.discover.outputs.eligible == 'true'")
      assert.equal(step.with?.['github-token'], undefined)
    }
  })

  it('pushes the compare branch with the job token after validation, without blocking publication', () => {
    const index = (predicate: (step: (typeof steps)[number]) => boolean): number =>
      steps.findIndex(predicate)
    const compare = steps[index((step) => step.id === 'compare')]
    assert.ok(compare)
    assert.ok(index((step) => step.id === 'candidates') < index((step) => step.id === 'compare'))
    assert.equal(compare['continue-on-error'], true)
    assert.equal(compare.env?.['PUSH_TOKEN'], '${{ github.token }}')
    assert.match(compare.run ?? '', /git commit-tree "\$tree" -p HEAD/)
    assert.match(compare.run ?? '', /"\$commit:refs\/heads\/\$COMPARE_BRANCH"/)
    assert.doesNotMatch(compare.run ?? '', /git (?:config|commit |checkout|remote)/)
    assert.doesNotMatch(compare.run ?? '', /\$\{\{/)
    const checkout = steps.find((step) => step.uses === 'actions/checkout@v7.0.1')
    assert.ok(checkout?.with)
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(checkout.with['fetch-depth'], 1, 'nothing needs the full PNG history')
  })
})

async function closeLegacyReviews(
  liveParent = parent(),
): Promise<{ closed: number[]; deleted: string[] }> {
  const closed: number[] = []
  const deleted: string[] = []
  const list = (): void => {}
  const repo = { full_name: 'copse-dev/agent-pane' }
  await execute('Close legacy screenshot review PRs', {
    context,
    core: { ...core, info: () => {} },
    process: { env: { PARENT_NUMBER: '123', EXPECTED_HEAD_SHA: SHA } },
    github: {
      rest: {
        pulls: {
          get: async () => ({ data: liveParent }),
          list,
          update: async ({ pull_number }: { pull_number: number }) => {
            closed.push(pull_number)
          },
        },
        git: {
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
            if (ref.endsWith('gone')) throw new Error('Reference does not exist')
          },
        },
      },
      paginate: async (method: unknown) => {
        assert.equal(method, list)
        return [
          { number: 455, head: { ref: 'screenshots/pr-123/gone', repo } },
          { number: 456, head: { ref: 'screenshots/pr-123/abc123abc123', repo } },
          { number: 457, head: { ref: 'screenshots/pr-123/abc', repo: { full_name: 'fork/x' } } },
          { number: 789, head: { ref: 'screenshots/pr-1234/abc123abc123', repo } },
          { number: 790, head: { ref: COMPARE_BRANCH, repo } },
        ]
      },
    },
  })
  return { closed, deleted }
}

describe('legacy screenshot review PR cleanup', () => {
  it('closes every open legacy review PR for a live parent and deletes its branch', async () => {
    assert.deepEqual(await closeLegacyReviews(), {
      closed: [455, 456],
      deleted: ['heads/screenshots/pr-123/gone', 'heads/screenshots/pr-123/abc123abc123'],
    })
  })

  it('does nothing when the parent moved or closed', async () => {
    for (const liveParent of [parent({ sha: 'new-tip' }), parent({ state: 'closed' })])
      assert.deepEqual(await closeLegacyReviews(liveParent), { closed: [], deleted: [] })
  })
})

async function cleanUpCompareBranches(
  env: Record<string, string> = {},
  liveParent = parent(),
  refs = [
    `refs/heads/${COMPARE_BRANCH}`,
    'refs/heads/screenshot-compare/pr-123/000000000000',
    'refs/heads/screenshot-compare/pr-123/111111111111',
  ],
): Promise<{ deleted: string[]; listed: string[]; failures: string[] }> {
  const deleted: string[] = []
  const listed: string[] = []
  const failures: string[] = []
  const listMatchingRefs = (): void => {}
  await execute('Delete superseded screenshot compare branches', {
    context,
    core: {
      ...core,
      info: () => {},
      setFailed: (message: string) => {
        failures.push(message)
      },
    },
    process: {
      env: {
        PARENT_NUMBER: '123',
        EXPECTED_HEAD_SHA: SHA,
        COMPARE_BRANCH,
        COMPARE_PUSHED: 'true',
        ...env,
      },
    },
    github: {
      rest: {
        pulls: { get: async () => ({ data: liveParent }) },
        git: {
          listMatchingRefs,
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
            // A concurrent deletion must not stop the rest of the cleanup.
            if (ref.endsWith('000000000000')) throw new Error('Reference does not exist')
          },
        },
      },
      paginate: async (method: unknown, params: { ref: string }) => {
        assert.equal(method, listMatchingRefs)
        listed.push(params.ref)
        return refs.map((ref) => ({ ref }))
      },
    },
  })
  return { deleted, listed, failures }
}

describe('screenshot compare branch cleanup', () => {
  it('deletes only superseded branches for the same parent while it is live at the expected head', async () => {
    const result = await cleanUpCompareBranches(undefined, undefined, [
      `refs/heads/${COMPARE_BRANCH}`,
      'refs/heads/screenshot-compare/pr-123/000000000000',
      'refs/heads/screenshot-compare/pr-123/111111111111',
      'refs/heads/screenshot-compare/pr-1234/222222222222',
      'refs/heads/screenshots/pr-123/333333333333',
    ])
    assert.deepEqual(result, {
      listed: ['heads/screenshot-compare/pr-123/'],
      deleted: [
        'heads/screenshot-compare/pr-123/000000000000',
        'heads/screenshot-compare/pr-123/111111111111',
      ],
      failures: [],
    })
  })

  it('keeps the same-head branch even when this run pushed nothing new', async () => {
    const { deleted } = await cleanUpCompareBranches({ COMPARE_PUSHED: '' })
    assert.equal(deleted.includes(`heads/${COMPARE_BRANCH}`), false)
    assert.equal(deleted.length, 2)
  })

  it('deletes only the just-pushed branch when the parent moved or closed', async () => {
    for (const liveParent of [parent({ sha: 'new-tip' }), parent({ state: 'closed' })]) {
      const result = await cleanUpCompareBranches(undefined, liveParent)
      assert.deepEqual(result, { deleted: [`heads/${COMPARE_BRANCH}`], listed: [], failures: [] })
    }
    const unpushed = await cleanUpCompareBranches(
      { COMPARE_PUSHED: '' },
      parent({ sha: 'new-tip' }),
    )
    assert.deepEqual(unpushed, { deleted: [], listed: [], failures: [] })
  })

  it('refuses a compare branch outside the parent prefix', async () => {
    for (const env of [
      { COMPARE_BRANCH: 'screenshot-compare/pr-1234/abc123abc123' },
      { COMPARE_BRANCH: 'main' },
      { PARENT_NUMBER: 'abc' },
    ]) {
      const result = await cleanUpCompareBranches(env)
      assert.deepEqual(result.deleted, [])
      assert.equal(result.failures.length, 1)
    }
  })
})

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex')

function writeFile(root: string, relative: string, content: string | Buffer): void {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// Runs the real candidate step in a throwaway repository standing in for the
// shallow head checkout.
function applyCandidates(env: { FOCUS_SCREENSHOTS: string; FOCUS_SPECS: string }): string {
  const script = z
    .string()
    .parse(steps.find((step) => step.name === 'Validate and apply candidate PNGs')?.run)
  assert.doesNotMatch(script, /\$\{\{/)
  const root = mkdtempSync(join(tmpdir(), 'screenshot-candidates-'))
  try {
    const checkout = join(root, 'checkout')
    const candidates = join(root, 'candidates')
    const runnerTemp = join(root, 'runner')
    mkdirSync(runnerTemp)
    writeFile(checkout, 'tests/e2e/screenshots/existing.png', PNG)
    writeFile(
      checkout,
      'tests/e2e/pane.e2e.ts',
      "await saveElementScreenshot('.pane', 'spec-named.png')\nconst other = `${name}-dynamic.png`\n",
    )
    writeFile(checkout, 'tests/e2e/unchanged.e2e.ts', "await save('a-drift.png')\n")
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout })
    }
    git('init', '-q')
    git('add', '.')
    git('commit', '-qm', 'head')
    for (const name of ['a-drift.png', 'existing.png', 'spec-named.png', 'z-touched.png']) {
      writeFile(
        candidates,
        `tests/e2e/screenshots/${name}`,
        Buffer.concat([PNG, Buffer.from(name)]),
      )
    }
    const output = join(runnerTemp, 'output')
    execFileSync('bash', ['-e', '-c', script], {
      cwd: checkout,
      env: {
        PATH: process.env['PATH'],
        CANDIDATE_ROOT: candidates,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: output,
        ...env,
      },
    })
    return readFileSync(output, 'utf8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('screenshot candidate validation', () => {
  it('lists screenshots the PR touches first, each group in name order', () => {
    const output = applyCandidates({
      FOCUS_SCREENSHOTS: 'z-touched.png\n../escape.png',
      FOCUS_SPECS: 'tests/e2e/pane.e2e.ts\ntests/e2e/../../etc/passwd.e2e.ts',
    })
    assert.match(output, /^count=4$/m)
    const names = /^names=(.*)$/m.exec(output)?.[1] ?? ''
    assert.deepEqual(JSON.parse(names), [
      { name: 'spec-named.png', new: true, focus: true },
      { name: 'z-touched.png', new: true, focus: true },
      { name: 'a-drift.png', new: true, focus: false },
      { name: 'existing.png', new: false, focus: false },
    ])
  })

  it('keeps plain name order when the PR touches no screenshots', () => {
    const output = applyCandidates({ FOCUS_SCREENSHOTS: '', FOCUS_SPECS: '' })
    const names = /^names=(.*)$/m.exec(output)?.[1] ?? ''
    assert.deepEqual(
      z.array(z.object({ name: z.string(), focus: z.boolean() })).parse(JSON.parse(names)),
      ['a-drift.png', 'existing.png', 'spec-named.png', 'z-touched.png'].map((name) => ({
        name,
        focus: false,
      })),
    )
  })
})

async function publish(
  env: Record<string, string> = {},
  liveParent = parent(),
  previous = false,
): Promise<{ bodies: string[]; deleted: string[] }> {
  const bodies: string[] = []
  const deleted: string[] = []
  const recordBody = async ({ body }: { body: string }): Promise<void> => {
    bodies.push(body)
  }
  await execute('Link screenshot evidence from the parent', {
    context,
    core,
    process: {
      env: {
        PARENT_NUMBER: '123',
        EXPECTED_HEAD_SHA: SHA,
        ARTIFACT_ID: '42',
        COMPARE_BRANCH,
        COMPARE_PUSHED: 'true',
        COMPARE_COMMIT,
        CANDIDATE_NAMES: candidateNames([
          { name: 'b-new.png', new: true },
          { name: 'a-changed.png', new: false },
        ]),
        CANDIDATE_COUNT: '2',
        RUN_ID: '99',
        RUN_URL: 'https://github.com/copse-dev/agent-pane/actions/runs/99',
        ...env,
      },
    },
    github: {
      rest: {
        pulls: { get: async () => ({ data: liveParent }) },
        git: {
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
          },
        },
        issues: { listComments: () => {}, updateComment: recordBody, createComment: recordBody },
      },
      paginate: async () =>
        previous
          ? [{ id: 7, user: { type: 'Bot' }, body: '<!-- copse-e2e-screenshot-review -->' }]
          : [],
    },
  })
  return { bodies, deleted }
}

describe('parent screenshot evidence comment', () => {
  it('links the compare view first, keeps the artifact, and gives the exact cherry-pick command', async () => {
    const { bodies } = await publish()
    assert.equal(bodies.length, 1)
    const body = bodies[0] ?? ''
    assert.ok(body.includes(`](${COMPARE_URL})`), body)
    assert.ok(body.indexOf(COMPARE_URL) < body.indexOf('actions/runs/99/artifacts/42'))
    assert.match(body, /for viewing only/)
    assert.ok(
      body.includes(
        '```sh\n' +
          `git fetch origin ${COMPARE_BRANCH} && git cherry-pick ${COMPARE_COMMIT}\n` +
          '```',
      ),
      body,
    )
    assert.ok(body.includes(`git checkout ${COMPARE_COMMIT} -- tests/e2e/screenshots/<name>.png`))
    assert.match(body, /actions\/runs\/99\/artifacts\/42/)
    assert.match(body, /abc123abc123/)
    assert.match(body, /14 days/)
    assert.match(body, /add `update-screenshots`, then remove it after that run/)
    assert.match(body, /Do not refresh references merely to absorb unrelated rendering drift/)
    assert.doesNotMatch(body, /review PR|screenshot PR|PNG review|merge (?:it|this)/i)
  })

  it('tells a labelled refresh to drop the label now that the full set is rendered', async () => {
    const body = (await publish({}, parent({ labels: ['update-screenshots'] }))).bodies[0] ?? ''
    assert.match(body, /rendered every reference because `update-screenshots` is set/)
    assert.match(body, /Remove the label now to avoid repeating full runs/)
    assert.ok(body.includes(`git cherry-pick ${COMPARE_COMMIT}`))
    assert.doesNotMatch(body, /review PR|screenshot PR/i)
  })

  it('previews before and after images pinned to immutable commits', async () => {
    const body = (await publish()).bodies[0] ?? ''
    const rows = body.split('\n').filter((line) => line.startsWith('| '))
    assert.deepEqual(rows, [
      '| Screenshot | Before | After |',
      '| --- | --- | --- |',
      `| \`a-changed.png\` | <img src="${RAW}/${SHA}/tests/e2e/screenshots/a-changed.png" width="360"> | ` +
        `<img src="${RAW}/${COMPARE_COMMIT}/tests/e2e/screenshots/a-changed.png" width="360"> |`,
      `| \`b-new.png\` | *new* | ` +
        `<img src="${RAW}/${COMPARE_COMMIT}/tests/e2e/screenshots/b-new.png" width="360"> |`,
    ])
    assert.doesNotMatch(
      body,
      /\/raw\/screenshot-compare/,
      'raw URLs must never name the mutable branch',
    )
    assert.doesNotMatch(body, /and \d+ more/)
    assert.ok(body.indexOf('| Screenshot |') < body.indexOf('actions/runs/99/artifacts/42'))
  })

  it('caps the preview at 20 sorted rows and points the rest at the compare view', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      name: `shot-${String(24 - index).padStart(2, '0')}.png`,
      new: index % 2 === 0,
    }))
    const body =
      (await publish({ CANDIDATE_NAMES: candidateNames(entries), CANDIDATE_COUNT: '60' }))
        .bodies[0] ?? ''
    const names = body
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => /^\| `([^`]+)`/.exec(line)?.[1])
    assert.deepEqual(
      names,
      Array.from({ length: 20 }, (_, index) => `shot-${String(index).padStart(2, '0')}.png`),
    )
    assert.ok(body.includes(`…and 40 more — see [the compare view](${COMPARE_URL}).`), body)
  })

  it('leads with screenshots the PR touches, even past the 20-row cap', async () => {
    const drift = Array.from({ length: 30 }, (_, index) => ({
      name: `a-drift-${String(index).padStart(2, '0')}.png`,
      new: false,
      focus: false,
    }))
    const touched = [
      { name: 'z-touched.png', new: false, focus: true },
      { name: 'y-touched.png', new: true, focus: true },
    ]
    const body =
      (
        await publish({
          CANDIDATE_NAMES: JSON.stringify([...drift, ...touched]),
          CANDIDATE_COUNT: '32',
        })
      ).bodies[0] ?? ''
    const names = body
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => /^\| `([^`]+)`/.exec(line)?.[1])
    assert.deepEqual(names, [
      'y-touched.png',
      'z-touched.png',
      ...drift.slice(0, 18).map((entry) => entry.name),
    ])
    const touchedHeading = body.indexOf('**Screenshots this PR touches**')
    const otherHeading = body.indexOf('**Other changed screenshots**')
    assert.ok(touchedHeading > 0 && touchedHeading < body.indexOf('y-touched.png'), body)
    assert.ok(body.indexOf('z-touched.png') < otherHeading, body)
    assert.ok(otherHeading < body.indexOf('a-drift-00.png'), body)
    assert.ok(body.includes('…and 12 more'), body)
  })

  it('omits the other-screenshots heading when every preview is touched by the PR', async () => {
    const body =
      (
        await publish({
          CANDIDATE_NAMES: JSON.stringify([{ name: 'touched.png', new: false, focus: true }]),
          CANDIDATE_COUNT: '1',
        })
      ).bodies[0] ?? ''
    assert.ok(body.includes('**Screenshots this PR touches**'), body)
    assert.doesNotMatch(body, /Other changed screenshots/)
  })

  it('keeps a single untitled table when nothing is linked to the PR', async () => {
    const body = (await publish()).bodies[0] ?? ''
    assert.doesNotMatch(body, /Screenshots this PR touches|Other changed screenshots/)
  })

  it('keeps the comment far below GitHub’s size limit with the longest allowed names', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      name: `${String(index).padStart(2, '0')}${'x'.repeat(240)}.png`,
      new: false,
    }))
    for (const labels of [[], ['update-screenshots']]) {
      const body =
        (
          await publish(
            { CANDIDATE_NAMES: candidateNames(entries), CANDIDATE_COUNT: '2048' },
            parent({ labels }),
          )
        ).bodies[0] ?? ''
      assert.equal(body.split('\n').filter((line) => line.startsWith('| `')).length, 20)
      assert.ok(body.includes('…and 2028 more'))
      assert.ok(body.length < 32_768, String(body.length))
    }
  })

  it('omits the preview rather than render unvalidated names or a mutable after-ref', async () => {
    for (const env of [
      { CANDIDATE_NAMES: candidateNames([{ name: '<script>.png', new: false }]) },
      {
        CANDIDATE_NAMES: candidateNames([
          { name: 'a.png', new: false },
          { name: '../x.png', new: true },
        ]),
      },
      { CANDIDATE_NAMES: '[{"name":"a.png","new":"yes"}]' },
      { CANDIDATE_NAMES: '[{"name":"a.png","new":false,"focus":"yes"}]' },
      { CANDIDATE_NAMES: 'not json' },
      { CANDIDATE_NAMES: '' },
    ]) {
      const body = (await publish(env)).bodies[0] ?? ''
      assert.doesNotMatch(body, /\| Screenshot \||<img/, JSON.stringify(env))
      assert.ok(body.includes(COMPARE_URL))
    }
  })

  it('never offers a cherry-pick or preview without an immutable compare commit', async () => {
    for (const env of [{ COMPARE_COMMIT: COMPARE_BRANCH }, { COMPARE_COMMIT: '' }]) {
      const body = (await publish(env)).bodies[0] ?? ''
      assert.doesNotMatch(body, /\| Screenshot \||<img|cherry-pick|compare\//, JSON.stringify(env))
      assert.match(body, /download the artifact and commit the intended PNGs/)
    }
  })

  it('passes candidate names to the comment through env, never the script text', () => {
    const step = steps.find(
      (candidate) => candidate.name === 'Link screenshot evidence from the parent',
    )
    assert.ok(step?.env)
    assert.equal(step.env['CANDIDATE_NAMES'], '${{ steps.candidates.outputs.names }}')
    assert.equal(step.env['CANDIDATE_COUNT'], '${{ steps.candidates.outputs.count }}')
    assert.equal(step.env['COMPARE_COMMIT'], '${{ steps.compare.outputs.commit }}')
    assert.doesNotMatch(z.string().parse(step.with?.['script']), /\$\{\{/)
  })

  it('falls back to the artifact alone when no compare branch was pushed', async () => {
    const { bodies } = await publish({ COMPARE_PUSHED: '' })
    assert.match(bodies[0] ?? '', /Changed reference candidates for `abc123abc123` are in/)
    assert.match(bodies[0] ?? '', /actions\/runs\/99\/artifacts\/42/)
    assert.doesNotMatch(bodies[0] ?? '', /compare\/|cherry-pick|<img/)
    assert.match(bodies[0] ?? '', /download the artifact and commit the intended PNGs/)
  })

  it('deletes the just-pushed compare branch and posts no stale link when the parent advances', async () => {
    const result = await publish({}, parent({ sha: 'new-tip' }), true)
    assert.deepEqual(result, { bodies: [], deleted: [`heads/${COMPARE_BRANCH}`] })
    const unpushed = await publish({ COMPARE_PUSHED: '' }, parent({ state: 'closed' }), true)
    assert.deepEqual(unpushed, { bodies: [], deleted: [] })
  })

  it('does not add no-change comments, but replaces an older evidence comment', async () => {
    assert.deepEqual((await publish({ ARTIFACT_ID: '' })).bodies, [])
    const { bodies } = await publish({ ARTIFACT_ID: '' }, parent(), true)
    assert.match(bodies[0] ?? '', /no filtered screenshot candidates/)
  })
})

async function closeParent(
  pulls: { number: number; head: { ref: string; repo: { full_name: string } } }[],
  refs: string[],
): Promise<{ closed: number[]; deleted: string[]; comments: number[] }> {
  const closed: number[] = []
  const deleted: string[] = []
  const comments: number[] = []
  const list = (): void => {}
  const listMatchingRefs = (): void => {}
  const script = closeSteps.find((step) => step.uses === 'actions/github-script@v9')?.with?.[
    'script'
  ]
  await runScript(script, {
    context,
    core: { ...core, info: () => {} },
    process: { env: { PARENT_NUMBER: '123' } },
    github: {
      rest: {
        pulls: {
          list,
          update: async ({ pull_number }: { pull_number: number }) => {
            closed.push(pull_number)
          },
        },
        issues: {
          createComment: async ({ issue_number }: { issue_number: number }) => {
            comments.push(issue_number)
          },
        },
        git: {
          listMatchingRefs,
          deleteRef: async ({ ref }: { ref: string }) => {
            deleted.push(ref)
            if (ref.endsWith('000000000000')) throw new Error('Reference does not exist')
          },
        },
      },
      paginate: async (method: unknown, params: { ref?: string }) => {
        if (method === listMatchingRefs) {
          assert.equal(params.ref, 'heads/screenshot-compare/pr-123/')
          return refs.map((ref) => ({ ref }))
        }
        assert.equal(method, list)
        return pulls
      },
    },
  })
  return { closed, deleted, comments }
}

describe('closing a screenshot parent', () => {
  const repo = { full_name: 'copse-dev/agent-pane' }

  it('deletes every compare branch for the parent even when no review PR is open', async () => {
    const result = await closeParent(
      [{ number: 789, head: { ref: 'screenshots/pr-789/abc123abc123', repo } }],
      [
        'refs/heads/screenshot-compare/pr-123/000000000000',
        'refs/heads/screenshot-compare/pr-123/abc123abc123',
        'refs/heads/screenshot-compare/pr-1234/abc123abc123',
      ],
    )
    assert.deepEqual(result, {
      closed: [],
      comments: [],
      deleted: [
        'heads/screenshot-compare/pr-123/000000000000',
        'heads/screenshot-compare/pr-123/abc123abc123',
      ],
    })
  })

  it('still closes orphaned review PRs and deletes their branches', async () => {
    const result = await closeParent(
      [
        { number: 456, head: { ref: 'screenshots/pr-123/abc123abc123', repo } },
        {
          number: 457,
          head: { ref: 'screenshots/pr-123/abc123abc123', repo: { full_name: 'fork/agent-pane' } },
        },
      ],
      ['refs/heads/screenshot-compare/pr-123/abc123abc123'],
    )
    assert.deepEqual(result, {
      closed: [456],
      comments: [456],
      deleted: [
        'heads/screenshot-compare/pr-123/abc123abc123',
        'heads/screenshots/pr-123/abc123abc123',
      ],
    })
  })
})
