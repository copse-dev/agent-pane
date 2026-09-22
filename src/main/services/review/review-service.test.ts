import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import type { StreamChunk, ThreadReviewReport } from '@shared/types'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import {
  REVIEW_LENSES_SETTING_ID,
  REVIEW_PLUGIN_ID,
  REVIEW_VERIFY_SETTING_ID,
} from '@copse/agent/plugins/review-plugin.ts'
import { ScriptedProvider, type ScriptedStep } from '@copse/review/scripted-provider.ts'
import { createTestRepo, worktreeCount, type TestRepo } from '@copse/review/test-repo.ts'
import { setKnowledgeRootForTest } from '../storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { dismissReviewFinding } from './review-dismissals.ts'
import {
  resolveReviewBase,
  resolveReviewLensSpec,
  resolveReviewModels,
  runThreadReview,
  type ReviewHostServices,
} from './review-service.ts'

const FINDING = {
  path: 'src/math.ts',
  startLine: 1,
  class: 'contract',
  severity: 'high',
  confidence: 'high',
  claim: 'add subtracts its second argument instead of adding it.',
  reason: 'The body is a - b; every caller expecting a sum gets the difference.',
}

const REVIEWER_SCRIPT: ScriptedStep[] = [
  { type: 'tool_call', name: 'read_file', args: { path: 'src/math.ts' } },
  { type: 'tool_call', name: 'report_finding', args: FINDING },
  { type: 'text', text: 'Checked src/math.ts.' },
]

function challengerScript(status: 'stands' | 'refuted'): ScriptedStep[] {
  return [
    {
      type: 'tool_call',
      name: 'verdict',
      args: { status, reason: status === 'stands' ? 'a - b is not a sum' : 'the caller negates b' },
    },
  ]
}

const settings = (overrides: Record<string, unknown> = {}) => {
  const bag: Record<string, unknown> = { reviewerModel: 'reviewer-model', ...overrides }
  return (key: string): unknown => bag[key]
}

