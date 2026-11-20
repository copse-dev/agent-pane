import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

const workflowSchema = z.object({
  jobs: z.object({
    change: z.object({
      steps: z.array(
        z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          run: z.string().optional(),
        }),
      ),
    }),
  }),
})
const workflow = workflowSchema.parse(
  load(readFileSync('.github/workflows/release-halt.yml', 'utf8')),
)
const change = workflow.jobs.change.steps.find((step) => step.id === 'change')?.run
assert.ok(change)
// Execute the actual visibility/fallback decisions, stopping before LATEST.md
// bookkeeping (whose Bash 4 case conversion is unrelated to these decisions).
const script = change.slice(0, change.indexOf('\n{\n'))
assert.ok(script.includes('state=promoted') && script.endsWith('fi'))
const recordIssue = workflow.jobs.change.steps.find(
  (step) => step.name === 'Record the change on the tracking issue',
)?.run
assert.ok(recordIssue)

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable(),
  assets: z.array(z.object({ name: z.string() })),
})
const stateSchema = z.object({
  latest: z.string().nullable(),
  releases: z.array(releaseSchema),
  refs: z.record(z.string(), z.string()),
  mutations: z.array(z.string()),
})
type Release = z.infer<typeof releaseSchema>
const tagObject = 'a'.repeat(40)

function release(tag: string, draft = false, prerelease = false): Release {
  return {
    tag_name: tag,
    draft,
    prerelease,
    published_at: '2026-11-07T00:00:00Z',
    assets: [],
  }
}

