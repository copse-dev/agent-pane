import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  CHECK_NAME,
  decideBaseFreshness,
  decodeBehindBy,
  decodeCandidates,
  evaluate,
  listCandidates,
  type Candidate,
  type Verdict,
} from './base-freshness.mts'

const candidate: Candidate = {
  number: 42,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  baseRef: 'main',
  draft: false,
}

type StubApi = {
  requested: string[]
  posted: unknown[]
  api: {
    get: (path: string) => Promise<string>
    post: (path: string, body: unknown) => Promise<void>
  }
}

/** A stub standing in for the two GitHub endpoints the script reads. */
function stubApi(routes: Record<string, string>): StubApi {
  const requested: string[] = []
  const posted: unknown[] = []
  return {
    requested,
    posted,
    api: {
      get: async (path: string): Promise<string> => {
        requested.push(path)
        const body = routes[path]
        if (body === undefined) throw new Error(`no stub for ${path}`)
        return await Promise.resolve(body)
      },
      post: async (path: string, body: unknown): Promise<void> => {
        posted.push({ path, body })
        await Promise.resolve()
      },
    },
  }
}

describe('base freshness policy', () => {
  it('passes a pull request that contains every commit on its base', () => {
    const verdict = decideBaseFreshness(candidate, 0)
    assert.equal(verdict.conclusion, 'success')
    assert.match(verdict.title, /Up to date with main/)
  })

  it('fails a pull request whose base has advanced since it was tested', () => {
    // The whole point of #2520's base-advancement half: CI is green, and green
    // describes a merge result that no longer exists.
    const verdict = decideBaseFreshness(candidate, 3)
    assert.equal(verdict.conclusion, 'failure')
    assert.match(verdict.title, /3 commits behind main/)
    assert.match(verdict.summary, /no longer exists/)
  })

  it('counts a single commit without pluralising it', () => {
    assert.match(decideBaseFreshness(candidate, 1).title, /^1 commit behind main$/)
  })

  it('fails closed when the comparison could not be established', () => {
    // An unestablished base is indistinguishable from a stale one at merge
    // time, so it must never resolve to success or to a neutral that branch
    // protection would accept.
    const verdict = decideBaseFreshness(candidate, null)
    assert.equal(verdict.conclusion, 'failure')
    assert.match(verdict.summary, /fails\s*\n?\s*closed|fails closed/)
  })

  it('never returns a conclusion branch protection treats as passing but untested', () => {
    // `neutral` and `skipped` both SATISFY a required status check
    // (docs.github.com, troubleshooting required status checks), so the policy
    // has exactly two outcomes and success is reachable only from zero behind.
    for (const behind of [null, 0, 1, 250, -1, 0.5, Number.NaN]) {
      const verdict: Verdict = decideBaseFreshness(candidate, behind)
      const conclusion: string = verdict.conclusion
      assert.ok(
        ['success', 'failure'].includes(conclusion),
        `${String(behind)} produced ${conclusion}`,
      )
      assert.equal(conclusion === 'success', behind === 0)
    }
  })
})

describe('base freshness decoding', () => {
  it('reads behind_by from a comparison', () => {
    assert.equal(decodeBehindBy('{"behind_by":7,"ahead_by":2}'), 7)
  })

  it('returns null rather than guessing when behind_by is not a commit count', () => {
    assert.equal(decodeBehindBy('{"ahead_by":2}'), null)
    assert.equal(decodeBehindBy('{"behind_by":"7"}'), null)
    assert.equal(decodeBehindBy('{"behind_by":-1}'), null)
    assert.equal(decodeBehindBy('{"behind_by":1.5}'), null)
    assert.equal(decodeBehindBy('[]'), null)
  })

  it('rejects a listing that is not an array of pull requests', () => {
    assert.throws(() => decodeCandidates('{"message":"Not Found"}'), /not a JSON array/)
  })

  it('rejects an entry missing any field the verdict is addressed to', () => {
    // A check run posted against a missing head sha would attach the verdict to
    // nothing, so each field is required rather than defaulted.
    assert.throws(() => decodeCandidates('[{"number":1}]'), /has no head sha/)
    assert.throws(() => decodeCandidates('[{"head":{"sha":"a"}}]'), /has no number/)
    assert.throws(() => decodeCandidates('[7]'), /has no number/)
    assert.throws(() => decodeCandidates('[{"number":1,"head":{"sha":"a"}}]'), /has no base ref/)
  })
})

