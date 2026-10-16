import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTOMATIONS_PLUGIN_ID } from '@copse/agent/plugins/automations-plugin.ts'
import type { BranchCiAutomation, Thread } from '@shared/types'
import { storageGet, storageSet } from '../storage/storage.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { FileEventInboxStore } from '../supervisor/event-inbox-store.ts'
import {
  createBranchCiAutomationService,
  readPullRequestCiSnapshot,
  type BranchCiAutomationDependencies,
  type BranchCiAutomationService,
  type BranchCiRun,
  type BranchCiSnapshot,
} from './branch-ci-automation-service.ts'
import {
  readIssueHasLabel,
  readLabelEvents,
  readOpenPullRequests,
  type LabelEventObservation,
  type PullRequestHead,
  type PullRequestObservation,
} from './github-event-sources.ts'

const STORAGE_KEY = `plugin.${AUTOMATIONS_PLUGIN_ID}.ci-definitions`
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const NOW = Date.parse('2026-10-01T10:05:00Z')

function ciRun(id: number, workflow: string, sha = SHA_A): BranchCiRun {
  return {
    id,
    run_attempt: 1,
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    updated_at: '2026-10-01T10:00:00Z',
    html_url: `https://github.com/owner/repo/actions/runs/${String(id)}`,
    name: workflow,
  }
}

function pull(number: number, sha: string, draft = false): PullRequestObservation {
  return {
    number,
    draft,
    title: `Change ${String(number)}`,
    html_url: `https://github.com/owner/repo/pull/${String(number)}`,
    updated_at: '2026-10-01T10:00:00Z',
    head: { sha, ref: `feature-${String(number)}` },
    author: 'someone',
  }
}

function labeled(id: number, issue: number, label = 'needs-triage'): LabelEventObservation {
  return {
    id,
    created_at: '2026-10-01T10:00:00Z',
    label,
    actor: 'maintainer',
    issue: {
      number: issue,
      title: `Issue ${String(issue)}`,
      html_url: `https://github.com/owner/repo/issues/${String(issue)}`,
      state: 'open',
    },
  }
}

interface World {
  service: BranchCiAutomationService
  threads: Map<string, Thread>
  supervisor: TaskSupervisor
  ci: BranchCiSnapshot
  pulls: PullRequestObservation[]
  heads: Map<number, PullRequestHead>
  events: LabelEventObservation[]
  labelled: Set<number>
  failRead: { value: boolean }
  /** Pretend the renderer started every pending run. */
  settle(): void
}

async function world(
  t: TestContext,
  overrides: Partial<BranchCiAutomationDependencies> = {},
): Promise<World> {
  storageSet(STORAGE_KEY, [])
  const root = await mkdtemp(join(tmpdir(), 'copse-event-triggers-'))
  const env = { COPSE_WORKSPACE_DIR: root }
  const supervisor = new TaskSupervisor({ store: new FileSupervisedTaskStore(env) })
  let created: BranchCiAutomationService | null = null
  const state: World = {
    get service(): BranchCiAutomationService {
      if (!created) throw new Error('The service is created at the end of world()')
      return created
    },
    threads: new Map(),
    supervisor,
    ci: { headSha: SHA_A, runs: [] },
    pulls: [],
    heads: new Map(),
    events: [],
    labelled: new Set(),
    failRead: { value: false },
    settle: () => {
      for (const thread of state.threads.values()) thread.draftPrompt = ''
    },
  }
  const guard = <T>(value: T): Promise<T> =>
    state.failRead.value ? Promise.reject(new Error('rate limited')) : Promise.resolve(value)
  created = createBranchCiAutomationService({
    now: () => NOW,
    isPluginEnabled: () => true,
    repositoryForProject: () => Promise.resolve('github.com/owner/repo'),
    snapshot: () => guard(state.ci),
    pullRequests: () => guard(state.pulls),
    pullRequestHead: (_definition, number) => {
      const head = state.heads.get(number)
      return head ? guard(head) : Promise.reject(new Error('not found'))
    },
    labelEvents: () => guard(state.events),
    issueHasLabel: (_definition, issue) => Promise.resolve(state.labelled.has(issue)),
    loadProjectThreads: () => Promise.resolve([...state.threads.values()]),
    getProjectThread: (_projectId, threadId) =>
      Promise.resolve(state.threads.get(threadId) ?? null),
    createProjectThread: (_projectId, thread) => {
      state.threads.set(thread.id, thread)
      return Promise.resolve()
    },
    releasePreviousRun: () => Promise.resolve({ released: true }),
    supervisor: () => supervisor,
    inboxStore: new FileEventInboxStore(env),
    ...overrides,
  })
  t.after(async () => {
    state.service.stop()
    await supervisor.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return state
}

const base = { name: 'Automation', prompt: 'Look at it.', model: 'gpt-test', enabled: true }

describe('CI check filters', () => {
  it('runs for a selected check and records the others as filtered with a reason', async (t) => {
    const w = await world(t)
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-ci-failed', branch: 'main', checks: ['ci', ' CI ', 'build'] },
    })
    assert.deepEqual(definition.trigger.kind === 'github-ci-failed' && definition.trigger.checks, [
      'CI',
      'build',
    ])
    w.ci = { headSha: SHA_A, runs: [ciRun(10, 'lint'), ciRun(11, 'CI')] }
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)
    assert.match([...w.threads.values()][0]?.draftPrompt ?? '', /"workflow": "CI"/)
    const history = await w.service.history('project-a', definition.id)
    const filtered = history.find((entry) => entry.outcome === 'filtered')
    assert.match(filtered?.reason ?? '', /“lint” is not one of the selected checks/)
    assert.equal(history.find((entry) => entry.outcome === 'started')?.summary, 'CI failed on main')
    // The filtered delivery is settled: another poll neither re-admits nor starts it.
    w.settle()
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)
  })

  it('rejects more than ten checks', async (t) => {
    const w = await world(t)
    await assert.rejects(
      w.service.upsert('project-a', {
        ...base,
        trigger: {
          kind: 'github-ci-failed',
          branch: 'main',
          checks: Array.from({ length: 11 }, (_, index) => `check-${String(index)}`),
        },
      }),
      /at most 10 checks/,
    )
  })
})