function run(
  action: 'halt' | 'resume',
  tag: string,
  releases: Release[],
  latest: string | null,
  refs: Record<string, string> = Object.fromEntries(
    releases.map((entry) => [entry.tag_name, tagObject]),
  ),
  failure?: 'archive' | 'withdraw' | 'post-publication-list' | 'latest-selection',
): { result: SpawnSyncReturns<string>; state: z.infer<typeof stateSchema>; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'release-halt-'))
  try {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, JSON.stringify({ releases, latest, refs, mutations: [] }))
    // This boundary models GitHub's observed behavior: publishing a stable
    // draft makes it latest unless make_latest=false is explicitly supplied.
    // Reproduced against a disposable public repository on 2026-11-07.
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const path = process.env.REHEARSAL_STATE
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
const failure = process.env.REHEARSAL_FAILURE
if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
  if (failure === 'post-publication-list' && state.releases.find(r => r.tag_name === process.env.TAG)?.draft === false) {
    process.stderr.write('simulated release listing failure'); process.exit(1)
  }
  process.stdout.write(JSON.stringify([state.releases]))
} else if (args[0] === 'api') {
  const endpoint = args.find(arg => arg.startsWith('repos/'))
  if (endpoint.includes('/git/ref/tags/')) {
    const tag = endpoint.split('/git/ref/tags/')[1]
    if (!state.refs[tag]) { process.stderr.write('HTTP 404'); process.exit(1) }
    process.stdout.write(state.refs[tag])
  } else if (args.includes('POST') && endpoint.endsWith('/git/refs')) {
    const ref = args.find(arg => arg.startsWith('ref=refs/tags/')).slice('ref=refs/tags/'.length)
    const sha = args.find(arg => arg.startsWith('sha=')).slice(4)
    if (failure === 'archive' && ref.startsWith('halted/')) {
      process.stderr.write('simulated archive creation failure'); process.exit(1)
    }
    if (state.refs[ref]) throw new Error('ref already exists')
    state.refs[ref] = sha
    state.mutations.push('create ' + ref)
  } else if (args.includes('DELETE') && endpoint.includes('/git/refs/tags/')) {
    const ref = endpoint.split('/git/refs/tags/')[1]
    if (failure === 'withdraw') {
      process.stderr.write('simulated tag withdrawal failure'); process.exit(1)
    }
    if (!state.refs[ref]) throw new Error('ref does not exist')
    delete state.refs[ref]
    state.mutations.push('delete ' + ref)
  } else { throw new Error('unexpected API call: ' + args.join(' ')) }
} else if (args[0] === 'release' && args[1] === 'edit') {
  const release = state.releases.find(r => r.tag_name === args[2])
  if (!release) throw new Error('missing release')
  if (args.includes('--draft=true')) {
    release.draft = true
    state.mutations.push('draft ' + release.tag_name)
    if (state.latest === release.tag_name) state.latest = null
  }
  if (args.includes('--draft=false')) {
    release.draft = false
    state.mutations.push('publish ' + release.tag_name)
    if (!state.refs[release.tag_name]) throw new Error('original tag must be restored before publication')
    if (!release.prerelease && !args.includes('--latest=false')) state.latest = release.tag_name
  }
  if (args.includes('--latest')) {
    if (failure === 'latest-selection') {
      process.stderr.write('simulated latest selection failure'); process.exit(1)
    }
    state.latest = release.tag_name
  }
} else {
  throw new Error('unexpected gh call: ' + args.join(' '))
}
fs.writeFileSync(path, JSON.stringify(state))
`,
      { mode: 0o755 },
    )
    const summaryPath = join(dir, 'summary.txt')
    const result = spawnSync(
      'bash',
      ['-c', `${script}\nprintf '%s' "$summary" > "$REHEARSAL_SUMMARY"`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          RUNNER_TEMP: dir,
          REHEARSAL_STATE: statePath,
          REHEARSAL_SUMMARY: summaryPath,
          REHEARSAL_FAILURE: failure ?? '',
          RELEASE_REPOSITORY: 'disposable/rehearsal',
          TAG: tag,
          ACTION: action,
        },
      },
    )
    const state = safeJsonParse(readFileSync(statePath, 'utf8'), decodeWithSchema(stateSchema))
    assert.ok(state)
    return { result, state, summary: result.status === 0 ? readFileSync(summaryPath, 'utf8') : '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Halt release workflow visibility decisions', () => {
  it('refuses never-published drafts for both halt and resume', () => {
    for (const action of ['halt', 'resume'] as const) {
      const draft = { ...release('v0.1.1', true), published_at: null }
      const { result, state } = run(action, 'v0.1.1', [release('v0.1.0'), draft], 'v0.1.0')
      assert.equal(result.status, 1)
      assert.match(result.stderr, /has never been published/)
      assert.deepEqual(state.mutations, [])
      assert.deepEqual(state.releases[1], draft)
      assert.equal(state.refs['v0.1.1'], tagObject)
      assert.equal(state.refs['halted/v0.1.1'], undefined)
      assert.equal(state.latest, 'v0.1.0')
    }
  })

  it('resumes an older stable without replacing the newer latest stable', () => {
    const { result, state } = run(
      'resume',
      'v0.1.0',
      [release('v0.1.0', true), release('v0.1.1')],
      'v0.1.1',
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.latest, 'v0.1.1')
    assert.equal(state.releases[0]?.draft, false)
    const retried = run('resume', 'v0.1.0', state.releases, state.latest, state.refs)
    assert.equal(retried.result.status, 0, retried.result.stderr)
    assert.equal(retried.state.latest, 'v0.1.1')
    assert.deepEqual(retried.state.mutations, [])
  })

  it('resumes the newest stable and explicitly restores it as latest', () => {
    const { result, state } = run(
      'resume',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1', true)],
      'v0.1.0',
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.latest, 'v0.1.1')
  })

  it('keeps a resumed stable candidate on the beta channel', () => {
    const { result, state } = run(
      'resume',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1', true, true)],
      'v0.1.0',
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.latest, 'v0.1.0')
    assert.equal(state.releases[1]?.draft, false)
    assert.equal(state.releases[1].prerelease, true)
  })

  it('refuses a published release without both restored refs', () => {
    const refCases: Record<string, string>[] = [
      { 'v0.1.0': tagObject },
      { 'halted/v0.1.0': tagObject },
      {},
    ]
    for (const refs of refCases) {
      const { result, state } = run('resume', 'v0.1.0', [release('v0.1.0')], 'v0.1.0', refs)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /not a restored halted release/)
      assert.equal(state.latest, 'v0.1.0')
      assert.deepEqual(state.mutations, [])
    }
  })

  it('halts the newest stable and restores the previous stable', () => {
    const { result, state } = run(
      'halt',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1')],
      'v0.1.1',
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.latest, 'v0.1.0')
    assert.equal(state.releases[1]?.draft, true)
    assert.equal(state.refs['v0.1.1'], undefined)
    assert.equal(state.refs['halted/v0.1.1'], tagObject)
    assert.deepEqual(state.mutations, ['draft v0.1.1', 'create halted/v0.1.1', 'delete v0.1.1'])
  })

  it('leaves no stable when the first stable is halted', () => {
    const { result, state } = run('halt', 'v0.1.0', [release('v0.1.0')], 'v0.1.0')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.latest, null)
    assert.equal(state.releases[0]?.draft, true)
  })

  it('restores the exact archived Git object before republishing', () => {
    const { result, state } = run(
      'resume',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1', true)],
      'v0.1.0',
      { 'v0.1.0': tagObject, 'halted/v0.1.1': 'b'.repeat(40) },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state.refs['v0.1.1'], 'b'.repeat(40))
    assert.equal(state.refs['halted/v0.1.1'], 'b'.repeat(40))
    assert.equal(state.latest, 'v0.1.1')
  })

  it('preserves conflicting refs, stopping downloads on halt and refusing resume', () => {
    for (const action of ['halt', 'resume'] as const) {
      const { result, state } = run(
        action,
        'v0.1.1',
        [release('v0.1.0'), release('v0.1.1', action === 'resume')],
        action === 'halt' ? 'v0.1.1' : 'v0.1.0',
        { 'v0.1.0': tagObject, 'v0.1.1': tagObject, 'halted/v0.1.1': 'b'.repeat(40) },
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /differs from halted/)
      assert.deepEqual(state.mutations, action === 'halt' ? ['draft v0.1.1'] : [])
      assert.equal(state.releases[1]?.draft, true)
      assert.equal(state.latest, 'v0.1.0')
      assert.equal(state.refs['v0.1.1'], tagObject)
      assert.equal(state.refs['halted/v0.1.1'], 'b'.repeat(40))
    }
  })

  it('can finish an interrupted halt and repeat a completed halt', () => {
    const cases: Record<string, string>[] = [
      { 'v0.1.0': tagObject },
      { 'v0.1.0': tagObject, 'halted/v0.1.0': tagObject },
      { 'halted/v0.1.0': tagObject },
    ]
    for (const refs of cases) {
      const { result, state } = run('halt', 'v0.1.0', [release('v0.1.0', true)], null, refs)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(state.refs['v0.1.0'], undefined)
      assert.equal(state.refs['halted/v0.1.0'], tagObject)
      assert.equal(state.releases[0]?.draft, true)
    }
  })

  it('does not republish when neither the original nor archived Git object exists', () => {
    const { result, state } = run('resume', 'v0.1.0', [release('v0.1.0', true)], null, {})
    assert.equal(result.status, 1)
    assert.match(result.stderr, /No archived Git object/)
    assert.deepEqual(state.mutations, [])
    assert.equal(state.releases[0]?.draft, true)
  })

  it('stops downloads even if archiving fails, then completes the halt on retry', () => {
    const failed = run(
      'halt',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1')],
      'v0.1.1',
      { 'v0.1.0': tagObject, 'v0.1.1': tagObject },
      'archive',
    )
    assert.equal(failed.result.status, 1)
    assert.match(failed.result.stderr, /simulated archive creation failure/)
    assert.equal(failed.state.releases[1]?.draft, true)
    assert.equal(failed.state.latest, 'v0.1.0')
    assert.deepEqual(failed.state.mutations, ['draft v0.1.1'])
    assert.equal(failed.state.refs['v0.1.1'], tagObject)
    assert.equal(failed.state.refs['halted/v0.1.1'], undefined)

    const retried = run(
      'halt',
      'v0.1.1',
      failed.state.releases,
      failed.state.latest,
      failed.state.refs,
    )
    assert.equal(retried.result.status, 0, retried.result.stderr)
    assert.equal(retried.state.latest, 'v0.1.0')
    assert.equal(retried.state.refs['v0.1.1'], undefined)
    assert.equal(retried.state.refs['halted/v0.1.1'], tagObject)
  })

  it('finishes an interrupted resume without republishing, including legacy halts', () => {
    const refCases: Record<string, string>[] = [
      { 'v0.1.0': tagObject, 'halted/v0.1.1': tagObject },
      { 'v0.1.0': tagObject, 'v0.1.1': tagObject },
    ]
    for (const refs of refCases) {
      for (const failure of ['post-publication-list', 'latest-selection'] as const) {
        const failed = run(
          'resume',
          'v0.1.1',
          [release('v0.1.0'), release('v0.1.1', true)],
          'v0.1.0',
          refs,
          failure,
        )
        assert.equal(failed.result.status, 1)
        assert.match(failed.result.stderr, /simulated/)
        assert.equal(failed.state.releases[1]?.draft, false)
        assert.equal(failed.state.latest, 'v0.1.0')

        const retried = run(
          'resume',
          'v0.1.1',
          failed.state.releases,
          failed.state.latest,
          failed.state.refs,
        )
        assert.equal(retried.result.status, 0, retried.result.stderr)
        assert.equal(retried.state.latest, 'v0.1.1')
        assert.deepEqual(retried.state.releases, failed.state.releases)
        assert.deepEqual(retried.state.mutations, [])
        assert.equal(retried.state.refs['v0.1.1'], tagObject)
        assert.equal(retried.state.refs['halted/v0.1.1'], tagObject)
      }
    }
  })

  it('restores stable fallback when tag deletion fails and completes withdrawal on retry', () => {
    const failed = run(
      'halt',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1')],
      'v0.1.1',
      { 'v0.1.0': tagObject, 'v0.1.1': tagObject },
      'withdraw',
    )
    assert.equal(failed.result.status, 1)
    assert.match(failed.result.stderr, /simulated tag withdrawal failure/)
    assert.equal(failed.state.releases[1]?.draft, true)
    assert.equal(failed.state.latest, 'v0.1.0')
    assert.equal(failed.state.refs['v0.1.1'], tagObject)
    assert.equal(failed.state.refs['halted/v0.1.1'], tagObject)
    assert.deepEqual(failed.state.mutations, ['draft v0.1.1', 'create halted/v0.1.1'])
    const retried = run(
      'halt',
      'v0.1.1',
      failed.state.releases,
      failed.state.latest,
      failed.state.refs,
    )
    assert.equal(retried.result.status, 0, retried.result.stderr)
    assert.equal(retried.state.latest, 'v0.1.0')
    assert.equal(retried.state.refs['v0.1.1'], undefined)
    assert.equal(retried.state.refs['halted/v0.1.1'], tagObject)
  })

  it('keeps a legacy halt drafted if its archive cannot be created before resume', () => {
    const refs = { 'v0.1.0': tagObject, 'v0.1.1': tagObject }
    const { result, state } = run(
      'resume',
      'v0.1.1',
      [release('v0.1.0'), release('v0.1.1', true)],
      'v0.1.0',
      refs,
      'archive',
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /simulated archive creation failure/)
    assert.equal(state.releases[1]?.draft, true)
    assert.equal(state.latest, 'v0.1.0')
    assert.deepEqual(state.refs, refs)
    assert.deepEqual(state.mutations, [])
  })
})

describe('Halt release workflow tracking', () => {
  it('describes a published resume retry as a recheck', () => {
    const { result, summary } = run('resume', 'v0.1.0', [release('v0.1.0')], 'v0.1.0', {
      'v0.1.0': tagObject,
      'halted/v0.1.0': tagObject,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(summary, /Restoration of \*\*v0\.1\.0\*\* was rechecked/)
  })

  it('reuses open or closed halt issues on resume and never creates a fresh alert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-halt-issue-'))
    try {
      writeFileSync(
        join(dir, 'gh'),
        `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== 'issue') throw new Error('unexpected gh command')
