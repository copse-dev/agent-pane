import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  EXPIRY_WARNING_DAYS,
  assessPublicationWindow,
  latestSuccessfulRun,
  parseReleaseRuns,
  parseRunArtifacts,
  publishedArtifactNames,
  reportPublicationWindow,
  type PublicationWindow,
  type ReleaseRun,
  type RunArtifact,
} from './release-publication-window.mts'

// v0.1.0-beta.16: Release (macOS) run 40298745227 succeeded at this commit on
// 2026-10-26, was never published, and its artifacts expired around 2026-11-25.
const sha = 'f08bdb9d604c3ae9a441316d70498d9e9d483332'
const otherSha = 'a'.repeat(40)
const tag = 'v0.1.0-beta.16'
const DAY_MS = 86_400_000

function run(overrides: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: 40298745227,
    headSha: sha,
    path: '.github/workflows/release-mac.yml',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-10-26T09:20:11Z',
    url: 'https://github.com/copse-dev/agent-pane/actions/runs/40298745227',
    ...overrides,
  }
}

/** The three artifacts publication downloads, as GitHub lists them while they last. */
function liveArtifacts(expiresAt = '2026-11-25T09:58:00Z'): RunArtifact[] {
  return publishedArtifactNames(sha).map((name) => ({ name, expired: false, expiresAt }))
}

function assess(
  now: string,
  artifacts: RunArtifact[] = liveArtifacts(),
  runs: ReleaseRun[] = [run()],
): PublicationWindow {
  return assessPublicationWindow({ releaseSha: sha, runs, artifacts, now: new Date(now) })
}

describe('parseReleaseRuns and parseRunArtifacts', () => {
  it('reads the REST fields from a page or from paginated, slurped pages', () => {
    const page = {
      total_count: 1,
      workflow_runs: [
        {
          id: 40298745227,
          status: 'completed',
          conclusion: 'success',
          head_sha: sha,
          head_branch: tag,
          path: '.github/workflows/release-mac.yml',
          html_url: run().url,
          created_at: '2026-10-26T09:20:11Z',
        },
      ],
    }
    assert.deepEqual(parseReleaseRuns(page), [run()])
    assert.deepEqual(parseReleaseRuns([page, { workflow_runs: [] }]), [run()])
    const artifact = {
      name: 'copse-macos-x-arm64',
      expired: false,
      expires_at: '2026-11-25T09:58:00Z',
      size_in_bytes: 1,
    }
    assert.deepEqual(parseRunArtifacts([{ total_count: 1, artifacts: [artifact] }]), [
      { name: 'copse-macos-x-arm64', expired: false, expiresAt: '2026-11-25T09:58:00Z' },
    ])
  })

  it('rejects a listing it cannot trust rather than reading it as empty', () => {
    assert.throws(() => parseReleaseRuns({ message: 'Not Found' }), /workflow_runs must be/)
    assert.throws(() => parseRunArtifacts([{ artifacts: [{ name: 'x', expired: 'no' }] }]))
    assert.throws(
      () => parseRunArtifacts({ artifacts: [{ name: 'x', expired: false, expires_at: 'soon' }] }),
      /not a time/,
    )
  })
})

describe('latestSuccessfulRun', () => {
  it('accepts only a successful Release (macOS) run of exactly this commit', () => {
    assert.equal(latestSuccessfulRun([run()], sha)?.id, 40298745227)
    assert.equal(latestSuccessfulRun([run({ headSha: otherSha })], sha), null)
    assert.equal(latestSuccessfulRun([run({ path: '.github/workflows/ci.yml' })], sha), null)
    assert.equal(latestSuccessfulRun([run({ conclusion: 'failure' })], sha), null)
    assert.equal(latestSuccessfulRun([run({ status: 'in_progress', conclusion: null })], sha), null)
  })

  it('prefers the newest of several, whose artifacts last longest', () => {
    const later = run({ id: 40398745227, createdAt: '2026-11-02T09:00:00Z' })
    assert.equal(latestSuccessfulRun([run(), later, run({ id: 1 })], sha)?.id, later.id)
  })
})

