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
      steps: z.array(z.object({ id: z.string().optional(), run: z.string().optional() })),
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

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string(),
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
): { result: SpawnSyncReturns<string>; state: z.infer<typeof stateSchema> } {
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
if (args[0] === 'api' && args.includes('--paginate') && args.includes('--slurp')) {
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
    if (state.refs[ref]) throw new Error('ref already exists')
    state.refs[ref] = sha
    state.mutations.push('create ' + ref)
  } else if (args.includes('DELETE') && endpoint.includes('/git/refs/tags/')) {
    const ref = endpoint.split('/git/refs/tags/')[1]
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
    if (!state.refs[release.tag_name]) throw new Error('original tag must be restored before publication')
    if (!release.prerelease && !args.includes('--latest=false')) state.latest = release.tag_name
  }
  if (args.includes('--latest')) state.latest = release.tag_name
} else {
  throw new Error('unexpected gh call: ' + args.join(' '))
}
fs.writeFileSync(path, JSON.stringify(state))
`,
      { mode: 0o755 },
    )
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: dir,
        REHEARSAL_STATE: statePath,
        RELEASE_REPOSITORY: 'disposable/rehearsal',
        TAG: tag,
        ACTION: action,
      },
    })
    const state = safeJsonParse(readFileSync(statePath, 'utf8'), decodeWithSchema(stateSchema))
    assert.ok(state)
    return { result, state }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Halt release workflow visibility decisions', () => {
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

  it('refuses to resume a release that is already published', () => {
    const { result, state } = run('resume', 'v0.1.0', [release('v0.1.0')], 'v0.1.0')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /is not halted/)
    assert.equal(state.latest, 'v0.1.0')
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
    assert.deepEqual(state.mutations, ['create halted/v0.1.1', 'draft v0.1.1', 'delete v0.1.1'])
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

  it('refuses conflicting original and archived objects before changing the release', () => {
    for (const action of ['halt', 'resume'] as const) {
      const { result, state } = run(
        action,
        'v0.1.0',
        [release('v0.1.0', action === 'resume')],
        null,
        { 'v0.1.0': tagObject, 'halted/v0.1.0': 'b'.repeat(40) },
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /differs from halted/)
      assert.deepEqual(state.mutations, [])
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
})