if (args[1] === 'list') {
  const selectedState = args[args.indexOf('--state') + 1]
  const existing = process.env.REHEARSAL_ISSUE_STATE
  const visible = existing !== 'none' && (selectedState === 'all' || selectedState === existing)
  process.stdout.write(JSON.stringify(visible ? [{ number: 8, title: 'Release halted: v0.1.0' }] : []))
} else if (args[1] === 'comment') {
  fs.appendFileSync(process.env.REHEARSAL_ISSUE_MUTATIONS, 'comment ' + args[2] + '\\n')
} else if (args[1] === 'create') {
  fs.appendFileSync(process.env.REHEARSAL_ISSUE_MUTATIONS, 'create\\n')
} else throw new Error('unexpected issue command')
`,
        { mode: 0o755 },
      )
      for (const action of ['halt', 'resume'] as const) {
        for (const issueState of ['open', 'closed', 'none']) {
          const mutations = join(dir, 'mutations.txt')
          writeFileSync(mutations, '')
          const result: SpawnSyncReturns<string> = spawnSync('bash', ['-c', recordIssue], {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env['PATH'] ?? ''}`,
              ACTION: action,
              TAG: 'v0.1.0',
              REASON: 'Rehearsal',
              GITHUB_ACTOR: 'operator',
              GITHUB_REPOSITORY: 'disposable/rehearsal',
              RUN_URL: 'https://example.test/run',
              REHEARSAL_ISSUE_STATE: issueState,
              REHEARSAL_ISSUE_MUTATIONS: mutations,
            },
          })
          assert.equal(result.status, 0, result.stderr)
          const expected =
            issueState === 'open' || (action === 'resume' && issueState === 'closed')
              ? 'comment 8\n'
              : action === 'halt'
                ? 'create\n'
                : ''
          assert.equal(readFileSync(mutations, 'utf8'), expected, `${action}: ${issueState}`)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
