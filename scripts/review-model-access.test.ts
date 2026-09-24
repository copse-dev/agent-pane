import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { z } from 'zod'

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string().optional(),
      environment: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      env: z.record(z.string(), z.string()).optional(),
      steps: z.array(
        z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
          run: z.string().optional(),
        }),
      ),
    }),
  ),
})

function job(workflow: string, name: string): z.infer<typeof workflowSchema>['jobs'][string] {
  const parsed = workflowSchema.parse(
    load(readFileSync(`.github/workflows/${workflow}.yml`, 'utf8')),
  )
  const result = parsed.jobs[name]
  assert.ok(result)
  return result
}

// Evaluate only the grammar actually used by these guards. Unknown clauses
// fail rather than turning an untested Actions expression into assumed access.
function allows(expression: string, context: Readonly<Record<string, string>>): boolean {
  assert.ok(expression.startsWith('${{ ') && expression.endsWith(' }}'))
  return expression
    .slice(4, -3)
    .split('&&')
    .map((clause) => {
      if (clause.trim() === "needs.authorize.outputs.authorized == 'true'") {
        return context['authorized'] === 'true'
      }
      const equal = /^github\.([a-z_]+)\s*==\s*'([^']+)'$/.exec(clause.trim())
      if (equal) {
        const [, key, value] = equal
        assert.ok(key && value)
        return context[key]?.toLowerCase() === value.toLowerCase()
      }
      const contains = /^contains\(fromJSON\('([^']+)'\), github\.([a-z_]+)\)$/.exec(clause.trim())
      assert.ok(contains, `unsupported access expression: ${clause}`)
      const [, values, key] = contains
      assert.ok(values && key)
      const list = z.array(z.string()).parse(JSON.parse(values))
      return list.some((value) => value.toLowerCase() === context[key]?.toLowerCase())
    })
    .every(Boolean)
}

interface TestPull {
  number: number
  state: string
  title: string
  html_url: string
  updated_at: string
  user: { id: number }
  head: { sha: string; repo: { id: number; full_name: string } }
  base: { ref: string; repo: { id: number } }
  labels: { name: string }[]
}

function pull(options: { author?: number; repository?: number; labels?: string[] } = {}): TestPull {
  return {
    number: 123,
    state: 'open',
    title: 'A routine change',
    html_url: 'https://github.com/copse-dev/agent-pane/pull/123',
    updated_at: new Date().toISOString(),
    user: { id: options.author ?? 338988 },
    head: {
      sha: 'a'.repeat(40),
      repo: { id: options.repository ?? 1274237362, full_name: 'copse-dev/agent-pane' },
    },
    base: { ref: 'main', repo: { id: 1274237362 } },
    labels: (options.labels ?? ['copse-review']).map((name) => ({ name })),
  }
}