describe('base freshness fan-out', () => {
  const listing = (...pulls: { number: number; draft?: boolean }[]): string =>
    JSON.stringify(
      pulls.map((pull) => ({
        number: pull.number,
        draft: pull.draft ?? false,
        head: { sha: `sha-${String(pull.number)}` },
        base: { ref: 'main' },
      })),
    )

  it('skips drafts, which cannot merge and re-evaluate on ready_for_review', async () => {
    const { api } = stubApi({
      '/pulls?state=open&base=main&per_page=100&page=1': listing(
        { number: 1 },
        { number: 2, draft: true },
        { number: 3 },
      ),
    })
    const candidates = await listCandidates(api, 'main')
    assert.deepEqual(
      candidates.map((c) => c.number),
      [1, 3],
    )
  })

  it('percent-encodes a base ref so a slashed branch name cannot forge a path', async () => {
    const { api, requested } = stubApi({
      '/pulls?state=open&base=release%2F1.2&per_page=100&page=1': '[]',
    })
    await listCandidates(api, 'release/1.2')
    assert.deepEqual(requested, ['/pulls?state=open&base=release%2F1.2&per_page=100&page=1'])
  })

  it('follows pagination until a short page ends the listing', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))
    const { api, requested } = stubApi({
      '/pulls?state=open&base=main&per_page=100&page=1': listing(...full),
      '/pulls?state=open&base=main&per_page=100&page=2': listing({ number: 101 }),
    })
    assert.equal((await listCandidates(api, 'main')).length, 101)
    assert.equal(requested.length, 2)
  })

  it('refuses a truncated set rather than silently skipping the tail', async () => {
    // Quietly dropping candidates would hand back exactly the unexamined pass
    // this control exists to remove, so exhausting the bound is an error.
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))
    const routes: Record<string, string> = {}
    for (let page = 1; page <= 10; page += 1) {
      routes[`/pulls?state=open&base=main&per_page=100&page=${String(page)}`] = listing(...full)
    }
    await assert.rejects(listCandidates(stubApi(routes).api, 'main'), /refusing to evaluate/)
  })

  it('pages on pages, not on kept candidates, so a wall of drafts terminates', async () => {
    const drafts = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, draft: true }))
    const routes: Record<string, string> = {}
    for (let page = 1; page <= 10; page += 1) {
      routes[`/pulls?state=open&base=main&per_page=100&page=${String(page)}`] = listing(...drafts)
    }
    await assert.rejects(listCandidates(stubApi(routes).api, 'main'), /refusing to evaluate/)
  })

  it('publishes one check run per candidate, against its own head sha', async () => {
    const { api, posted } = stubApi({
      '/compare/main...sha-1': '{"behind_by":0}',
      '/compare/main...sha-2': '{"behind_by":4}',
    })
    const verdicts = await evaluate(
      api,
      [
        { number: 1, headSha: 'sha-1', baseRef: 'main', draft: false },
        { number: 2, headSha: 'sha-2', baseRef: 'main', draft: false },
      ],
      async (c, verdict) => {
        await api.post('/check-runs', {
          name: CHECK_NAME,
          head_sha: c.headSha,
          conclusion: verdict.conclusion,
        })
      },
    )
    assert.deepEqual(
      verdicts.map((v) => v.conclusion),
      ['success', 'failure'],
    )
    assert.deepEqual(posted, [
      { path: '/check-runs', body: { name: CHECK_NAME, head_sha: 'sha-1', conclusion: 'success' } },
      { path: '/check-runs', body: { name: CHECK_NAME, head_sha: 'sha-2', conclusion: 'failure' } },
    ])
  })

  it('fails a candidate closed when its comparison errors, without abandoning the rest', async () => {
    // A transient comparison failure must not silently drop the candidate from
    // the run: no check run at all reads as "not configured", not as "unknown".
    const { api } = stubApi({ '/compare/main...sha-2': '{"behind_by":0}' })
    const verdicts = await evaluate(
      api,
      [
        { number: 1, headSha: 'sha-1', baseRef: 'main', draft: false },
        { number: 2, headSha: 'sha-2', baseRef: 'main', draft: false },
      ],
      async () => {
        await Promise.resolve()
      },
    )
    assert.deepEqual(
      verdicts.map((v) => v.conclusion),
      ['failure', 'success'],
    )
  })
})