describe('PR-scoped CI', () => {
  it('watches the pull request head, saving its branch, and refuses a closed pull request', async (t) => {
    const w = await world(t)
    w.heads.set(7, { state: 'open', draft: false, head: { sha: SHA_A, ref: 'feature-7' } })
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-ci-failed', pullRequest: 7 },
    })
    assert.equal(
      definition.trigger.kind === 'github-ci-failed' && definition.trigger.branch,
      'feature-7',
    )
    w.heads.set(8, { state: 'closed', draft: false, head: { sha: SHA_B, ref: 'old' } })
    await assert.rejects(
      w.service.upsert('project-a', {
        ...base,
        trigger: { kind: 'github-ci-failed', pullRequest: 8 },
      }),
      /Pull request #8 is not open/,
    )
    // A fork PR's runs report the fork's branch name; the PR scope matches on the exact head SHA.
    w.ci = { headSha: SHA_A, runs: [{ ...ciRun(20, 'CI'), head_branch: 'someone:fork-branch' }] }
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)
    assert.match([...w.threads.values()][0]?.draftPrompt ?? '', /"pullRequest": 7/)
  })

  it('reads runs by head sha and treats a closed pull request as an error', async () => {
    const calls: string[] = []
    const gh = (args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
      calls.push(args[1] ?? '')
      return Promise.resolve({
        stdout: args[1]?.includes('/pulls/')
          ? JSON.stringify({ state: 'open', draft: false, head: { sha: SHA_B, ref: 'x' } })
          : JSON.stringify({ workflow_runs: [] }),
        stderr: '',
        code: 0,
      })
    }
    const snapshot = await readPullRequestCiSnapshot('/w', 'github.com/owner/repo', 9, gh)
    assert.deepEqual(snapshot, { headSha: SHA_B, runs: [] })
    assert.deepEqual(calls, [
      'repos/owner/repo/pulls/9',
      `repos/owner/repo/actions/runs?head_sha=${SHA_B}&per_page=100`,
    ])
    await assert.rejects(
      readPullRequestCiSnapshot('/w', 'github.com/owner/repo', 9, () =>
        Promise.resolve({
          stdout: JSON.stringify({ state: 'closed', draft: false, head: { sha: SHA_B, ref: 'x' } }),
          stderr: '',
          code: 0,
        }),
      ),
      /not open/,
    )
  })
})