async function authorize(
  workflow: string,
  jobName: string,
  livePull: unknown,
  options: { requested?: string; candidates?: unknown[] } = {},
): Promise<{ outputs: Map<string, string>; errors: string[] }> {
  const step = job(workflow, jobName).steps.find((candidate) => candidate.id === 'pr')
  const script = z.string().parse(step?.with?.['script'])
  assert.doesNotMatch(script, /\$\{\{/)
  const outputs = new Map<string, string>()
  const errors: string[] = []
  const execution: unknown = runInNewContext(`(async () => {\n${script}\n})()`, {
    context: { repo: { owner: 'copse-dev', repo: 'agent-pane' } },
    process: {
      env: {
        PR_NUMBER: '123',
        EXPECTED_HEAD: 'a'.repeat(40),
        EXPECTED_BASE: 'main',
        REQUESTED_PR: options.requested ?? '123',
      },
    },
    core: {
      notice: () => {},
      setFailed: (message: string) => errors.push(message),
      setOutput: (key: string, value: string): void => {
        outputs.set(key, value)
      },
      summary: {
        addHeading: () => ({
          addLink: () => ({ addRaw: () => ({ write: async (): Promise<void> => {} }) }),
        }),
      },
    },
    github: {
      rest: { pulls: { get: async () => ({ data: livePull }), list: () => {} } },
      paginate: async () => options.candidates ?? [],
    },
  })
  await execution
  return { outputs, errors }
}

describe('paid PR reviewer access', () => {
  for (const [workflow, gate] of [
    ['review-findings', 'authorize'],
    ['review-nightly', 'select'],
  ]) {
    assert.ok(workflow && gate)
    it(`${workflow} rejects external actors, reruns, repositories and workflow refs`, () => {
      const trusted = {
        authorized: 'true',
        repository_id: '1274237362',
        event_name: 'workflow_dispatch',
        ref: 'refs/heads/main',
        workflow_ref: `copse-dev/agent-pane/.github/workflows/${workflow}.yml@refs/heads/main`,
        actor_id: '338988',
        triggering_actor: 'jonathanKingston',
      }
      // Exercise the model job separately with a cached successful preflight.
      for (const name of [gate, 'findings']) {
        const expression = z.string().parse(job(workflow, name).if).trim()
        assert.equal(allows(expression, trusted), true)
        assert.equal(
          allows(expression, {
            ...trusted,
            actor_id: '41898282',
            triggering_actor: 'github-actions[bot]',
          }),
          true,
        )
        assert.equal(allows(expression, { ...trusted, event_name: 'schedule' }), gate === 'select')
        for (const [key, value] of Object.entries({
          repository_id: '999',
          event_name: 'pull_request_target',
          ref: 'refs/heads/untrusted',
          workflow_ref: trusted.workflow_ref.replace('/heads/main', '/heads/untrusted'),
          actor_id: '999',
          triggering_actor: 'contributor',
        })) {
          assert.equal(allows(expression, { ...trusted, [key]: value }), false, `${name}: ${key}`)
        }
        assert.equal(allows(expression, {}), false)
      }
      assert.equal(job(workflow, 'findings').environment, 'copse-review-models')
      assert.equal(job(workflow, gate).environment, undefined)
    })

    it(`${workflow} rejects external PRs even when dispatched by a trusted actor`, async () => {
      const accepted = await authorize(workflow, gate, pull())
      assert.equal(accepted.errors.length, 0)
      assert.equal(
        accepted.outputs.get(gate === 'authorize' ? 'authorized' : 'number'),
        gate === 'authorize' ? 'true' : '123',
      )
      for (const rejected of [
        pull({ author: 999 }),
        pull({ repository: 999 }),
        { ...pull(), user: null },
        { ...pull(), head: { sha: 'a'.repeat(40), repo: null } },
        { ...pull(), base: { ref: 'main', repo: { id: 999 } } },
        { ...pull(), state: 'closed' },
      ]) {
        const result = await authorize(workflow, gate, rejected)
        assert.equal(result.outputs.size, 0)
      }
    })
  }

  it('requires the exact labelled head/base before entering the protected findings job', async () => {
    assert.equal(job('review-findings', 'findings').needs, 'authorize')
    assert.match(
      z.string().parse(job('review-findings', 'findings').if),
      /needs\.authorize\.outputs\.authorized == 'true'/,
    )
    for (const rejected of [
      pull({ labels: [] }),
      { ...pull(), head: { ...pull().head, sha: 'b'.repeat(40) } },
      { ...pull(), base: { ...pull().base, ref: 'other' } },
    ]) {
      assert.equal((await authorize('review-findings', 'authorize', rejected)).outputs.size, 0)
    }
  })

  it('filters external authors from scheduled samples and honors explicit opt-outs', async () => {
    const result = await authorize('review-nightly', 'select', pull(), {
      requested: '',
      candidates: [pull({ author: 999, labels: [] }), pull({ repository: 999, labels: [] })],
    })
    assert.equal(result.outputs.size, 0)
    const selected = await authorize('review-nightly', 'select', pull(), {
      requested: '',
      candidates: [pull({ labels: [] })],
    })
    assert.equal(selected.outputs.get('number'), '123')
    assert.equal(
      (await authorize('review-nightly', 'select', pull({ labels: ['copse-review-skip'] }))).outputs
        .size,
      0,
    )
  })

  for (const workflow of ['review-findings', 'review-nightly']) {
    it(`${workflow} selects Luna with only its dedicated key and fails closed on bad configuration`, () => {
      const findings = job(workflow, 'findings')
      assert.equal(
        findings.env?.['REVIEW_PROFILE'],
        "${{ vars.COPSE_REVIEW_PR_PROFILE || 'openrouter-luna' }}",
      )
      assert.equal(
        findings.env['COPSE_REVIEW_OPENROUTER_PROVIDER'],
        "${{ vars.COPSE_REVIEW_OPENROUTER_PROVIDER || 'openai' }}",
      )
      const script = findings.steps.find(
        (step) => step.name === 'Review with focused validation and post the findings',
      )?.run
      assert.ok(script)
      const profile = script.slice(0, script.indexOf('review_base_url='))
      assert.ok(profile.includes('esac'))
      const probe = `${profile}\nprintf '%s\\n' "$REVIEW_PROVIDER" "$REVIEW_MODEL" "$REVIEW_BASE_URL" "\${OPENROUTER_API_KEY+present}" "\${COPSE_REVIEW_API_KEY+present}" "\${SCW_DEFAULT_PROJECT_ID+present}"`
      const execute = (selected: string, key = 'fixture-key'): SpawnSyncReturns<string> =>
        spawnSync('bash', ['-c', probe], {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'],
            REVIEW_PROFILE: selected,
            REVIEW_PROVIDER: 'openai-compatible',
            REVIEW_MODEL: 'qwen3.8-27b',
            REVIEW_BASE_URL: 'https://api.scaleway.ai/v1',
            OPENROUTER_API_KEY: key,
            COPSE_REVIEW_API_KEY: 'fixture-scaleway',
            SCW_DEFAULT_PROJECT_ID: 'fixture-project',
          },
        })
      const luna = execute('openrouter-luna')
      assert.equal(luna.status, 0, luna.stderr)
      assert.equal(
        luna.stdout,
        'openrouter\nopenai/gpt-6-luna\nhttps://openrouter.ai/api/v1\npresent\n\n\n',
      )
      const configured = execute('configured')
      assert.equal(configured.status, 0, configured.stderr)
      assert.equal(
        configured.stdout,
        'openai-compatible\nqwen3.8-27b\nhttps://api.scaleway.ai/v1\n\npresent\npresent\n',
      )
      assert.equal(execute('openrouter-luna', '').status, 1)
      assert.equal(execute('unexpected').status, 1)
    })
  }
})
