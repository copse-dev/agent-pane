import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'
import {
  actionPublishingFetch,
  decodeActionRequest,
  npmTarballs,
  copsePnpmPatches,
} from '@copse/review/ci/action-policy.mts'
import type { FetchLike } from '@copse/review/forge-review.ts'

const request = {
  repository: 'copse-dev/streaming-markdown',
  pr: 123,
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
}
const resolved = 'https://registry.npmjs.org/example/-/example-1.0.0.tgz'
const integrity = 'sha512-YQ=='
const lock = (entries: Record<string, unknown>): string =>
  JSON.stringify({ lockfileVersion: 3, packages: entries })

describe('portable review dependency policy', () => {
  it('accepts a pinned request and rejects refs, shell fragments and malformed PR numbers', () => {
    assert.deepEqual(decodeActionRequest(JSON.stringify(request)), request)
    for (const patch of [
      { head: 'main' },
      { base: '--upload-pack=evil' },
      { pr: -1 },
      { repository: 'a/b/c' },
    ]) {
      assert.throws(() => decodeActionRequest(JSON.stringify({ ...request, ...patch })))
    }
  })

  it('deduplicates registry tarballs and ignores root metadata', () => {
    assert.deepEqual(
      npmTarballs(
        lock({
          '': { version: '1.0.0' },
          'node_modules/example': { resolved, integrity },
          'node_modules/nested/node_modules/example': { resolved, integrity },
        }),
      ),
      [resolved],
    )
  })

  it('rejects lockfiles that could make the trusted host fetch local files or foreign hosts', () => {
    for (const url of [
      'file:///etc/passwd',
      'git+https://github.com/evil/repo',
      'https://registry.npmjs.org.evil.example/package.tgz',
      'https://user:secret@registry.npmjs.org/package.tgz',
      'https://registry.npmjs.org:444/package.tgz',
      'http://registry.npmjs.org/package.tgz',
      `${resolved}?token=secret`,
      `${resolved}#fragment`,
    ])
      assert.throws(() =>
        npmTarballs(lock({ 'node_modules/example': { resolved: url, integrity } })),
      )
    for (const entry of [{ resolved }, { resolved, integrity: 'sha1-YQ==' }, { link: true }, {}]) {
      assert.throws(() => npmTarballs(lock({ 'node_modules/example': entry })))
    }
    assert.throws(() => npmTarballs('{"lockfileVersion":1}'))
  })
})

describe('portable review publishing', () => {
  const currentPull = {
    state: 'open',
    head: { sha: request.head },
    base: { sha: request.base },
    draft: false,
    labels: [],
  }
  const post = { method: 'POST', headers: { Authorization: 'Bearer write-token' }, body: '{}' }

  it('uses the read token for freshness and the provided write token only for publishing', async () => {
    const calls: { url: string; authorization: string | undefined }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, authorization: init.headers['Authorization'] })
      return { status: 200, text: async () => JSON.stringify(currentPull) }
    }
    await actionPublishingFetch(
      request,
      'read-token',
      fetchImpl,
    )('https://api.github.com/review', post)
    assert.deepEqual(
      calls.map((call) => call.authorization),
      ['Bearer read-token', 'Bearer write-token'],
    )
    assert.match(calls[0]?.url ?? '', /\/repos\/copse-dev\/streaming-markdown\/pulls\/123$/)
  })

  it('blocks all mutations for stale, closed, skipped or unlabelled draft PRs', async () => {
    for (const pull of [
      { ...currentPull, head: { sha: 'c'.repeat(40) } },
      { ...currentPull, base: { sha: 'c'.repeat(40) } },
      { ...currentPull, state: 'closed' },
      { ...currentPull, labels: [{ name: 'copse-review-skip' }] },
      { ...currentPull, draft: true },
      { garbage: true },
    ]) {
      const calls: string[] = []
      const fetchImpl: FetchLike = async (_url, init) => {
        calls.push(init.method)
        return { status: 200, text: async () => JSON.stringify(pull) }
      }
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        await assert.rejects(
          actionPublishingFetch(
            request,
            'read-token',
            fetchImpl,
          )('https://api.github.com/review', { ...post, method }),
          /did not publish/,
        )
      }
      assert.deepEqual(calls, ['GET', 'GET', 'GET'])
    }
  })

  it('fails closed when GitHub cannot attest the current PR', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 403,
      text: async () => JSON.stringify(currentPull),
    })
    await assert.rejects(
      actionPublishingFetch(
        request,
        'read-token',
        fetchImpl,
      )('https://api.github.com/review', post),
    )
  })
})