describe('pull request changed', () => {
  it('baselines open pull requests, starts one run per new head, and ignores drafts', async (t) => {
    const w = await world(t)
    w.pulls = [pull(1, SHA_A), pull(2, SHA_A, true)]
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-pr-changed', baseBranch: 'main', transition: 'new-commits' },
    })
    await w.service.poll()
    assert.equal(w.threads.size, 0, 'existing pull requests are history, not events')

    w.pulls = [pull(1, SHA_B), pull(2, SHA_A, true), pull(3, SHA_C)]
    w.heads.set(1, { state: 'open', draft: false, head: { sha: SHA_B, ref: 'feature-1' } })
    w.heads.set(3, { state: 'open', draft: false, head: { sha: SHA_C, ref: 'feature-3' } })
    await w.service.poll()
    await w.supervisor.waitForIdle()
    // One run at a time: the newest delivery waits behind the first, visibly.
    assert.equal(w.threads.size, 1)
    const history = await w.service.history('project-a', definition.id)
    assert.deepEqual(history.map((entry) => entry.outcome).sort(), ['started', 'waiting'])
    assert.match(history.find((entry) => entry.outcome === 'waiting')?.reason ?? '', /Waiting for/)

    const prompt = [...w.threads.values()][0]?.draftPrompt ?? ''
    assert.match(prompt, /Pull request facts \(external source data\)/)
    assert.match(prompt, /"transition": "new-commits"/)

    w.settle()
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 2, 'the waiting delivery starts once the first run settles')
    w.settle()
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 2, 'repeated polls stay quiet')
  })

  it('treats a pull request that leaves draft as the ready-for-review transition', async (t) => {
    const w = await world(t)
    w.pulls = [pull(5, SHA_A, true), pull(6, SHA_A)]
    await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-pr-changed', baseBranch: 'main', transition: 'ready-for-review' },
    })
    w.heads.set(5, { state: 'open', draft: false, head: { sha: SHA_A, ref: 'feature-5' } })
    // PR 6 was never a draft, and a new head on PR 5 while still draft is not the transition.
    w.pulls = [pull(5, SHA_B, true), pull(6, SHA_B)]
    await w.service.poll()
    assert.equal(w.threads.size, 0)

    w.pulls = [pull(5, SHA_B), pull(6, SHA_B)]
    w.heads.set(5, { state: 'open', draft: false, head: { sha: SHA_B, ref: 'feature-5' } })
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)
    assert.match([...w.threads.values()][0]?.draftPrompt ?? '', /"number": 5/)
    w.settle()
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1, 'the transition fires once')
  })

  it('does not start a run whose pull request moved on or closed before it started', async (t) => {
    const w = await world(t)
    await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-pr-changed', baseBranch: 'main', transition: 'new-commits' },
    })
    w.pulls = [pull(1, SHA_B)]
    w.heads.set(1, { state: 'open', draft: false, head: { sha: SHA_B, ref: 'feature-1' } })
    await w.service.poll()
    await w.supervisor.waitForIdle()
    const [created] = [...w.threads.values()]
    assert.ok(created)
    assert.deepEqual(await w.service.canStart('project-a', created.id), { allowed: true })
    w.heads.set(1, { state: 'open', draft: false, head: { sha: SHA_C, ref: 'feature-1' } })
    assert.match((await w.service.canStart('project-a', created.id)).reason ?? '', /newer commits/)
    w.heads.set(1, { state: 'closed', draft: false, head: { sha: SHA_B, ref: 'feature-1' } })
    assert.match((await w.service.canStart('project-a', created.id)).reason ?? '', /closed/)
  })

  it('rejects an invalid base branch', async (t) => {
    const w = await world(t)
    await assert.rejects(
      w.service.upsert('project-a', {
        ...base,
        trigger: { kind: 'github-pr-changed', baseBranch: 'a..b', transition: 'new-commits' },
      }),
    )
  })
})

describe('issue labelled', () => {
  it('baselines existing labels, starts once per labelling, and treats a re-label as new', async (t) => {
    const w = await world(t)
    w.events = [labeled(100, 1)]
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    await w.service.poll()
    assert.equal(w.threads.size, 0)

    w.events = [labeled(101, 2), labeled(100, 1)]
    w.labelled = new Set([2])
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)
    const prompt = [...w.threads.values()][0]?.draftPrompt ?? ''
    assert.match(prompt, /Issue facts \(external source data\)/)
    assert.match(prompt, /"number": 2/)
    w.settle()
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 1)

    // Removing and re-applying the label is a new transition with a new event id.
    w.events = [labeled(105, 2), labeled(101, 2), labeled(100, 1)]
    await w.service.poll()
    await w.supervisor.waitForIdle()
    assert.equal(w.threads.size, 2)
    const history = await w.service.history('project-a', definition.id)
    assert.equal(history.length, 2)
    assert.ok(history.every((entry) => entry.outcome === 'started'))
  })

  it('does not start when the label was removed before the run began', async (t) => {
    const w = await world(t)
    await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    w.events = [labeled(200, 9)]
    w.labelled = new Set([9])
    await w.service.poll()
    await w.supervisor.waitForIdle()
    const [created] = [...w.threads.values()]
    assert.ok(created)
    w.labelled = new Set()
    assert.match(
      (await w.service.canStart('project-a', created.id)).reason ?? '',
      /label was removed/,
    )
  })

  it('refuses a label that could break out of the query', async (t) => {
    const w = await world(t)
    await assert.rejects(
      w.service.upsert('project-a', {
        ...base,
        trigger: { kind: 'github-issue-labeled', label: 'x") | .. | ("' },
      }),
    )
    await assert.rejects(
      readLabelEvents('/w', 'github.com/owner/repo', 'bad"label', () =>
        Promise.reject(new Error('must not reach gh')),
      ),
      /valid label/,
    )
  })

  it('does not poll a paused automation', async (t) => {
    const w = await world(t)
    await w.service.upsert('project-a', {
      ...base,
      enabled: false,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    w.events = [labeled(300, 1)]
    await w.service.poll()
    assert.equal(w.threads.size, 0)
  })
})