describe('assessPublicationWindow', () => {
  it('reports untagged, still-building and never-built versions before any expiry', () => {
    assert.deepEqual(
      assessPublicationWindow({ releaseSha: null, runs: [], artifacts: [], now: new Date() }),
      { state: 'untagged' },
    )
    const going = run({ status: 'in_progress', conclusion: null })
    assert.equal(
      assess('2026-10-26T09:30:00Z', [], [run({ conclusion: 'failure' }), going]).state,
      'building',
    )
    const failed = run({ conclusion: 'cancelled' })
    assert.deepEqual(assess('2026-10-27T00:00:00Z', [], [failed]), {
      state: 'unbuilt',
      run: failed,
    })
    assert.deepEqual(assess('2026-10-27T00:00:00Z', [], []), { state: 'unbuilt', run: null })
  })

  it('warns on the bump runs within the threshold of beta.16 expiring, then reports it expired', () => {
    // The Monday bumps that skipped while beta.16 sat unpublished.
    assert.equal(assess('2026-11-02T05:37:00Z').state, 'open')
    assert.equal(assess('2026-11-09T05:37:00Z').state, 'open')
    assert.equal(assess('2026-11-16T05:37:00Z').state, 'closing')
    assert.equal(assess('2026-11-23T05:37:00Z').state, 'closing')
    // GitHub no longer lists the run's artifacts at all.
    assert.deepEqual(assess('2026-11-30T05:37:00Z', []), {
      state: 'expired',
      run: run(),
      expiresAt: new Date(Date.parse('2026-10-26T09:20:11Z') + 30 * DAY_MS),
      estimated: true,
    })
  })

  it('first warns with over a week left, and again in the last week, at any weekly offset', () => {
    // The bump checks once a week, at some offset from when the build's
    // artifacts expire. Simulate every hourly offset: the earliest check that
    // warns must leave more than a week, and a later check must warn again.
    const expiry = Date.parse('2026-11-25T09:58:00Z')
    const warnings = (warningDays: number): number[][] =>
      Array.from({ length: 7 * 24 }, (_, offsetHours) =>
        [4, 3, 2, 1, 0]
          .map((weeks) => offsetHours * 3_600_000 + weeks * 7 * DAY_MS)
          .filter((left) => {
            const window = assessPublicationWindow({
              releaseSha: sha,
              runs: [run()],
              artifacts: liveArtifacts(),
              now: new Date(expiry - left),
              warningDays,
            })
            return window.state === 'closing'
          }),
      )
    for (const [offsetHours, warned] of warnings(EXPIRY_WARNING_DAYS).entries()) {
      assert.equal(warned.length, 2, `offset ${String(offsetHours)}h`)
      assert.ok((warned[0] ?? 0) >= 7 * DAY_MS, `offset ${String(offsetHours)}h`)
    }
    // The threshold first suggested can first warn with an hour to spare.
    const late = warnings(7).map((warned) => warned[0] ?? Number.POSITIVE_INFINITY)
    assert.ok(Math.min(...late) < 2 * 3_600_000)
  })

  it('closes the window at the first required artifact to expire', () => {
    const [arm64, x64, metadata] = publishedArtifactNames(sha)
    const artifacts: RunArtifact[] = [
      { name: arm64 ?? '', expired: false, expiresAt: '2026-11-25T09:40:00Z' },
      { name: x64 ?? '', expired: false, expiresAt: '2026-11-25T09:45:00Z' },
      { name: metadata ?? '', expired: false, expiresAt: '2026-11-25T09:58:00Z' },
      // Not downloaded by publication, so it does not hold the window open or shut.
      { name: `release-validation-${sha}`, expired: true, expiresAt: '2026-11-01T00:00:00Z' },
    ]
    assert.deepEqual(assess('2026-11-20T00:00:00Z', artifacts), {
      state: 'closing',
      run: run(),
      expiresAt: new Date('2026-11-25T09:40:00Z'),
    })
    assert.equal(assess('2026-11-25T09:41:00Z', artifacts).state, 'expired')
  })

  it('treats a missing or expired required artifact as expired, using the listed time if any', () => {
    const [arm64, x64, metadata] = publishedArtifactNames(sha)
    const expired: RunArtifact[] = [
      { name: arm64 ?? '', expired: true, expiresAt: '2026-11-25T09:40:00Z' },
      { name: x64 ?? '', expired: false, expiresAt: '2026-12-25T00:00:00Z' },
      { name: metadata ?? '', expired: false, expiresAt: '2026-12-25T00:00:00Z' },
    ]
    assert.deepEqual(assess('2026-11-20T00:00:00Z', expired), {
      state: 'expired',
      run: run(),
      expiresAt: new Date('2026-11-25T09:40:00Z'),
      estimated: false,
    })
    // A rerun's fresh copy of the same artifact keeps the window open.
    const rerun: RunArtifact[] = [
      ...expired,
      { name: arm64 ?? '', expired: false, expiresAt: '2026-12-24T00:00:00Z' },
    ]
    assert.deepEqual(assess('2026-11-20T00:00:00Z', rerun), {
      state: 'open',
      run: run(),
      expiresAt: new Date('2026-12-24T00:00:00Z'),
    })
    assert.equal(assess('2026-11-20T00:00:00Z', liveArtifacts().slice(1)).state, 'expired')
  })
})

