import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'
import { SCREENSHOT_MANIFEST, serializeScreenshotManifest } from './lib/screenshot-manifest.mts'
import {
  decideRefresh,
  isRefreshCommit,
  SCREENSHOT_REFRESH_BRANCH,
  SCREENSHOT_REFRESH_SUBJECT,
  type MainChanges,
  type RefreshPull,
} from './screenshot-refresh.mts'

const MAIN = 'a'.repeat(40)
const RENDERED = 'b'.repeat(40)

function pull(overrides: Partial<RefreshPull> = {}): RefreshPull {
  return { number: 7, open: true, renderedMain: RENDERED, ownHead: true, ...overrides }
}

/** A `changes` callback that records whether the decision needed it. */
function changes(result: MainChanges): {
  calls: string[]
  changes: (since: string) => MainChanges
} {
  const calls: string[] = []
  return {
    calls,
    changes: (since: string): MainChanges => {
      calls.push(since)
      return result
    },
  }
}

describe('screenshot refresh decision', () => {
  it('never moves an open PR that carries anything but its own refresh commit, even when forced', () => {
    for (const force of [false, true]) {
      const probe = changes({ manifest: true, e2e: 'full' })
      const decision = decideRefresh({
        main: MAIN,
        pull: pull({ ownHead: false }),
        force,
        changes: probe.changes,
      })
      assert.equal(decision.refresh, false)
      assert.match(decision.reason, /#7 carries a commit besides the refresh commit/)
      assert.match(decision.reason, /merge or close it/)
      assert.deepEqual(probe.calls, [])
    }
  })

  it('refreshes on a forced dispatch without consulting the oracle', () => {
    const probe = changes({ manifest: false, e2e: 'skip' })
    const decision = decideRefresh({
      main: MAIN,
      pull: pull({ renderedMain: MAIN }),
      force: true,
      changes: probe.changes,
    })
    assert.deepEqual(decision, { refresh: true, reason: 'forced by workflow_dispatch' })
    assert.deepEqual(probe.calls, [])
  })

  it('opens the first refresh PR, and refreshes when the rendered main is unknown', () => {
    const probe = changes({ manifest: false, e2e: 'skip' })
    assert.equal(
      decideRefresh({ main: MAIN, pull: null, force: false, changes: probe.changes }).refresh,
      true,
    )
    assert.equal(
      decideRefresh({
        main: MAIN,
        pull: pull({ renderedMain: null }),
        force: false,
        changes: probe.changes,
      }).refresh,
      true,
    )
    assert.deepEqual(probe.calls, [])
  })

  it('skips a night when main has not moved since the newest refresh PR, open or closed', () => {
    for (const open of [true, false]) {
      const probe = changes({ manifest: true, e2e: 'full' })
      const decision = decideRefresh({
        main: MAIN,
        pull: pull({ open, renderedMain: MAIN, ownHead: open }),
        force: false,
        changes: probe.changes,
      })
      assert.deepEqual(decision, {
        refresh: false,
        reason: 'main has not moved since #7 rendered it',
      })
      assert.deepEqual(probe.calls, [])
    }
  })

  it('refreshes when main changed committed hashes, so stale candidates leave the evidence', () => {
    const probe = changes({ manifest: true, e2e: 'skip' })
    const decision = decideRefresh({
      main: MAIN,
      pull: pull(),
      force: false,
      changes: probe.changes,
    })
    assert.equal(decision.refresh, true)
    assert.match(
      decision.reason,
      /changed committed screenshot hashes since #7 rendered bbbbbbbbbbbb/,
    )
    assert.deepEqual(probe.calls, [RENDERED])
  })

  it('skips a night when nothing main changed reaches an e2e render', () => {
    const decision = decideRefresh({
      main: MAIN,
      pull: pull(),
      force: false,
      changes: changes({ manifest: false, e2e: 'skip' }).changes,
    })
    assert.equal(decision.refresh, false)
    assert.match(decision.reason, /reaches an e2e render \(oracle: skip\)/)
  })

  it('refreshes when the oracle maps main’s changes to any spec', () => {
    for (const e2e of ['subset', 'full'] as const) {
      const decision = decideRefresh({
        main: MAIN,
        pull: pull(),
        force: false,
        changes: changes({ manifest: false, e2e }).changes,
      })
      assert.equal(decision.refresh, true)
      assert.ok(decision.reason.endsWith(`(oracle: ${e2e})`), decision.reason)
    }
  })

  it('moves the branch from under a merged or closed PR, whatever its head holds', () => {
    const decision = decideRefresh({
      main: MAIN,
      pull: pull({ open: false, ownHead: false }),
      force: false,
      changes: changes({ manifest: true, e2e: 'subset' }).changes,
    })
    assert.equal(decision.refresh, true)
  })
})

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim()
}

