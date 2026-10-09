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
    actor?: string
    triggeringActor?: string
    signal?: Record<string, unknown>
    lookupCandidates?: Record<string, unknown>[]
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
    headRepo?: number | null
    manualPr?: string
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
        MANUAL_PR: options.manualPr ?? '123',
        TRIGGERING_ACTOR: options.triggeringActor ?? 'rerunner',
        MAX_STEPS: '12',
        MAX_VERIFY: '3',
        HAS_APP_ID: 'false',
        HAS_APP_KEY: 'false',
        HAS_MODEL_KEY: options.modelKey === false ? 'false' : 'true',
      },
    },
    context: {
      repo: { owner: 'copse-dev', repo: copse ? 'agent-pane' : 'streaming-markdown' },
      actor: options.actor ?? 'maintainer',
      ref: options.ref ?? 'refs/heads/main',
      eventName: options.event ?? 'workflow_dispatch',
      payload: {
        workflow_run: {
          event: 'pull_request',
          conclusion: 'success',
          path: '.github/workflows/copse-review-request.yml',
          repository: { id: repository.id },
          head_repository: { id: repository.id },
          head_sha: request.head,
          head_branch: 'test-review',
          pull_requests: [{ number: 123 }],
          actor: { login: options.actor ?? 'maintainer', id: 338988 },
          triggering_actor: { login: options.triggeringActor ?? 'rerunner', id: 338988 },
          ...options.signal,
        },
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
                username === (options.actor ?? 'maintainer')
                  ? (options.permission ?? 'write')
                  : (options.rerunPermission ?? 'write'),
            },
          }),
        },
        pulls: {
          list: async (query: { state: string; head: string; base: string }) => {
            assert.equal(query.state, 'open')
            assert.equal(query.head, 'copse-dev:test-review')
            assert.equal(query.base, 'main')
            return {
              data: options.lookupCandidates ?? [
                {
                  number: 123,
                  head: { sha: request.head, repo: repository },
                  base: { ref: 'main', repo: repository },
                },
              ],
            }
          },
          get: async () => ({
            data: {
              state: options.state ?? 'open',
              draft: options.draft ?? false,
              user: { id: options.author ?? 338988 },
              head: {
                sha: request.head,
                repo: options.headRepo === null ? null : { id: options.headRepo ?? repository.id },
              },
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
  it('resolves a current same-repository PR for a manual maintainer request, including labelled drafts', async () => {
    for (const options of [{}, { draft: true, labels: ['copse-review'] }]) {
      assert.deepEqual(decodeActionRequest((await authorize(options))['request'] ?? ''), request)
    }
  })

  it('does not authorize grounding or model review for fork heads, unauthorized callers or opted-out PRs', async () => {
    for (const options of [
      { permission: 'read' },
      { rerunPermission: 'read' },
      { headRepo: 999 },
      { headRepo: null },
      { labels: ['copse-review-skip'] },
      { draft: true },
      { state: 'closed' },
    ])
      assert.deepEqual(await authorize(options), {})
  })

  it('authorizes current same-repository automatic requests, including Dependabot', async () => {
    for (const options of [
      { event: 'workflow_run' },
      {
        event: 'workflow_run',
        actor: 'dependabot[bot]',
        triggeringActor: 'dependabot[bot]',
        permission: 'read',
        rerunPermission: 'read',
        author: 49699333,
        signal: {
          actor: { login: 'dependabot[bot]', id: 49699333 },
          triggering_actor: { login: 'dependabot[bot]', id: 49699333 },
        },
      },
    ]) {
      assert.deepEqual(decodeActionRequest((await authorize(options))['request'] ?? ''), request)
    }
  })

  it('resolves omitted PR associations by exact same-repository branch and commit', async () => {
    const options = { event: 'workflow_run', manualPr: '0', signal: { pull_requests: [] } }
    assert.deepEqual(decodeActionRequest((await authorize(options))['request'] ?? ''), request)
    for (const lookupCandidates of [
      [],
      [
        {
          number: 123,
          head: { sha: 'd'.repeat(40), repo: { id: 7 } },
          base: { ref: 'main', repo: { id: 7 } },
        },
      ],
      [
        {
          number: 123,
          head: { sha: request.head, repo: { id: 999 } },
          base: { ref: 'main', repo: { id: 7 } },
        },
      ],
      [
        {
          number: 123,
          head: { sha: request.head, repo: { id: 7 } },
          base: { ref: 'release', repo: { id: 7 } },
        },
      ],
      [123, 124].map((number) => ({
        number,
        head: { sha: request.head, repo: { id: 7 } },
        base: { ref: 'main', repo: { id: 7 } },
      })),
    ])
      assert.deepEqual(await authorize({ ...options, lookupCandidates }), {})
  })

  it('rejects failed, foreign, stale, misassociated and unauthorized automatic requests', async () => {
    for (const options of [
      { signal: { event: 'push' } },
      { signal: { conclusion: 'failure' } },
      { signal: { path: '.github/workflows/untrusted.yml' } },
      { signal: { repository: { id: 999 } } },
      { signal: { head_repository: { id: 999 } } },
      { signal: { head_repository: null } },
      { signal: { pull_requests: [] } },
      { signal: { pull_requests: [{ number: 999 }] } },
      { signal: { pull_requests: [{ number: 123 }, { number: 124 }] } },
      { signal: { head_sha: 'd'.repeat(40) } },
      { signal: { actor: null } },
      { headRepo: 999 },
      { headRepo: null },
      { permission: 'read' },
      { rerunPermission: 'read' },
      { signal: { triggering_actor: { login: 'outside' } }, rerunPermission: 'read' },
      {
        actor: 'dependabot[bot]',
        triggeringActor: 'dependabot[bot]',
        permission: 'read',
        signal: { actor: { login: 'dependabot[bot]', id: 999 } },
        author: 49699333,
      },
      {
        actor: 'dependabot[bot]',
        triggeringActor: 'dependabot[bot]',
        permission: 'read',
        signal: { actor: { login: 'dependabot[bot]', id: 49699333 } },
        author: 338988,
      },
      { draft: true },
      { labels: ['copse-review-skip'] },
    ])
      assert.deepEqual(await authorize({ event: 'workflow_run', ...options }), {})
  })

  it('rejects untrusted workflow contexts and unpinned source', async () => {
    for (const options of [
      { event: 'pull_request' },
      { event: 'pull_request_target' },
      { event: 'push' },
      { manualPr: '0' },
      { manualPr: 'not-a-number' },
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
  it('opts portable description summaries in without changing the default', () => {
    const workflow = z
      .object({
        on: z.object({
          workflow_call: z.object({
            inputs: z.object({
              'post-summary': z.object({ type: z.literal('boolean'), default: z.boolean() }),
            }),
          }),
        }),
        jobs: z.object({
          findings: z.object({
            steps: z.array(
              z.object({
                uses: z.string().optional(),
                with: z.record(z.string(), z.unknown()).optional(),
              }),
            ),
          }),
        }),
      })
      .parse(load(readFileSync('.github/workflows/reviewer.yml', 'utf8')))
    const option = workflow.on.workflow_call.inputs['post-summary']
    assert.equal(option.default, false)
    const step = workflow.jobs.findings.steps.find(
      (step) => step.uses === './.copse-reviewer/.github/actions/review-findings',
    )
    const expression = z.string().parse(step?.with?.['post-summary'])
    assert.ok(expression.startsWith('${{ ') && expression.endsWith(' }}'))
    for (const enabled of [option.default, true]) {
      assert.equal(
        runInNewContext(expression.slice(3, -2), {
          inputs: { 'post-summary': enabled },
        }),
        enabled ? 'true' : 'false',
      )
    }
  })

  it('keeps paid credentials out of grounding and gates the fresh findings runner on successful grounding', () => {
    const workflow = workflowSchema.parse(
      load(readFileSync('.github/workflows/reviewer.yml', 'utf8')),
    )
    assert.deepEqual(workflow.jobs.ground.permissions, {})
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs.ground),
      /\bsecrets\b|model-api-key|app-private-key/,
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
  it('inherits secrets only through the owner-gated same-repository workflow call', () => {
    const caller = z
      .object({
        jobs: z.object({
          review: z.object({ if: z.string(), uses: z.string(), secrets: z.string() }),
        }),
      })
      .parse(load(readFileSync('.github/workflows/review-trigger.yml', 'utf8')))
    const job = caller.jobs.review
    assert.equal(job.secrets, 'inherit')
    assert.equal(job.uses, './.github/workflows/reviewer.yml')
    const github = {
      repository_id: '1274237362',
      actor_id: '338988',
      triggering_actor: 'jonathanKingston',
      event_name: 'workflow_dispatch',
    }
    assert.equal(runInNewContext(job.if, { github }), true)
    const automatic = {
      ...github,
      event_name: 'workflow_run',
      event: {
        workflow_run: {
          event: 'pull_request',
          conclusion: 'success',
          head_repository: { id: 1274237362 },
        },
        repository: { id: 1274237362 },
      },
    }
    assert.equal(runInNewContext(job.if, { github: automatic }), true)
    for (const patch of [
      { event: 'push' },
      { conclusion: 'failure' },
      { head_repository: { id: 999 } },
    ]) {
      assert.equal(
        runInNewContext(job.if, {
          github: {
            ...automatic,
            event: {
              ...automatic.event,
              workflow_run: { ...automatic.event.workflow_run, ...patch },
            },
          },
        }),
        false,
      )
    }

    for (const patch of [
      { repository_id: '999' },
      { actor_id: '999' },
      { triggering_actor: 'contributor' },
      {
        event_name: 'workflow_run',
        event: {
          workflow_run: {
            event: 'pull_request',
            conclusion: 'failure',
            head_repository: { id: 1274237362 },
          },
          repository: { id: 1274237362 },
        },
      },
      { event_name: 'pull_request_target' },
      { event_name: 'pull_request' },
      { event_name: 'push' },
    ]) {
      assert.equal(runInNewContext(job.if, { github: { ...github, ...patch } }), false)
    }
  })

  it('resolves native inherited App credentials only in Copse findings and retains portable aliases', () => {
    const workflow = z
      .object({
        jobs: z.object({
          ground: z.record(z.string(), z.unknown()),
          findings: z.object({
            steps: z.array(
              z.object({
                uses: z.string().optional(),
                with: z.record(z.string(), z.unknown()).optional(),
              }),
            ),
          }),
          'copse-findings': z.object({
            environment: z.string(),
            needs: z.array(z.string()),
            steps: z.array(
              z.object({
                uses: z.string().optional(),
                with: z.record(z.string(), z.unknown()).optional(),
              }),
            ),
          }),
        }),
      })
      .parse(load(readFileSync('.github/workflows/reviewer.yml', 'utf8')))
    assert.doesNotMatch(JSON.stringify(workflow.jobs.ground), /\bsecrets\b/)
    assert.ok(!Object.hasOwn(workflow.jobs.ground, 'environment'))
    const copse = workflow.jobs['copse-findings']
    assert.equal(copse.environment, 'copse-review-models')
    assert.deepEqual(copse.needs, ['authorize', 'ground'])
    const secrets = {
      RELEASE_APP_ID: 'copse-app',
      RELEASE_APP_PRIVATE_KEY: 'copse-private-key',
      COPSE_REVIEW_OPENROUTER_API_KEY: 'environment-model-key',
      'app-id': 'portable-app',
      'app-private-key': 'portable-private-key',
    }
    const secretValues = z.record(z.string(), z.string()).parse(secrets)
    for (const [job, expectedId, expectedKey] of [
      [copse, secrets.RELEASE_APP_ID, secrets.RELEASE_APP_PRIVATE_KEY],
      [workflow.jobs.findings, secrets['app-id'], secrets['app-private-key']],
    ] as const) {
      const actionInputs = job.steps.find(
        (step) => step.uses === './.copse-reviewer/.github/actions/review-findings',
      )?.with
      const inputs = z.record(z.string(), z.string()).parse(actionInputs)
      const resolveSecret = (input: string): unknown => {
        const expression = inputs[input]
        assert.ok(expression)
        const name = /^\$\{\{\s*secrets\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(expression)?.[1]
        assert.ok(name, `expected a direct secret reference for ${input}`)
        assert.ok(Object.hasOwn(secretValues, name))
        return secretValues[name]
      }
      assert.equal(resolveSecret('app-id'), expectedId)
      assert.equal(resolveSecret('app-private-key'), expectedKey)
      if (job === copse) {
        assert.equal(resolveSecret('openrouter-api-key'), secrets.COPSE_REVIEW_OPENROUTER_API_KEY)
      } else {
        assert.doesNotMatch(JSON.stringify(job), /RELEASE_APP_/)
      }
    }
  })

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
      event_name: 'workflow_dispatch',
    }
    const allows = (expression: string, context: Record<string, unknown>): boolean =>
      Boolean(runInNewContext(expression.trim().slice(3, -2), context))
    const preflight = workflow.jobs.authorize.steps[0]?.env['COPSE_CALLER_ALLOWED']
    assert.ok(preflight)
    assert.equal(allows(job.if, { github, inputs: { preparation: 'copse-pnpm' } }), true)
    assert.equal(
      allows(job.if, {
        github: { ...github, event_name: 'workflow_run' },
        inputs: { preparation: 'copse-pnpm' },
      }),
      true,
    )
    assert.equal(allows(job.if, { github, inputs: { preparation: 'npm' } }), false)
    for (const expression of [preflight, job.if]) {
      for (const [key, value] of Object.entries({
        repository_id: '999',
        actor_id: '999',
        triggering_actor: 'contributor',
        event_name: 'pull_request_target',
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
    const portableSummary = execute('portable', {
      REVIEW_BASE_URL: '',
      REVIEW_POST_SUMMARY: 'true',
    })
    assert.equal(portableSummary.status, 0, portableSummary.stderr)
    assert.match(portableSummary.stdout, /--post-summary\ngithub\n$/)
  })
})