describe('review service', () => {
  let repo: TestRepo
  let knowledgeRoot: string
  let restoreWorkspace: () => void

  before(async () => {
    repo = await createTestRepo({
      'package.json': '{"name":"fixture"}',
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
    })
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({
      'src/math.ts': 'export const add = (a: number, b: number): number => a - b\n',
    })
    repo.commit('break add')
  })

  after(async () => {
    await repo.remove()
  })

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'review-service-knowledge-'))
    setKnowledgeRootForTest(knowledgeRoot)
    restoreWorkspace = setWorkspaceRootForTest(repo.root)
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(knowledgeRoot, { recursive: true, force: true })
  })

  interface Run {
    chunks: StreamChunk[]
    reports: ThreadReviewReport[]
    result: Awaited<ReturnType<typeof runThreadReview>>
  }

  async function run(options: {
    challenger?: ScriptedStep[]
    readSetting?: (key: string) => unknown
    initiator?: 'user' | 'agent'
    registryEnabled?: boolean
    reviewer?: LLMProvider
    signal?: AbortSignal
  }): Promise<Run> {
    const chunks: StreamChunk[] = []
    const providers = new Map<string, LLMProvider>()
    const providerFor = (model: string): Promise<LLMProvider> => {
      if (model === 'reviewer-model' && options.reviewer) return Promise.resolve(options.reviewer)
      const script =
        model === 'challenger-model'
          ? (options.challenger ?? challengerScript('stands'))
          : REVIEWER_SCRIPT
      let provider = providers.get(model)
      if (!provider) {
        provider = new ScriptedProvider(script)
        providers.set(model, provider)
      }
      return Promise.resolve(provider)
    }
    const services: ReviewHostServices = {
      providerFor,
      isBillable: () => false,
      resolveDistinctModels: (values) => Promise.resolve([...values]),
      estimateCost: () => '~$0.00',
      requestSpendApproval: () => Promise.resolve({ approved: true, remember: false }),
      containerBackend: () => Promise.resolve({ backend: null, reason: 'no docker in tests' }),
    }
    const registry = createFirstPartyPluginRegistry()
    if (options.registryEnabled === false) registry.disable(REVIEW_PLUGIN_ID)
    const result = await runWithDefaultPluginRegistry(registry, () =>
      runThreadReview({
        threadId: 'thread-1',
        root: repo.root,
        chatModel: 'chat-model',
        onChunk: (chunk) => chunks.push(chunk),
        signal: options.signal ?? new AbortController().signal,
        initiator: options.initiator ?? 'user',
        readSetting: options.readSetting ?? settings({ challengerModel: 'challenger-model' }),
        services,
        hostEnv: { PATH: process.env['PATH'] },
      }),
    )
    const reports = chunks.flatMap((chunk) =>
      chunk.type === 'review_report' ? [chunk.report] : [],
    )
    return { chunks, reports, result }
  }

  it('reviews a branch against its base read-only when there is no OS sandbox, and reports findings', async () => {
    const { chunks, reports, result } = await run({})
    assert.deepEqual(
      reports.map((report) => report.status),
      ['running', 'done'],
    )
    const report = result.report
    assert.equal(report.status, 'done')
    assert.equal(report.baseRef, 'main')
    assert.equal(report.dirtyWorkingTree, false)
    assert.deepEqual(report.models, { reviewer: 'reviewer-model', challenger: 'challenger-model' })
    assert.deepEqual(report.lenses, ['correctness'])
    // No sandbox in this process: nothing from the repository ran, and the
    // report says so rather than pretending Stage 0 passed.
    assert.equal(report.execution.executed, false)
    assert.match(report.execution.reason, /consent|isolation/i)
    assert.deepEqual(report.checks, [])
    assert.equal(report.notChecked.length, 1)

    assert.equal(report.findings.length, 1)
    const [finding] = report.findings
    assert.ok(finding)
    assert.equal(finding.claim, FINDING.claim)
    assert.equal(finding.path, 'src/math.ts')
    assert.equal(finding.startLine, 1)
    assert.equal(finding.verdict.status, 'unverified')
    assert.deepEqual(finding.raisedBy, ['reviewer-model (correctness)'])
    assert.deepEqual(finding.challengedBy, ['challenger-model (challenge)'])
    assert.equal(finding.anchoredText, 'export const add = (a: number, b: number): number => a - b')
    assert.equal(finding.dismissed, undefined)
    assert.equal(report.reviewers.length, 1)
    assert.equal(report.reviewers[0]?.outcome, 'completed')
    assert.equal(report.verification?.survived, 1)
    assert.match(result.summary, /1 finding/)

    // Usage reaches the thread's ledger per model.
    const usage = chunks.filter((chunk) => chunk.type === 'usage').map((chunk) => chunk.model)
    assert.deepEqual([...new Set(usage)].sort(), ['challenger-model', 'reviewer-model'])
    // The ground is closed: no worktree is left behind.
    assert.equal(worktreeCount(repo), 1)
  })

  it('reports a provider failure instead of a clean review', async () => {
    const reviewer: LLMProvider = {
      async *stream() {
        yield { type: 'text', text: '' }
        throw new Error('Provider authentication failed')
      },
    }
    const { result } = await run({ reviewer })
    assert.equal(result.report.status, 'error')
    assert.match(result.report.error ?? '', /Provider authentication failed/)
    assert.equal(result.report.reviewers[0]?.outcome, 'failed')
  })

  it('reports cancellation during the model stage instead of success', async () => {
    const controller = new AbortController()
    const reviewer: LLMProvider = {
      async *stream() {
        controller.abort(new Error('stop review'))
        yield { type: 'text', text: '' }
      },
    }
    const { result } = await run({ reviewer, signal: controller.signal })
    assert.equal(result.report.status, 'error')
    assert.equal(result.report.error, 'Review cancelled.')
  })

  it('drops a finding the challenger refutes, and counts it', async () => {
    const { result } = await run({ challenger: challengerScript('refuted') })
    assert.equal(result.report.status, 'done')
    assert.deepEqual(result.report.findings, [])
    assert.equal(result.report.refuted, 1)
  })

  it('marks a finding the user dismissed earlier, by its content id', async () => {
    const first = await run({})
    const [finding] = first.result.report.findings
    assert.ok(finding)
    dismissReviewFinding({
      findingId: finding.id,
      path: finding.path,
      claim: finding.claim,
      class: finding.class,
    })
    const second = await run({})
    const [again] = second.result.report.findings
    assert.ok(again)
    assert.equal(again.id, finding.id)
    assert.equal(again.dismissed, true)
  })

  it('skips verification when the plugin setting turns it off', async () => {
    const { result } = await run({
      readSetting: settings({
        challengerModel: 'challenger-model',
        [REVIEW_VERIFY_SETTING_ID]: false,
      }),
    })
    assert.equal(result.report.verification, null)
    const [unverified] = result.report.findings
    assert.ok(unverified)
    assert.equal(unverified.verdict.status, 'unverified')
    assert.deepEqual(unverified.challengedBy, [])
  })

  it('refuses to run while the plugin is disabled', async () => {
    const { reports, result } = await run({ registryEnabled: false })
    assert.equal(result.report.status, 'error')
    assert.match(result.report.error ?? '', /Settings → Plugins/)
    assert.deepEqual(
      reports.map((report) => report.status),
      ['error'],
    )
  })

  it('resolves the base: HEAD for a dirty tree, the base branch for a clean one, null on the base', async () => {
    assert.equal(await resolveReviewBase(repo.root), 'main')
    await repo.write({ 'src/math.ts': 'export const add = (a: number, b: number): number => 0\n' })
    try {
      assert.equal(await resolveReviewBase(repo.root), 'HEAD')
    } finally {
      repo.git('checkout', '-q', '--', 'src/math.ts')
    }
    repo.git('checkout', '-q', 'main')
    try {
      assert.equal(await resolveReviewBase(repo.root), null)
    } finally {
      repo.git('checkout', '-q', 'feature')
    }
  })

  it('reports nothing to review, not an error, when HEAD is the base and the tree is clean', async () => {
    repo.git('checkout', '-q', 'main')
    try {
      const { result } = await run({})
      assert.equal(result.report.status, 'done')
      assert.deepEqual(result.report.findings, [])
      assert.match(result.report.note ?? '', /Nothing to review/)
    } finally {
      repo.git('checkout', '-q', 'feature')
    }
  })

  it('resolves models from the plugin settings, falling back to the chat model and the rule', async () => {
    const asIs = (values: readonly string[]): Promise<string[]> => Promise.resolve([...values])
    assert.deepEqual(
      await resolveReviewModels('chat-model', settings({ challengerModel: 'c' }), asIs),
      { reviewer: 'reviewer-model', challenger: 'c' },
    )
    assert.equal(
      (await resolveReviewModels('chat-model', () => undefined, asIs)).reviewer,
      'chat-model',
      'a blank reviewer setting means the chat model',
    )
    assert.notEqual(
      (await resolveReviewModels('acp:claude-code', () => undefined, asIs)).reviewer,
      'acp:claude-code',
      'a routed chat model cannot review and falls through to the rule',
    )
  })

  it('maps the lens choice onto the package lens spec', () => {
    assert.equal(
      resolveReviewLensSpec(() => undefined),
      '',
    )
    assert.equal(resolveReviewLensSpec(settings({ [REVIEW_LENSES_SETTING_ID]: 'all' })), 'all')
    assert.equal(resolveReviewLensSpec(settings({ [REVIEW_LENSES_SETTING_ID]: 'vibes' })), '')
  })
})