function manifest(hash: string): string {
  return serializeScreenshotManifest({
    version: 1,
    screenshots: { 'shot.png': { sha256: hash.repeat(64), bytes: 1 } },
  })
}

/** A repository whose `main` holds a manifest and a doc, with one refresh commit on it. */
function repository(): { dir: string; base: string; refresh: string } {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-refresh-'))
  gitIn(dir, 'init', '--quiet', '--initial-branch=main')
  mkdirSync(join(dir, 'tests/e2e/screenshots'), { recursive: true })
  writeFileSync(join(dir, SCREENSHOT_MANIFEST), manifest('a'))
  writeFileSync(join(dir, 'README.md'), 'readme\n')
  gitIn(dir, 'add', '.')
  gitIn(dir, 'commit', '--quiet', '-m', 'base')
  const base = gitIn(dir, 'rev-parse', 'HEAD')
  gitIn(dir, 'commit', '--quiet', '--allow-empty', '-m', SCREENSHOT_REFRESH_SUBJECT)
  const refresh = gitIn(dir, 'rev-parse', 'HEAD')
  gitIn(dir, 'reset', '--quiet', '--hard', base)
  return { dir, base, refresh }
}

describe('screenshot refresh commit recognition', () => {
  it('recognises only an empty single-parent commit with the refresh subject', () => {
    const { dir, base, refresh } = repository()
    try {
      assert.equal(isRefreshCommit(refresh, dir), true)
      assert.equal(isRefreshCommit(base, dir), false, 'a root commit has no parent tree')

      gitIn(dir, 'commit', '--quiet', '--allow-empty', '-m', 'chore: something else')
      assert.equal(isRefreshCommit(gitIn(dir, 'rev-parse', 'HEAD'), dir), false)

      writeFileSync(join(dir, SCREENSHOT_MANIFEST), manifest('c'))
      gitIn(dir, 'commit', '--quiet', '-am', SCREENSHOT_REFRESH_SUBJECT)
      assert.equal(
        isRefreshCommit(gitIn(dir, 'rev-parse', 'HEAD'), dir),
        false,
        'committed screenshots are a decision, not the refresh commit',
      )

      gitIn(dir, 'checkout', '--quiet', '-b', 'side', base)
      gitIn(dir, 'commit', '--quiet', '--allow-empty', '-m', 'side')
      gitIn(dir, 'checkout', '--quiet', 'main')
      gitIn(dir, 'merge', '--quiet', '--no-ff', '-m', SCREENSHOT_REFRESH_SUBJECT, 'side')
      assert.equal(isRefreshCommit(gitIn(dir, 'rev-parse', 'HEAD'), dir), false)
      assert.equal(isRefreshCommit('0'.repeat(40), dir), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Run the real CLI in `dir`, returning its outputs and summary. */
function plan(
  dir: string,
  env: Record<string, string>,
): { status: number | null; outputs: string; summary: string; stderr: string } {
  const outputs = join(dir, '.github-output')
  const summary = join(dir, '.github-summary')
  writeFileSync(outputs, '')
  writeFileSync(summary, '')
  // Keep the run files out of the oracle's untracked-file scan.
  writeFileSync(join(dir, '.git/info/exclude'), '.github-*\n')
  const result = spawnSync(process.execPath, [resolve('scripts/screenshot-refresh.mts')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAIN_SHA: gitIn(dir, 'rev-parse', 'HEAD'),
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  })
  return {
    status: result.status,
    outputs: readFileSync(outputs, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    stderr: result.stderr,
  }
}

describe('screenshot refresh plan CLI', () => {
  it('reads the refresh PR head from git and emits the decision for the workflow', () => {
    const { dir, base, refresh } = repository()
    try {
      const open = { PULL_NUMBER: '7', PULL_OPEN: 'true', PULL_HEAD: refresh, BRANCH_SHA: refresh }

      const first = plan(dir, { PULL_NUMBER: '' })
      assert.equal(first.status, 0, first.stderr)
      assert.match(first.outputs, /^refresh=true\nreason=no refresh PR has been opened yet\n$/)
      assert.match(first.summary, /Refresh: no refresh PR has been opened yet\./)

      const unchanged = plan(dir, open)
      assert.equal(unchanged.status, 0, unchanged.stderr)
      assert.match(unchanged.outputs, /^refresh=false\nreason=main has not moved since #7/)

      writeFileSync(join(dir, 'README.md'), 'docs only\n')
      gitIn(dir, 'commit', '--quiet', '-am', 'docs')
      const docs = plan(dir, open)
      assert.equal(docs.status, 0, docs.stderr)
      assert.match(docs.outputs, /^refresh=false\n.*\(oracle: skip\)\n$/s)

      writeFileSync(join(dir, SCREENSHOT_MANIFEST), manifest('d'))
      gitIn(dir, 'commit', '--quiet', '-am', 'accept screenshots on main')
      const accepted = plan(dir, open)
      assert.equal(accepted.status, 0, accepted.stderr)
      assert.match(
        accepted.outputs,
        new RegExp(
          `^refresh=true\\nreason=main changed committed screenshot hashes since #7 rendered ${base.slice(0, 12)}\\n$`,
        ),
      )

      const forced = plan(dir, { ...open, FORCE: 'true' })
      assert.match(forced.outputs, /^refresh=true\nreason=forced by workflow_dispatch\n$/)

      gitIn(dir, 'checkout', '--quiet', '-b', 'reviewed', refresh)
      writeFileSync(join(dir, SCREENSHOT_MANIFEST), manifest('e'))
      gitIn(dir, 'commit', '--quiet', '-am', 'chore(e2e): commit ticked screenshots')
      const reviewed = gitIn(dir, 'rev-parse', 'HEAD')
      gitIn(dir, 'checkout', '--quiet', 'main')
      const held = plan(dir, { ...open, PULL_HEAD: reviewed, BRANCH_SHA: reviewed, FORCE: 'true' })
      assert.equal(held.status, 0, held.stderr)
      assert.match(held.outputs, /^refresh=false\nreason=#7 carries a commit besides/)
      // The PR head can lag a push: the tip the push would replace is what counts.
      const lagging = plan(dir, { ...open, BRANCH_SHA: reviewed, FORCE: 'true' })
      assert.equal(lagging.status, 0, lagging.stderr)
      assert.match(lagging.outputs, /^refresh=false\nreason=#7 carries a commit besides/)
      const merged = plan(dir, { ...open, PULL_OPEN: 'false', PULL_HEAD: reviewed })
      assert.match(merged.outputs, /^refresh=true\n/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses inputs that do not name the checked-out main or one PR head', () => {
    const { dir, refresh } = repository()
    try {
      assert.notEqual(plan(dir, { MAIN_SHA: refresh }).status, 0)
      assert.notEqual(plan(dir, { PULL_NUMBER: '7', PULL_HEAD: 'main' }).status, 0)
      assert.notEqual(plan(dir, { BRANCH_SHA: 'main' }).status, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  uses: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
})
const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.string().optional(),
  permissions: z.record(z.string(), z.string()),
  outputs: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
})
const workflowText = readFileSync('.github/workflows/screenshot-refresh.yml', 'utf8')
const workflow = z
  .object({
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
    jobs: z.object({ plan: jobSchema, refresh: jobSchema }),
  })
  .parse(load(workflowText))
const { plan: planJob, refresh: refreshJob } = workflow.jobs

function step(job: z.infer<typeof jobSchema>, name: string): z.infer<typeof stepSchema> {
  const found = job.steps.find((candidate) => candidate.name === name)
  assert.ok(found, `expected the "${name}" step`)
  return found
}

async function runScript(script: unknown, bindings: Record<string, unknown>): Promise<void> {
  const source = z.string().parse(script)
  assert.doesNotMatch(source, /\$\{\{/)
  const execution: unknown = runInNewContext(`(async () => {\n${source}\n})()`, bindings)
  await execution
}

const context = { repo: { owner: 'copse-dev', repo: 'agent-pane' } }

describe('screenshot-refresh.yml workflow invariants', () => {
  it('runs nightly and on dispatch, deciding only from main', () => {
    assert.match(workflowText, /^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '\d+ \d+ \* \* \*'$/m)
    assert.match(
      workflowText,
      /^ {2}workflow_dispatch:\n {4}inputs:\n {6}force:\n(?: {8}.*\n)* {8}type: boolean\n {8}default: false$/m,
    )
    assert.equal(planJob.if, "github.ref == 'refs/heads/main'")
    assert.equal(refreshJob.needs, 'plan')
    assert.equal(refreshJob.if, "needs.plan.outputs.refresh == 'true'")
    assert.deepEqual(workflow.concurrency, {
      group: 'screenshot-refresh',
      'cancel-in-progress': false,
    })
    assert.equal(
      step(planJob, 'Decide whether the refresh can change the evidence').env?.['FORCE'],
      "${{ github.event_name == 'workflow_dispatch' && inputs.force }}",
    )
  })

  it('keeps the App token out of the job that runs repository scripts', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.deepEqual(planJob.permissions, { contents: 'read', 'pull-requests': 'read' })
    assert.deepEqual(refreshJob.permissions, { contents: 'read' })
    const planText = JSON.stringify(planJob)
    assert.doesNotMatch(planText, /secrets\.|create-github-app-token|github-token/)
    assert.ok(planJob.steps.some((candidate) => candidate.uses === './.github/actions/setup'))
    for (const candidate of refreshJob.steps) {
      assert.ok(
        !candidate.uses?.startsWith('actions/checkout') &&
          candidate.uses !== './.github/actions/setup',
        'the token-holding job checks out and runs nothing from the repository',
      )
      assert.doesNotMatch(candidate.run ?? '', /\bnode\b|pnpm|npm /)
    }
    const app = refreshJob.steps.find((candidate) => candidate.id === 'app-token')
    assert.equal(app?.uses, 'actions/create-github-app-token@v3')
    assert.deepEqual(app.with, {
      'app-id': '${{ secrets.RELEASE_APP_ID }}',
      'private-key': '${{ secrets.RELEASE_APP_PRIVATE_KEY }}',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    })
  })

  it('names the branch CI keys on, and the commit subject the plan recognises', () => {
    assert.equal(SCREENSHOT_REFRESH_BRANCH, 'screenshot-refresh/main')
    const branchUses = workflowText.match(/screenshot-refresh\/main/g) ?? []
    assert.ok(branchUses.length >= 4)
    const push = step(refreshJob, 'Move the branch to a new empty commit on main').run ?? ''
    assert.ok(
      push.includes(`-m '${SCREENSHOT_REFRESH_SUBJECT}'`),
      'the plan must recognise the commit',
    )
    assert.ok(
      push.includes('git commit-tree "$MAIN_SHA^{tree}" -p "$MAIN_SHA"'),
      'one empty commit on main',
    )
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
    assert.ok(ci.includes(`github.head_ref == '${SCREENSHOT_REFRESH_BRANCH}'`))
    const publisher = readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8')
    assert.ok(publisher.includes(`parent.head.ref === '${SCREENSHOT_REFRESH_BRANCH}'`))
  })

  it('opens drafts and leaves every review decision and the merge to people', () => {
    assert.match(workflowText, /draft: true,/)
    assert.doesNotMatch(
      workflowText,
      /enablePullRequestAutoMerge|merge_pull_request|pulls\.merge|createCommitStatus|addLabels|markReadyForReview|draft: false/,
    )
    assert.doesNotMatch(
      workflowText,
      /pulls\.update\b/,
      'a body edit would start a second full CI run',
    )
  })
})

describe('screenshot refresh PR lookup', () => {
  async function find(
    open: unknown[],
    closed: unknown[],
    tip: string | Error,
  ): Promise<{ outputs: Map<string, string>; queries: unknown[] }> {
    const outputs = new Map<string, string>()
    const queries: unknown[] = []
    await runScript(
      step(planJob, 'Find the newest refresh PR and the branch tip').with?.['script'],
      {
        context,
        core: { setOutput: (key: string, value: string) => outputs.set(key, value) },
        github: {
          rest: {
            pulls: {
              list: async (query: { state: string }) => {
                queries.push(query)
                return { data: query.state === 'open' ? open : closed }
              },
            },
            git: {
              getRef: async () => {
                if (tip instanceof Error) throw tip
                return { data: { object: { sha: tip } } }
              },
            },
          },
        },
      },
    )
    return { outputs, queries }
  }
  const missing = Object.assign(new Error('Not Found'), { status: 404 })

  it('prefers the open refresh PR and reads the branch tip', async () => {
    const { outputs, queries } = await find(
      [{ number: 9, state: 'open', head: { sha: RENDERED } }],
      [{ number: 8, state: 'closed', head: { sha: MAIN } }],
      RENDERED,
    )
    assert.deepEqual(Object.fromEntries(outputs), {
      'pull-number': '9',
      'pull-open': 'true',
      'pull-head': RENDERED,
      'branch-sha': RENDERED,
    })
    // The script's objects belong to the VM's realm; compare their data.
    assert.deepEqual(JSON.parse(JSON.stringify(queries)), [
      {
        owner: 'copse-dev',
        repo: 'agent-pane',
        state: 'open',
        base: 'main',
        head: 'copse-dev:screenshot-refresh/main',
        sort: 'created',
        direction: 'desc',
        per_page: 1,
      },
    ])
  })

  it('falls back to the newest closed PR, then to none, with an absent branch', async () => {
    const closed = await find([], [{ number: 8, state: 'closed', head: { sha: MAIN } }], missing)
    assert.equal(closed.outputs.get('pull-number'), '8')
    assert.equal(closed.outputs.get('pull-open'), 'false')
    assert.equal(closed.outputs.get('pull-head'), MAIN)
    assert.equal(closed.outputs.get('branch-sha'), '')
    const none = await find([], [], missing)
    assert.equal(none.outputs.get('pull-number'), '')
    assert.equal(none.outputs.get('pull-head'), '')
  })

  it('does not mistake a failed branch lookup for an absent branch', async () => {
    await assert.rejects(find([], [], Object.assign(new Error('boom'), { status: 500 })), /boom/)
  })
})

describe('screenshot refresh PR creation', () => {
  async function open(existing: unknown[]): Promise<{ created: unknown[]; notices: string[] }> {
    const created: unknown[] = []
    const notices: string[] = []
    await runScript(
      step(refreshJob, 'Open the draft refresh PR unless one is open').with?.['script'],
      {
        context,
        process: { env: { MAIN_SHA: MAIN } },
        core: { notice: (message: string) => notices.push(message) },
        github: {
          rest: {
            pulls: {
              list: async () => ({ data: existing }),
              create: async (request: unknown) => {
                created.push(request)
                return { data: { number: 11 } }
              },
            },
          },
        },
      },
    )
    return { created, notices }
  }

  it('reuses the open PR, whose CI the branch push already restarted', async () => {
    const { created, notices } = await open([{ number: 9 }])
    assert.deepEqual(created, [])
    assert.deepEqual(notices, ['Refreshed #9 onto main aaaaaaaaaaaa; CI re-renders it.'])
  })

  it('opens one draft into main from the refresh branch when none is open', async () => {
    const { created, notices } = await open([])
    assert.equal(created.length, 1)
    const request = z
      .object({
        base: z.string(),
        head: z.string(),
        draft: z.boolean(),
        title: z.string(),
        body: z.string(),
      })
      .parse(created[0])
    assert.equal(request.base, 'main')
    assert.equal(request.head, SCREENSHOT_REFRESH_BRANCH)
    assert.equal(request.draft, true)
    assert.match(request.body, /pr-screenshot-review/)
    assert.match(request.body, /Commit the ticked screenshots/)
    assert.match(request.body, /Nothing is accepted or merged\s+automatically/)
    assert.match(request.body, /never moves the branch while this PR carries any other commit/)
    assert.match(
      request.body,
      /https:\/\/github\.com\/copse-dev\/agent-pane\/blob\/main\/docs\/agent-development\.md#triage-a-recurring-candidate-before-re-baselining/,
    )
    assert.deepEqual(notices, ['Opened draft refresh PR #11 on main aaaaaaaaaaaa.'])
  })
})

describe('screenshot refresh branch push', { skip: process.platform === 'win32' }, () => {
  // The real step against a local bare repository standing in for GitHub.
  // Each night's commit differs by its timestamp; give every push its own, or
  // two pushes in one second would build the same commit.
  let night = 0
  function push(
    remote: string,
    mainSha: string,
    expectedTip: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const script = step(refreshJob, 'Move the branch to a new empty commit on main').run
    assert.ok(script)
    assert.doesNotMatch(script, /\$\{\{/)
    const temp = mkdtempSync(join(tmpdir(), 'screenshot-refresh-runner-'))
    try {
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MAIN_SHA: mainSha,
          EXPECTED_TIP: expectedTip,
          PUSH_TOKEN: 'token',
          REPOSITORY: 'copse-dev/agent-pane',
          SERVER_URL: `file://${remote}`,
          RUNNER_TEMP: temp,
          GIT_AUTHOR_DATE: `${String(1_800_000_000 + ++night * 86_400)} +0000`,
          GIT_COMMITTER_DATE: `${String(1_800_000_000 + night * 86_400)} +0000`,
        },
      })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  it('creates the branch, replaces only the planned tip, and never discards a newer commit', () => {
    const { dir, base, refresh } = repository()
    const remote = mkdtempSync(join(tmpdir(), 'screenshot-refresh-remote-'))
    const bare = join(remote, 'copse-dev/agent-pane.git')
    try {
      gitIn(remote, 'init', '--quiet', '--bare', bare)
      gitIn(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
      gitIn(dir, 'push', '--quiet', bare, 'main')
      const tip = (): string => gitIn(bare, 'rev-parse', `refs/heads/${SCREENSHOT_REFRESH_BRANCH}`)

      assert.equal(push(remote, base, refresh).status, 1, 'an absent branch is not the planned tip')
      const created = push(remote, base, '')
      assert.equal(created.status, 0, created.stderr)
      const first = tip()
      assert.equal(isRefreshCommit(first, bare), true)
      assert.equal(gitIn(bare, 'rev-parse', `${first}^`), base)
      assert.equal(gitIn(bare, 'log', '-1', '--format=%an', first), 'github-actions[bot]')

      assert.equal(
        push(remote, base, '').status,
        1,
        'an existing branch needs its tip as the lease',
      )
      const replaced = push(remote, base, first)
      assert.equal(replaced.status, 0, replaced.stderr)
      assert.notEqual(tip(), first)

      // A maintainer commits ticked screenshots after the plan read the tip.
      gitIn(
        dir,
        'push',
        '--quiet',
        bare,
        `${refresh}:refs/heads/${SCREENSHOT_REFRESH_BRANCH}`,
        '--force',
      )
      const refused = push(remote, base, first)
      assert.equal(refused.status, 1)
      assert.match(refused.stderr, /\(stale info\)/)
      assert.match(refused.stdout, /::error::screenshot-refresh\/main moved after planning/)
      assert.equal(tip(), refresh)

      assert.equal(push(remote, 'not-a-sha', refresh).status, 1)
      assert.equal(push(remote, base, 'main').status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })
})