const workflowSchema = z.object({
  on: z.object({ workflow_call: z.object({ secrets: z.record(z.string(), z.unknown()) }) }),
  jobs: z.object({
    authorize: z.object({ steps: z.array(z.object({ with: z.object({ script: z.string() }) })) }),
    ground: z.object({
      permissions: z.record(z.string(), z.unknown()),
      steps: z.array(z.unknown()),
    }),
    findings: z.object({ needs: z.array(z.string()), steps: z.array(z.unknown()) }),
  }),
})

async function authorize(
  options: {
    permission?: string
    rerunPermission?: string
    action?: string
    label?: string
    draft?: boolean
    labels?: string[]
    state?: string
    ref?: string
    privateRepo?: boolean
    event?: string
    reviewerRef?: string
    modelKey?: boolean
    preparation?: string
    copseAllowed?: boolean
    author?: number
    headRepo?: number
  } = {},
): Promise<Record<string, string>> {
  const workflow = workflowSchema.parse(
    load(readFileSync('.github/workflows/reviewer.yml', 'utf8')),
  )
  const script = workflow.jobs.authorize.steps[0]?.with.script
  assert.ok(script)
  const outputs: Record<string, string> = {}
  const copse = options.preparation === 'copse-pnpm'
  const repository = {
    id: copse ? 1274237362 : 7,
    default_branch: 'main',
    private: options.privateRepo ?? false,
  }
  const execution: unknown = runInNewContext(`(async () => {\n${script}\n})()`, {
    process: {
      env: {
        PREPARATION: options.preparation ?? 'npm',
        COPSE_CALLER_ALLOWED: options.copseAllowed === false ? 'false' : 'true',
        REVIEWER_REF: options.reviewerRef ?? 'c'.repeat(40),
        MANUAL_PR: '123',
        TRIGGERING_ACTOR: 'rerunner',
        MAX_STEPS: '12',
        MAX_VERIFY: '3',
        HAS_APP_ID: 'false',
        HAS_APP_KEY: 'false',
        HAS_MODEL_KEY: options.modelKey === false ? 'false' : 'true',
      },
    },
    context: {
      repo: { owner: 'copse-dev', repo: copse ? 'agent-pane' : 'streaming-markdown' },
      actor: 'maintainer',
      ref: options.ref ?? 'refs/heads/main',
      eventName: options.event ?? 'pull_request_target',
      payload: {
        action: options.action ?? 'opened',
        label: { name: options.label ?? 'copse-review' },
        pull_request: { number: 123 },
      },
    },
    core: {
      notice: () => {},
      setOutput: (name: string, value: string) => {
        outputs[name] = value
      },
    },
    github: {
      rest: {
        repos: {
          get: async () => ({ data: repository }),
          getCollaboratorPermissionLevel: async ({ username }: { username: string }) => ({
            data: {
              permission:
                username === 'maintainer'
                  ? (options.permission ?? 'write')
                  : (options.rerunPermission ?? 'write'),
            },
          }),
        },
        pulls: {
          get: async () => ({
            data: {
              state: options.state ?? 'open',
              draft: options.draft ?? false,
              user: { id: options.author ?? 338988 },
              head: { sha: request.head, repo: { id: options.headRepo ?? repository.id } },
              base: { sha: request.base, ref: 'main', repo: repository },
              labels: (options.labels ?? []).map((name) => ({ name })),
            },
          }),
        },
      },
    },
  })
  await execution
  return outputs
}

describe('portable review authorization', () => {
  it('resolves a current PR for a maintainer, including manually dispatched and labelled drafts', async () => {
    for (const options of [
      {},
      { event: 'workflow_dispatch' },
      { action: 'labeled', draft: true, labels: ['copse-review'] },
    ]) {
      assert.deepEqual(decodeActionRequest((await authorize(options))['request'] ?? ''), request)
    }
  })

  it('does not spend model credentials on unauthorized callers, unrelated labels or opted-out PRs', async () => {
    for (const options of [
      { permission: 'read' },
      { rerunPermission: 'read' },
      { action: 'synchronize' },
      { action: 'labeled', label: 'other' },
      { labels: ['copse-review-skip'] },
      { draft: true },
      { state: 'closed' },
    ])
      assert.deepEqual(await authorize(options), {})
  })

  it('rejects untrusted workflow contexts and unpinned source', async () => {
    for (const options of [
      { event: 'pull_request' },
      { ref: 'refs/heads/contributor' },
      { privateRepo: true },
      { reviewerRef: 'main' },
      { modelKey: false },
      { preparation: 'unknown' },
    ])
      await assert.rejects(authorize(options))
  })
})

