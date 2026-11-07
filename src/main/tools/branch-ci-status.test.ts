import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { getCiStatusTool } from './github-ci-tools.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { setGhAvailableForTest, setGitAvailableForTest } from '../services/tool-availability.ts'

const SHA = 'a'.repeat(40)
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') process.exit(0);
const fixture = JSON.parse(fs.readFileSync('.ci-fixture.json', 'utf8'));
fs.appendFileSync('.ci-calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  if (fixture.prOpen || fixture.prClosed) {
    process.stdout.write(JSON.stringify({state: fixture.prClosed ? 'CLOSED' : 'OPEN', number: 42, title: 'Feature',
      url: 'https://github.com/o/r/pull/42', headRefName: 'feature', headRefOid: fixture.sha}));
    process.exit(0);
  }
  process.stderr.write(fixture.prError || 'no pull requests found for branch "main"');
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  process.stdout.write(JSON.stringify([{name: 'unit', state: 'SUCCESS', bucket: 'pass'}]));
  process.exit(0);
}
if (args[0] === 'api') {
  if (fixture.tipError) { process.stderr.write(fixture.tipError); process.exit(1); }
  process.stdout.write(fixture.sha);
}
else if (args[0] === 'run' && args[1] === 'list') {
  if (fixture.runError) { process.stderr.write(fixture.runError); process.exit(1); }
  process.stdout.write(JSON.stringify(fixture.runs));
}
else process.exit(2);
`

describe('native branch CI status', { skip: process.platform === 'win32' }, () => {
  let root = ''
  let bin = ''
  const previousPath = process.env['PATH']
  const previousPreserve = process.env['COPSE_PRESERVE_PATH']

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'copse-branch-ci-')))
    bin = await realpath(await mkdtemp(join(tmpdir(), 'copse-branch-ci-gh-')))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'Initial',
      ],
      { cwd: root },
    )
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`
    process.env['COPSE_PRESERVE_PATH'] = '1'
    setGhAvailableForTest(true)
    setGitAvailableForTest(true)
  })

  after(async () => {
    if (previousPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = previousPath
    if (previousPreserve === undefined) delete process.env['COPSE_PRESERVE_PATH']
    else process.env['COPSE_PRESERVE_PATH'] = previousPreserve
    setGhAvailableForTest(null)
    setGitAvailableForTest(null)
    for (const dir of [root, bin]) if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function fixture(
    options: {
      prError?: string
      prOpen?: boolean
      prClosed?: boolean
      sha?: string
      runs?: unknown
      tipError?: string
      runError?: string
    } = {},
  ): Promise<void> {
    await writeFile(join(root, '.ci-calls.jsonl'), '')
    await writeFile(
      join(root, '.ci-fixture.json'),
      JSON.stringify({
        sha: SHA,
        runs: [
          {
            databaseId: 123,
            workflowDatabaseId: 456,
            workflowName: 'CI',
            headBranch: 'main',
            headSha: SHA,
            event: 'push',
            status: 'in_progress',
            conclusion: '',
            url: 'https://github.com/o/r/actions/runs/123',
          },
        ],
        ...options,
      }),
    )
  }

  async function status(args: unknown): Promise<unknown> {
    const result = await runWithThreadExecutionContext(
      {
        projectId: 'branch-ci',
        threadId: 'read-only',
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: 'main',
      },
      () =>
        getCiStatusTool.execute(
          getCiStatusTool.parameters.parse(args),
          new AbortController().signal,
        ),
    )
    assert.ok(typeof result === 'string')
    return JSON.parse(result)
  }

  it('falls back to pending push-workflow evidence at the remote tip when no PR is open', async () => {
    await fixture()
    const result = await status({})
    assert.partialDeepStrictEqual(result, {
      scope: 'branch_push_workflows',
      branch: 'main',
      headSha: SHA,
      overall: 'pending',
      latestRunId: 123,
    })
    const calls = await readFile(join(root, '.ci-calls.jsonl'), 'utf8')
    assert.match(calls, /commits\/main/)
    assert.match(calls, new RegExp(`"--commit","${SHA}"`))
    assert.match(calls, /"--event","push"/)
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
      'main',
    )
  })

  it('keeps explicit PR and authentication failures as errors', async () => {
    await fixture()
    await assert.rejects(status({ pr_number: 42 }), /no pull requests/)
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"api"/)
    await fixture({ prError: 'authentication failed: login required' })
    await assert.rejects(status({}), /authentication failed/)
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"api"/)
  })

  it('lets explicit branch selection bypass PR discovery and rejects mixed selectors', async () => {
    assert.equal(
      getCiStatusTool.parameters.safeParse({ branch: 'main', pr_number: 42 }).success,
      false,
    )
    await fixture()
    assert.partialDeepStrictEqual(await status({ branch: 'main' }), {
      scope: 'branch_push_workflows',
      overall: 'pending',
    })
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"pr","view"/)
  })

  it('preserves the existing open-PR path without asking for branch workflows', async () => {
    await fixture({ prOpen: true })
    assert.partialDeepStrictEqual(await status({ pr_number: 42 }), {
      prNumber: 42,
      overall: 'success',
    })
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"api"|"--event"/)
  })

  it('rejects an invalid remote tip before requesting runs', async () => {
    await fixture({ sha: 'invalid' })
    await assert.rejects(status({ branch: 'main' }), /valid remote tip SHA/)
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"run","list"/)
  })

  it('keeps missing or malformed remote evidence as errors rather than green CI', async () => {
    for (const options of [
      { tipError: 'remote tip unavailable' },
      { runError: 'workflow read unavailable' },
      { runs: { unexpected: true } },
    ]) {
      await fixture(options)
      await assert.rejects(status({ branch: 'main' }), /unavailable|invalid workflow evidence/)
    }
  })

  it('uses branch evidence for an implicit closed PR while preserving explicit closed-PR semantics', async () => {
    await fixture({ prClosed: true })
    assert.partialDeepStrictEqual(await status({}), {
      scope: 'branch_push_workflows',
      overall: 'pending',
    })
    await fixture({ prClosed: true })
    assert.partialDeepStrictEqual(await status({ pr_number: 42 }), {
      prNumber: 42,
      overall: 'no_checks',
    })
    assert.doesNotMatch(await readFile(join(root, '.ci-calls.jsonl'), 'utf8'), /"api"/)
  })
})