describe('GitHub readers', () => {
  it('encodes the base branch and projects pull requests inside gh', async () => {
    let seen: string[] = []
    const pulls = await readOpenPullRequests('/w', 'github.com/owner/repo', 'release/1', (args) => {
      seen = args
      return Promise.resolve({
        stdout: JSON.stringify([pull(1, SHA_A)]),
        stderr: '',
        code: 0,
      })
    })
    assert.equal(pulls[0]?.number, 1)
    assert.match(seen[1] ?? '', /base=release%2F1/)
    assert.ok(seen.includes('--jq'))
  })

  it('rejects malformed GitHub data and checks the label on an issue', async () => {
    await assert.rejects(
      readOpenPullRequests('/w', 'github.com/owner/repo', 'main', () =>
        Promise.resolve({ stdout: '[{"number":"x"}]', stderr: '', code: 0 }),
      ),
      /invalid pull request data/,
    )
    const answer =
      (
        state: string,
        labels: string[],
      ): (() => Promise<{ stdout: string; stderr: string; code: number }>) =>
      () =>
        Promise.resolve({ stdout: JSON.stringify({ state, labels }), stderr: '', code: 0 })
    assert.equal(
      await readIssueHasLabel('/w', 'github.com/owner/repo', 3, 'a', answer('open', ['a'])),
      true,
    )
    assert.equal(
      await readIssueHasLabel('/w', 'github.com/owner/repo', 3, 'a', answer('closed', ['a'])),
      false,
    )
  })
})

describe('problems and delivery recovery', () => {
  it('records a polling failure on the automation and clears it when polling recovers', async (t) => {
    const w = await world(t)
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    w.failRead.value = true
    await w.service.poll()
    const stored = (): BranchCiAutomation | undefined =>
      w.service.list('project-a').find((item) => item.id === definition.id)
    assert.match(stored()?.lastProblem?.message ?? '', /Could not read GitHub: rate limited/)
    assert.equal(stored()?.lastProblem?.kind, 'failed')
    w.failRead.value = false
    await w.service.poll()
    assert.equal(stored()?.lastProblem, undefined)
  })

  it('accepts a start failure only from the latest run of the automation', async (t) => {
    const w = await world(t)
    const definition = await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    w.events = [labeled(400, 1)]
    w.labelled = new Set([1])
    await w.service.poll()
    await w.supervisor.waitForIdle()
    const [created] = [...w.threads.values()]
    assert.ok(created)
    assert.equal(
      await w.service.reportStartFailure('project-a', 'someone-elses-thread', {
        code: 'worktree-failed',
        message: 'x',
      }),
      false,
    )
    assert.equal(
      await w.service.reportStartFailure('project-a', created.id, {
        code: 'worktree-failed',
        message: 'Isolated worktree is unavailable',
      }),
      true,
    )
    const problem = w.service
      .list('project-a')
      .find((item) => item.id === definition.id)?.lastProblem
    assert.equal(problem?.code, 'worktree-failed')
    assert.equal(problem.threadId, created.id)
    // A routine polling error must not bury the more specific run failure.
    w.failRead.value = true
    await w.service.poll()
    assert.equal(
      w.service.list('project-a').find((item) => item.id === definition.id)?.lastProblem?.code,
      'worktree-failed',
    )
  })

  it('keeps unreadable stored rows when new kinds are saved', async (t) => {
    const w = await world(t)
    const future = { v: 2, id: 'from-a-newer-build' }
    storageSet(STORAGE_KEY, [future])
    await w.service.upsert('project-a', {
      ...base,
      trigger: { kind: 'github-issue-labeled', label: 'needs-triage' },
    })
    const rows = storageGet(STORAGE_KEY)
    assert.ok(
      Array.isArray(rows) && rows.some((row) => JSON.stringify(row) === JSON.stringify(future)),
    )
  })
})