describe('portable Actions isolation', () => {
  it('keeps paid credentials out of grounding and gates the fresh findings runner on successful grounding', () => {
    const workflow = workflowSchema.parse(
      load(readFileSync('.github/workflows/reviewer.yml', 'utf8')),
    )
    assert.deepEqual(workflow.jobs.ground.permissions, {})
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs.ground),
      /secrets\.|model-api-key|app-private-key/,
    )
    assert.deepEqual(workflow.jobs.findings.needs, ['authorize', 'ground'])
    assert.ok(Object.hasOwn(workflow.on.workflow_call.secrets, 'model-api-key'))
    for (const name of ['review-ground', 'review-findings']) {
      const action = readFileSync(`.github/actions/${name}/action.yml`, 'utf8')
      assert.match(action, /--backend container/)
      assert.match(action, /--foreign/)
      assert.doesNotMatch(action, /--allow-unisolated/)
    }
  })
})

describe('Copse dogfooding of the reusable reviewer', () => {
  it('accepts only owner PRs in the Copse profile and obtains its key from the protected job', async () => {
    const options = { preparation: 'copse-pnpm', modelKey: false }
    assert.equal(
      decodeActionRequest((await authorize(options))['request'] ?? '').repository,
      'copse-dev/agent-pane',
    )
    for (const patch of [
      { copseAllowed: false },
      { author: 999 },
      { headRepo: 999 },
      { labels: ['copse-review-skip'] },
      { draft: true },
    ]) {
      assert.deepEqual(await authorize({ ...options, ...patch }), {})
    }
  })

  it('rejects unauthorized failed-job reruns before entering the protected environment', () => {
    const workflow = z
      .object({
        jobs: z.object({
          'copse-findings': z.object({
            if: z.string(),
            environment: z.string(),
            permissions: z.record(z.string(), z.string()),
          }),
          authorize: z.object({
            steps: z.array(z.object({ env: z.record(z.string(), z.string()) })),
          }),
        }),
      })
      .parse(load(readFileSync('.github/workflows/reviewer.yml', 'utf8')))
    const job = workflow.jobs['copse-findings']
    assert.equal(job.environment, 'copse-review-models')
    assert.equal(job.permissions['pull-requests'], 'read')
    const github = {
      repository_id: '1274237362',
      actor_id: '338988',
      triggering_actor: 'jonathanKingston',
      ref: 'refs/heads/main',
      workflow_ref: 'copse-dev/agent-pane/.github/workflows/review-trigger.yml@refs/heads/main',
    }
    const allows = (expression: string, context: Record<string, unknown>): boolean =>
      Boolean(runInNewContext(expression.trim().slice(3, -2), context))
    const preflight = workflow.jobs.authorize.steps[0]?.env['COPSE_CALLER_ALLOWED']
    assert.ok(preflight)
    assert.equal(allows(job.if, { github, inputs: { preparation: 'copse-pnpm' } }), true)
    assert.equal(allows(job.if, { github, inputs: { preparation: 'npm' } }), false)
    for (const expression of [preflight, job.if]) {
      for (const [key, value] of Object.entries({
        repository_id: '999',
        actor_id: '999',
        triggering_actor: 'contributor',
        ref: 'refs/heads/contributor',
        workflow_ref: github.workflow_ref.replace('/heads/main', '/heads/untrusted'),
      })) {
        assert.equal(
          allows(expression, {
            github: { ...github, [key]: value },
            inputs: { preparation: 'copse-pnpm' },
          }),
          false,
          key,
        )
      }
    }
  })

  it('accepts the actual pnpm lock and rejects external resolutions and unsafe patch paths', () => {
    assert.deepEqual(copsePnpmPatches(readFileSync('pnpm-lock.yaml', 'utf8')), {
      '@anthropic-ai/sandbox-runtime@0.0.74': 'patches/@anthropic-ai__sandbox-runtime@0.0.74.patch',
    })
    const makeLock = (resolution: unknown, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        lockfileVersion: '9.0',
        packages: { 'example@1.0.0': { resolution } },
        ...extra,
      })
    assert.deepEqual(copsePnpmPatches(makeLock({ integrity })), {})
    for (const resolution of [
      { tarball: 'https://evil.example/file.tgz', integrity },
      { directory: '/etc' },
      { integrity, commit: 'abc' },
      { repo: 'git@example:repo' },
    ]) {
      assert.throws(() => copsePnpmPatches(makeLock(resolution)))
    }
    assert.throws(() =>
      copsePnpmPatches(
        makeLock(
          { integrity },
          {
            patchedDependencies: {
              example: { hash: 'a'.repeat(64), path: '../runner/token.patch' },
            },
          },
        ),
      ),
    )
    assert.throws(() =>
      copsePnpmPatches(makeLock({ directory: 'packages/extract-zip', type: 'directory' })),
    )
  })
})