describe('base-freshness.yml workflow invariants', () => {
  const workflow = readFileSync(resolve('.github/workflows/base-freshness.yml'), 'utf8')
  /**
   * The workflow with its comment lines removed. The prose explains what this
   * job deliberately does NOT do — read the fleet variable, republish
   * `CI Passed` — so the "must not appear" pins have to read the directives.
   */
  const directives = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

  it('re-evaluates on the base moving, not only on the pull request moving', () => {
    // Without the push trigger this control cannot exist: the staleness appears
    // after the pull request's own run has finished, so nothing on the pull
    // request path ever observes it.
    assert.match(workflow, /^ {2}push:\n {4}branches: \[main, release\]$/m)
    assert.match(workflow, /^ {2}pull_request_target:\n {4}types: \[[^\]]*\]$/m)
    for (const type of ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review']) {
      assert.match(workflow, new RegExp(`types: \\[[^\\]]*\\b${type}\\b`))
    }
  })

  it('never checks out or executes pull request code under pull_request_target', () => {
    // The privileged-token trigger is safe only while the run stays on trusted
    // default-branch code. A ref on the checkout, or any build/install of the
    // pull request's tree, would undo that.
    assert.match(workflow, /^ {6}- uses: actions\/checkout@v[\d.]+$/m)
    assert.doesNotMatch(workflow, /^ {8}ref:/m, 'checkout must not be pointed at the PR head')
    assert.doesNotMatch(directives, /uses: \.\/\.github\/actions\/setup/)
    assert.doesNotMatch(directives, /pnpm install|npm ci|pnpm run build/)
  })

  it('asks for exactly the permissions publishing a verdict needs', () => {
    assert.match(workflow, /^permissions: \{\}$/m)
    assert.match(workflow, /^ {6}checks: write$/m)
    assert.match(workflow, /^ {6}pull-requests: read$/m)
    for (const forbidden of ['contents: write', 'actions: write', 'pull-requests: write']) {
      assert.doesNotMatch(workflow, new RegExp(`^ +${forbidden}$`, 'm'), forbidden)
    }
  })

  it('stays on fixed hosted capacity and inside a timeout', () => {
    // Same rule as ci-passed: a control reporting on the fleet must not queue
    // behind it (#1669).
    assert.match(workflow, /^ {4}runs-on: ubuntu-latest$/m)
    assert.doesNotMatch(directives, /SELF_HOSTED/)
    assert.match(workflow, /^ {4}timeout-minutes: \d+$/m)
  })

  it('collapses a burst of base pushes into one evaluation', () => {
    assert.match(workflow, /^ {2}cancel-in-progress: true$/m)
    assert.match(workflow, /group: base-freshness-/)
  })

  it('leaves the CI Passed contract untouched', () => {
    // This slice is additive. The moment it renames or re-publishes `CI Passed`
    // it stops being a change that cannot open a merge window.
    assert.doesNotMatch(directives, /CI Passed/)
    assert.doesNotMatch(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'), /Base Current/)
  })

  it('runs the script the package manifest exposes', () => {
    assert.match(workflow, /run: pnpm run ci:base-freshness/)
    const manifest: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    assert.ok(typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest))
    const scripts: unknown = Object.hasOwn(manifest, 'scripts')
      ? Object.getOwnPropertyDescriptor(manifest, 'scripts')?.value
      : undefined
    assert.ok(typeof scripts === 'object' && scripts !== null)
    assert.equal(
      Object.getOwnPropertyDescriptor(scripts, 'ci:base-freshness')?.value,
      'node scripts/base-freshness.mts',
    )
  })
})
