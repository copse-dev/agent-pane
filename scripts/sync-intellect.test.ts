import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { check, resolveConfig } from 'prettier'
import {
  detectPayloadVersion,
  formatDataFile,
  graduateWanted,
  mergeApiModels,
  requestAaModels,
  type AaApiModel,
  type DataFile,
} from './sync-intellect.mts'
import { stringRecordOrEmpty } from '../src/shared/unknown-value.mts'

const BASE: DataFile = {
  canonicalVersion: 'v4.1',
  attribution: 'test',
  scores: [
    {
      modelId: 'claude-opus-4-8',
      value: 56,
      indexVersion: 'v4.1',
      source: 'seed source string',
      asOf: '2026-07-16',
      aliases: ['Opus 4.8'],
    },
  ],
  wanted: [{ modelId: 'qwen/qwen3.6-35b-a3b', aliases: ['qwen3-6-35b-a3b', 'Qwen3.6 35B A3B'] }],
  equatingPairs: [],
  equating: [],
}

describe('formatDataFile', () => {
  it('formats API-expanded JSON for the repository Prettier gate', async () => {
    const path = resolve('scripts/data/intellect-scores.json')
    const formatted = await formatDataFile({
      ...BASE,
      wanted: [
        {
          modelId: 'deepseek/deepseek-v4-reasoning',
          aliases: [
            'deepseek-v4-reasoning',
            'DeepSeek V4 (Reasoning)',
            'openrouter:deepseek/deepseek-v4-reasoning',
          ],
        },
      ],
    })
    const config = await resolveConfig(path)
    assert.equal(await check(formatted, { ...config, filepath: path }), true)
    assert.match(formatted, /"modelId": "deepseek\/deepseek-v4-reasoning"/)
  })
})

describe('mergeApiModels', () => {
  it('populates a WANTED catalog model from the feed, matched by alias', () => {
    const api: AaApiModel[] = [
      {
        slug: 'qwen3-6-35b-a3b',
        evaluations: { artificial_analysis_intelligence_index: 43 },
      },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 1)
    const added = scores.find((m) => m.modelId === 'qwen/qwen3.6-35b-a3b')
    assert.ok(added)
    assert.equal(added.value, 43)
    assert.equal(added.indexVersion, 'v4.1')
    assert.deepEqual(added.aliases, ['qwen3-6-35b-a3b', 'Qwen3.6 35B A3B'])
    assert.match(added.source, /Artificial Analysis API/)
  })

  it('never carries a self-referential alias into a populated measurement', () => {
    const withSelfAlias: DataFile = {
      ...BASE,
      wanted: [
        {
          modelId: 'qwen/qwen3.6-35b-a3b',
          aliases: ['qwen3-6-35b-a3b', 'qwen/qwen3.6-35b-a3b'],
        },
      ],
    }
    const api: AaApiModel[] = [
      { slug: 'qwen3-6-35b-a3b', evaluations: { artificial_analysis_intelligence_index: 43 } },
    ]
    const { scores } = mergeApiModels(withSelfAlias, api, 'v4.1', '2026-07-18')
    const added = scores.find((m) => m.modelId === 'qwen/qwen3.6-35b-a3b')
    assert.ok(added)
    assert.ok(!(added.aliases ?? []).includes('qwen/qwen3.6-35b-a3b'))
  })

  it('refreshes an existing same-version measurement in place', () => {
    const api: AaApiModel[] = [
      { slug: 'Opus 4.8', evaluations: { artificial_analysis_intelligence_index: 57 } },
    ]
    const { scores } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    const opus = scores.filter((m) => m.modelId === 'claude-opus-4-8')
    assert.equal(opus.length, 1)
    assert.equal(opus[0]?.value, 57)
  })

  it('preserves an unchanged measurement so scheduled refreshes do not create date-only PRs', () => {
    const api: AaApiModel[] = [
      { slug: 'Opus 4.8', evaluations: { artificial_analysis_intelligence_index: 56 } },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 1)
    assert.deepEqual(scores, BASE.scores)
  })

  it('imports an unlisted AA model under its exact slug', () => {
    const api: AaApiModel[] = [
      {
        id: 'aa-deepseek-v4-reasoning',
        slug: 'deepseek-v4-reasoning',
        name: 'DeepSeek V4 (Reasoning)',
        evaluations: { artificial_analysis_intelligence_index: 58 },
      },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 1)
    const added = scores.find((m) => m.modelId === 'deepseek-v4-reasoning')
    assert.ok(added)
    assert.equal(added.value, 58)
    assert.equal(added.indexVersion, 'v4.1')
    assert.match(added.source, /model 'deepseek-v4-reasoning'/)
    assert.equal(added.aliases, undefined)
  })

  it('ignores measured rows without any usable model identifier', () => {
    const api: AaApiModel[] = [
      {
        slug: '   ',
        evaluations: { artificial_analysis_intelligence_index: 30 },
      },
    ]
    const { scores, matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 0)
    assert.deepEqual(scores, BASE.scores)
  })

  it('ignores feed models with no index value', () => {
    const api: AaApiModel[] = [{ slug: 'qwen3-6-35b-a3b', evaluations: {} }]
    const { matched } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    assert.equal(matched, 0)
  })
})