describe('shared findings model configuration', () => {
  it('retains dedicated Luna and configured billing routes without mixing provider credentials', () => {
    const action = z
      .object({
        runs: z.object({
          steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
        }),
      })
      .parse(load(readFileSync('.github/actions/review-findings/action.yml', 'utf8')))
    const script = action.runs.steps.find(
      (step) => step.name === 'Review and publish findings',
    )?.run
    assert.ok(script)
    const profile = script.slice(
      script.indexOf('case "$REVIEW_PROFILE"'),
      script.indexOf('cd "$COPSE_REVIEW_TARGET"'),
    )
    const probe = `${profile}\nprintf '%s\\n' "$REVIEW_PROVIDER" "$REVIEW_MODEL" "$review_base_url" "\${OPENROUTER_API_KEY+present}" "\${COPSE_REVIEW_API_KEY+present}" "\${SCW_DEFAULT_PROJECT_ID+present}" "\${review_args[@]}"`
    const execute = (
      selected: string,
      overrides: Record<string, string> = {},
    ): SpawnSyncReturns<string> =>
      spawnSync('bash', ['-c', probe], {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          REVIEW_PROFILE: selected,
          REVIEW_PROVIDER: 'openai-compatible',
          REVIEW_MODEL: 'qwen3.8-27b',
          REVIEW_BASE_URL: 'https://api.scaleway.ai/v1',
          OPENROUTER_API_KEY: 'dedicated-luna',
          COPSE_REVIEW_API_KEY: 'configured-key',
          SCW_DEFAULT_PROJECT_ID: '12345678-1234-1234-1234-123456789abc',
          REVIEW_FEEDBACK_LABEL: '',
          REVIEW_POST_SUMMARY: 'false',
          ...overrides,
        },
      })
    const luna = execute('openrouter-luna')
    assert.equal(luna.status, 0, luna.stderr)
    assert.equal(
      luna.stdout,
      'openrouter\nopenai/gpt-6-luna\nhttps://openrouter.ai/api/v1\npresent\n\n\n--base-url\nhttps://openrouter.ai/api/v1\n',
    )
    const configured = execute('configured', {
      REVIEW_FEEDBACK_LABEL: 'review-has-feedback',
      REVIEW_POST_SUMMARY: 'true',
    })
    assert.equal(configured.status, 0, configured.stderr)
    assert.match(configured.stdout, /api\.scaleway\.ai\/12345678-1234-1234-1234-123456789abc\/v1/)
    assert.match(
      configured.stdout,
      /--feedback-label\nreview-has-feedback\n--post-summary\ngithub\n$/,
    )
    assert.equal(execute('openrouter-luna', { OPENROUTER_API_KEY: '' }).status, 1)
    assert.equal(execute('configured', { SCW_DEFAULT_PROJECT_ID: '' }).status, 1)
    assert.equal(execute('configured', { SCW_DEFAULT_PROJECT_ID: 'not-a-project' }).status, 1)
    assert.equal(execute('unknown').status, 1)
    const portable = execute('portable', { REVIEW_BASE_URL: '' })
    assert.equal(portable.status, 0, portable.stderr)
    assert.doesNotMatch(portable.stdout, /--post-summary|--feedback-label/)
  })
})