describe('reportPublicationWindow', () => {
  const now = new Date('2026-11-16T05:37:00Z')

  it('notes an open window with its run and expiry, opening no issue', () => {
    const report = reportPublicationWindow(
      tag,
      assess('2026-11-02T05:37:00Z'),
      new Date('2026-11-02T05:37:00Z'),
    )
    assert.equal(report.level, 'notice')
    assert.equal(report.issue, null)
    assert.match(
      report.message,
      /actions\/runs\/40298745227 before its artifacts expire on 2026-11-25 09:58 UTC \(in 23 days\)/,
    )
  })

  it('opens an issue near expiry that says how to publish or to cut past', () => {
    const report = reportPublicationWindow(tag, assess(now.toISOString()), now)
    assert.equal(report.level, 'warning')
    assert.match(report.message, /expire on 2026-11-25 09:58 UTC \(in 9 days\)/)
    assert.equal(report.issue?.title, 'Release unpublished: v0.1.0-beta.16')
    assert.match(
      report.issue.body,
      /dispatch `Publish release artifacts` with tag `v0\.1\.0-beta\.16` and run ID `40298745227`/,
    )
    assert.match(
      report.issue.body,
      /`Bump release version` with the next version \(for example `0\.1\.0-beta\.17`\)/,
    )
  })

  it('reports expiry as an error that names the documented fix', () => {
    const at = new Date('2026-11-30T05:37:00Z')
    const report = reportPublicationWindow(tag, assess(at.toISOString(), []), at)
    assert.equal(report.level, 'error')
    assert.match(
      report.message,
      /can no longer be published: .* expired around 2026-11-25 09:20 UTC/,
    )
    assert.match(
      report.message,
      /dispatch `Bump release version` with the next version \(for example `0\.1\.0-beta\.17`\), which cuts past v0\.1\.0-beta\.16 and carries its notes forward/,
    )
    assert.equal(report.issue?.title, 'Release unpublished: v0.1.0-beta.16')
    assert.match(report.issue.body, /The schedule does not cut past it by itself/)
  })

  it('counts down in hours on the last day, and suggests the next beta after a stable', () => {
    const window = assess('2026-11-25T03:00:00Z')
    const report = reportPublicationWindow('v0.1.0', window, new Date('2026-11-25T03:00:00Z'))
    assert.match(report.message, /\(in 6 hours\)/)
    assert.match(report.issue?.body ?? '', /for example `0\.1\.1-beta\.1`/)
  })

  it('keeps building and untagged versions quiet, and warns on a build with no success', () => {
    assert.equal(reportPublicationWindow(tag, { state: 'untagged' }, now).level, 'notice')
    const going = run({ status: 'in_progress', conclusion: null })
    assert.equal(
      reportPublicationWindow(tag, { state: 'building', run: going }, now).level,
      'notice',
    )
    const unbuilt = reportPublicationWindow(
      tag,
      { state: 'unbuilt', run: run({ conclusion: 'cancelled' }) },
      now,
    )
    assert.equal(unbuilt.level, 'warning')
    assert.equal(unbuilt.issue, null, 'a failed run already has its own issue')
    assert.match(unbuilt.message, /ended cancelled.*docs\/releasing-macos\.md#failed-releases/)
  })

  it('stays one line, so the workflow annotation carries all of it', () => {
    const windows: PublicationWindow[] = [
      { state: 'untagged' },
      { state: 'unbuilt', run: null },
      assess('2026-11-02T05:37:00Z'),
      assess(now.toISOString()),
      assess('2026-11-30T05:37:00Z', []),
    ]
    for (const window of windows) {
      assert.doesNotMatch(reportPublicationWindow(tag, window, now).message, /[\n\r%]/)
    }
  })

  it('refuses a tag the release channels do not support', () => {
    assert.throws(
      () => reportPublicationWindow('0.1.0', { state: 'untagged' }, now),
      /must start with v/,
    )
    assert.throws(() => reportPublicationWindow('v0.1.0-rc.1', { state: 'untagged' }, now))
  })
})

// Execute the real workflow step against a fake `gh`, so the shell's tag
// lookup, failure handling, issue reuse and exit status are covered too.
const workflowSchema = z.object({
  jobs: z.object({
    'publication-window': z.object({
      steps: z.array(z.object({ name: z.string().optional(), run: z.string().optional() })),
    }),
  }),
})
const workflow = workflowSchema.parse(
  load(readFileSync('.github/workflows/release-bump.yml', 'utf8')),
)
const windowStep = workflow.jobs['publication-window'].steps.find(
  (step) => step.name === 'Check how long the unpublished version can still be published',
)?.run
assert.ok(windowStep)
const step: string = windowStep

const rehearsalSchema = z.object({
  calls: z.array(z.string()),
  issues: z.array(z.object({ number: z.number(), title: z.string(), body: z.string() })),
  comments: z.array(z.object({ number: z.number(), body: z.string() })),
})

interface Rehearsal {
  /** The tag lookup: a commit (lightweight tag), an annotated tag object, a 404, or an outage. */
  tag: 'commit' | 'annotated' | 'missing' | 'outage'
  runs?: unknown[]
  artifacts?: unknown[]
  openIssues?: { number: number; title: string }[]
}

function rehearse(options: Rehearsal): {
  result: SpawnSyncReturns<string>
  state: z.infer<typeof rehearsalSchema>
  summary: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'release-window-'))
  try {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, JSON.stringify({ calls: [], issues: [], comments: [] }))
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ sha, ...options }))
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.REHEARSAL_STATE, 'utf8'))
const fixture = JSON.parse(fs.readFileSync(process.env.REHEARSAL_FIXTURE, 'utf8'))
const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
const save = () => fs.writeFileSync(process.env.REHEARSAL_STATE, JSON.stringify(state))
const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
state.calls.push(args[0] + ' ' + (args[0] === 'api' ? endpoint : args[1]))
save()
if (args[0] === 'api' && endpoint.includes('/git/ref/tags/')) {
  if (fixture.tag === 'missing') { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1) }
  if (fixture.tag === 'outage') { process.stderr.write('gh: Server Error (HTTP 502)'); process.exit(1) }
  const type = fixture.tag === 'annotated' ? 'tag' : 'commit'
  process.stdout.write(JSON.stringify({ object: { type, sha: type === 'tag' ? 'b'.repeat(40) : fixture.sha } }))
} else if (args[0] === 'api' && endpoint.includes('/git/tags/')) {
  process.stdout.write(JSON.stringify({ object: { type: 'commit', sha: fixture.sha } }))
} else if (args[0] === 'api' && endpoint.includes('/actions/workflows/release-mac.yml/runs?head_sha=' + fixture.sha)) {
  process.stdout.write(JSON.stringify([{ workflow_runs: fixture.runs ?? [] }]))
} else if (args[0] === 'api' && /\\/actions\\/runs\\/\\d+\\/artifacts/.test(endpoint)) {
  process.stdout.write(JSON.stringify([{ artifacts: fixture.artifacts ?? [] }]))
} else if (args[0] === 'issue' && args[1] === 'list') {
  if (flag('--label') !== 'area:release' || flag('--state') !== 'open') throw new Error('unexpected issue query')
  process.stdout.write(JSON.stringify(fixture.openIssues ?? []))
} else if (args[0] === 'issue' && args[1] === 'comment') {
  state.comments.push({ number: Number(args[2]), body: fs.readFileSync(flag('--body-file'), 'utf8') })
  save()
} else if (args[0] === 'issue' && args[1] === 'create') {
  if (flag('--label') !== 'area:release') throw new Error('issue must be labelled area:release')
  state.issues.push({ number: 1, title: flag('--title'), body: fs.readFileSync(flag('--body-file'), 'utf8') })
  save()
} else {
  throw new Error('unexpected gh call: ' + args.join(' '))
}
`,
      { mode: 0o755 },
    )
    const summaryPath = join(dir, 'summary.md')
    writeFileSync(summaryPath, '')
    const result = spawnSync('bash', ['-c', step], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REPOSITORY: 'copse-dev/agent-pane',
        REHEARSAL_STATE: statePath,
        REHEARSAL_FIXTURE: join(dir, 'fixture.json'),
        VERSION: tag.slice(1),
        RUN_URL: 'https://github.com/copse-dev/agent-pane/actions/runs/1',
      },
    })
    const state = safeJsonParse(readFileSync(statePath, 'utf8'), decodeWithSchema(rehearsalSchema))
    assert.ok(state, result.stderr)
    return { result, state, summary: readFileSync(summaryPath, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const restRun = {
  id: 40298745227,
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  path: '.github/workflows/release-mac.yml',
  html_url: run().url,
  created_at: '2026-10-26T09:20:11Z',
}

function restArtifacts(fromNowDays: number): unknown[] {
  const expiresAt = new Date(Date.now() + fromNowDays * DAY_MS).toISOString()
  return publishedArtifactNames(sha).map((name) => ({
    name,
    expired: false,
    expires_at: expiresAt,
  }))
}

describe('Bump release version publication-window step', () => {
  it('notes an open window and files nothing', () => {
    const { result, state, summary } = rehearse({
      tag: 'commit',
      runs: [restRun],
      artifacts: restArtifacts(20),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^::notice::v0\.1\.0-beta\.16 is not published\. Publish it from /m)
    assert.match(summary, /before its artifacts expire/)
    assert.deepEqual(state.issues, [])
    assert.deepEqual(state.comments, [])
  })

  it('opens an area:release issue near expiry and passes', () => {
    const { result, state } = rehearse({
      tag: 'commit',
      runs: [restRun],
      artifacts: restArtifacts(5),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^::warning::v0\.1\.0-beta\.16 is still not published/m)
    assert.equal(state.issues.length, 1)
    assert.equal(state.issues[0]?.title, 'Release unpublished: v0.1.0-beta.16')
    assert.match(
      state.issues[0].body,
      /\[Bump release version run\]\(https:\/\/github\.com\/copse-dev\/agent-pane\/actions\/runs\/1\)/,
    )
  })

  it('comments on the open issue rather than opening another, then fails once expired', () => {
    const { result, state } = rehearse({
      tag: 'annotated',
      runs: [restRun],
      artifacts: [],
      openIssues: [
        { number: 41, title: 'Release unpublished: v0.1.0-beta.15' },
        { number: 42, title: 'Release unpublished: v0.1.0-beta.16' },
      ],
    })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^::error::v0\.1\.0-beta\.16's build can no longer be published/m)
    assert.deepEqual(state.issues, [])
    assert.equal(state.comments.length, 1)
    assert.equal(state.comments[0]?.number, 42)
    assert.match(state.comments[0].body, /for example `0\.1\.0-beta\.17`/)
    assert.ok(state.calls.includes('api repos/copse-dev/agent-pane/git/tags/' + 'b'.repeat(40)))
  })

  it('treats a confirmed 404 as untagged, and any other lookup failure as an error', () => {
    const untagged = rehearse({ tag: 'missing' })
    assert.equal(untagged.result.status, 0, untagged.result.stderr)
    assert.match(
      untagged.result.stdout,
      /^::notice::v0\.1\.0-beta\.16 is not published or tagged yet/m,
    )
    assert.deepEqual(untagged.state.calls, [
      'api repos/copse-dev/agent-pane/git/ref/tags/v0.1.0-beta.16',
    ])
    const outage = rehearse({ tag: 'outage' })
    assert.equal(outage.result.status, 1)
    assert.match(outage.result.stdout, /^::error::Could not look up v0\.1\.0-beta\.16.*HTTP 502/m)
    assert.deepEqual(outage.state.issues, [])
  })

  it('does not look for artifacts when no run succeeded', () => {
    const failed = { ...restRun, conclusion: 'failure' }
    const { result, state } = rehearse({ tag: 'commit', runs: [failed] })
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stdout,
      /^::warning::v0\.1\.0-beta\.16 is not published and has no successful/m,
    )
    assert.ok(!state.calls.some((call) => call.includes('/artifacts')))
    assert.deepEqual(state.issues, [])
  })
})