describe('graduateWanted', () => {
  it('drops a wanted model once it has a score (the --from-api graduation)', () => {
    const api: AaApiModel[] = [
      { slug: 'qwen3-6-35b-a3b', evaluations: { artificial_analysis_intelligence_index: 43 } },
    ]
    const { scores } = mergeApiModels(BASE, api, 'v4.1', '2026-07-18')
    const wanted = graduateWanted(BASE.wanted ?? [], scores)
    assert.ok(!wanted.some((w) => w.modelId === 'qwen/qwen3.6-35b-a3b'))
  })
})

describe('requestAaModels', () => {
  /** Fake fetch that serves canned pages and records the URLs it was given. */
  function pagedFetch(pages: Record<number, unknown>): {
    fetch: typeof fetch
    urls: string[]
    keys: Array<string | undefined>
  } {
    const urls: string[] = []
    const keys: Array<string | undefined> = []
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      keys.push(stringRecordOrEmpty(init?.headers)['x-api-key'])
      const page = Number(new URL(url).searchParams.get('page'))
      return new Response(JSON.stringify(pages[page] ?? {}), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return { fetch: fn, urls, keys }
  }

  it('requests the supported free language feed, not a retired /api/v2/data/* path', async () => {
    const { fetch, urls, keys } = pagedFetch({ 1: { data: [] } })
    await requestAaModels('secret-key', fetch)
    assert.equal(urls.length, 1)
    assert.match(
      urls[0] ?? '',
      /^https:\/\/artificialanalysis\.ai\/api\/v2\/language\/models\/free/,
    )
    assert.doesNotMatch(urls[0] ?? '', /\/api\/v2\/data\//)
    assert.equal(keys[0], 'secret-key')
  })

  it('walks every page and returns page one as the version-bearing payload', async () => {
    const { fetch, urls } = pagedFetch({
      1: {
        intelligence_index_version: 4.1,
        pagination: { page: 1, total_pages: 2, has_more: true },
        data: [{ slug: 'page-one', evaluations: { artificial_analysis_intelligence_index: 20 } }],
      },
      2: {
        pagination: { page: 2, total_pages: 2, has_more: false },
        data: [{ slug: 'page-two', evaluations: { artificial_analysis_intelligence_index: 30 } }],
      },
    })
    const { firstPayload, models } = await requestAaModels('key', fetch)
    assert.equal(urls.length, 2)
    assert.deepEqual(
      models.map((m) => m.slug),
      ['page-one', 'page-two'],
    )
    assert.equal(detectPayloadVersion(firstPayload, models), 'v4.1')
  })

  it('accepts the nulls the free feed uses for unmeasured fields and rows', async () => {
    const { fetch } = pagedFetch({
      1: {
        data: [
          {
            slug: 'nulls',
            id: null,
            name: null,
            evaluations: {
              artificial_analysis_intelligence_index: 42,
              artificial_analysis_intelligence_index_version: null,
            },
          },
          { slug: 'unmeasured', evaluations: null },
          null,
        ],
      },
    })
    const { models } = await requestAaModels('key', fetch)
    assert.deepEqual(
      models.map((m) => m.slug),
      ['nulls', 'unmeasured'],
    )
  })

  it('fails loudly on a 410, naming the retirement rather than the key', async () => {
    const fetch = (async () =>
      new Response('', { status: 410, statusText: 'Gone' })) as typeof globalThis.fetch
    await assert.rejects(requestAaModels('key', fetch), /410.*retired/s)
  })
})

describe('detectPayloadVersion', () => {
  it('finds and normalises a declared version at payload, metadata, or model level', () => {
    assert.equal(detectPayloadVersion({ version: 4.2 }, []), 'v4.2')
    assert.equal(detectPayloadVersion({ metadata: { index_version: 'v4.3' } }, []), 'v4.3')
    assert.equal(
      detectPayloadVersion({}, [
        { evaluations: { artificial_analysis_intelligence_index_version: '4.1' } },
      ]),
      'v4.1',
    )
  })

  it('returns undefined when no version field is present (caller defaults to canonical)', () => {
    assert.equal(detectPayloadVersion({}, [{ slug: 'x', evaluations: {} }]), undefined)
  })
})

/**
 * This module is both a library and a CLI, and importing it must not run the
 * CLI. `main()` used to be called at module scope, so merely importing it here
 * ran the whole sync on every unit run: a network fetch to Artificial Analysis,
 * then a rewrite of `data/intellect.json` and of the tracked
 * `model-intellect.generated.ts` via `prettier --write`. A green `npm run check`
 * left the working tree dirty, and the bumped `// Last synced:` line went on to
 * collide with the scheduled sync in a real merge conflict.
 */
describe('CLI entry guard', () => {
  const source = readFileSync(resolve('scripts/sync-intellect.mts'), 'utf8')

  it('never calls main() at module scope', () => {
    assert.doesNotMatch(
      source,
      /^main\(\)/m,
      'importing this module would run the sync — network calls and tracked-file writes',
    )
  })

  it('guards the entry on argv[1] being this script', () => {
    assert.match(source, /process\.argv\[1\]\?\.endsWith\('sync-intellect\.mts'\)/)
  })

  it('leaves the generated file alone when merely imported', () => {
    // Compare the file around a fresh import. Comparing with HEAD is invalid in
    // the scheduled workflow because the sync is deliberately uncommitted when
    // validation runs.
    const generatedPath = resolve('packages/llm/src/model-intellect.generated.ts')
    const before = readFileSync(generatedPath, 'utf8')
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', "await import('./scripts/sync-intellect.mts')"],
      { cwd: resolve('.'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
    const after = readFileSync(generatedPath, 'utf8')
    assert.equal(after, before, 'importing the module must not rewrite the generated file')
  })
})

describe('sync-intellect workflow', () => {
  const workflow = readFileSync(resolve('.github/workflows/sync-intellect.yml'), 'utf8')

  it('runs the API refresh on a schedule or by hand with the required secret', () => {
    assert.match(workflow, /schedule:/)
    assert.match(workflow, /workflow_dispatch:/)
    assert.match(
      workflow,
      /ARTIFICIAL_ANALYSIS_API_KEY: \$\{\{ secrets\.ARTIFICIAL_ANALYSIS_API_KEY \}\}/,
    )
    assert.match(workflow, /run: npm run sync:intellect -- --from-api/)
  })

  it('opens a review PR before propagating validation failures', () => {
    const validate = workflow.indexOf('run: npm run check')
    const pullRequest = workflow.indexOf('uses: peter-evans/create-pull-request@v8')
    const propagateFailure = workflow.indexOf("steps.validate.outcome == 'failure'")
    assert.ok(validate >= 0 && pullRequest > validate)
    assert.ok(propagateFailure > pullRequest)
    assert.match(workflow, /id: validate\s+continue-on-error: true/)
    assert.match(workflow, /token: \$\{\{ secrets\.SYNC_PR_TOKEN \}\}/)
    assert.match(workflow, /branch: chore\/sync-intellect/)
  })
})
