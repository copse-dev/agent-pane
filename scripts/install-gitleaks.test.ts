import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { z } from 'zod'

const workflow = z
  .object({
    jobs: z.object({
      precheck: z.object({
        steps: z.array(
          z.object({
            name: z.string().optional(),
            if: z.string().optional(),
            run: z.string().optional(),
            env: z.unknown().optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/ci.yml', 'utf8')))
const install = workflow.jobs.precheck.steps.find(
  (step) => step.name === 'Install pinned gitleaks CLI',
)
const scan = workflow.jobs.precheck.steps.find(
  (step) => step.name === 'Scan repository history for secrets',
)
assert.ok(install?.run)
assert.ok(scan?.run)
const installScript = install.run
const scanScript = scan.run
const pins = z
  .object({ GITLEAKS_VERSION: z.string(), GITLEAKS_LINUX_X64_SHA256: z.string() })
  .parse(install.env)

// Replace only external command boundaries. Execute the actual workflow step,
// including its installer, so the tests also run against the former inline step.
const commandStub = String.raw`
const assert = require('node:assert/strict')
const { appendFileSync, chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const command = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.FIXTURE_LOG, command + '\t' + args.join('\t') + '\n')
const archive = join(process.env.RUNNER_TEMP, 'gitleaks_8.30.1_linux_x64.tar.gz')
switch (command) {
  case 'curl': {
    const direct = args.includes('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz')
    if (!direct) {
      assert.equal(args.at(-1), 'https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058')
      assert.ok(args.includes('Accept: application/octet-stream'))
    }
    assert.ok(args.includes('--location'))
    assert.ok(args.every((arg) => !/authorization/i.test(arg)))
    assert.ok(!args.includes('fixture-token-must-not-be-logged'))
    assert.equal(args[args.indexOf('--output') + 1], archive)
    const state = direct ? process.env.FIXTURE_DIRECT : process.env.FIXTURE_API
    if (state !== 'missing') writeFileSync(archive, state === 'ok' ? 'verified fixture archive' : 'partial or corrupt')
    process.exit(state === 'fail' ? 22 : 0)
  }
  case 'sha256sum':
    assert.deepEqual(args, ['--check', '--strict'])
    assert.equal(readFileSync(0, 'utf8'), '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  ' + archive + '\n')
    process.exit(existsSync(archive) && readFileSync(archive, 'utf8') === 'verified fixture archive' ? 0 : 1)
  case 'tar':
    assert.deepEqual(args, ['-xzf', archive, '-C', process.env.RUNNER_TEMP, 'gitleaks'])
    copyFileSync(process.argv[1], join(process.env.RUNNER_TEMP, 'gitleaks'))
    chmodSync(join(process.env.RUNNER_TEMP, 'gitleaks'), 0o755)
    break
  case 'gitleaks':
    assert.deepEqual(args, ['version'])
    process.stdout.write('8.30.1\n')
    break
  default:
    throw new Error('Unexpected fixture command ' + command)
}
`

type DownloadState = 'ok' | 'fail' | 'corrupt' | 'missing'

interface InstallResult {
  result: SpawnSyncReturns<string>
  events: string[]
  commands: string[]
}

function runInstall(direct: DownloadState, api: DownloadState = 'ok'): InstallResult {
  const directory = mkdtempSync(join(tmpdir(), 'install-gitleaks-'))
  const binaryDirectory = join(directory, 'bin')
  const runnerDirectory = join(directory, 'runner')
  const eventLog = join(directory, 'events')
  mkdirSync(binaryDirectory)
  mkdirSync(runnerDirectory)
  writeFileSync(eventLog, '')
  try {
    for (const command of ['curl', 'sha256sum', 'tar']) {
      writeFileSync(join(binaryDirectory, command), `#!${process.execPath}\n${commandStub}`, {
        mode: 0o755,
      })
    }
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', installScript], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        ...pins,
        PATH: `${binaryDirectory}${delimiter}${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: runnerDirectory,
        GH_TOKEN: 'fixture-token-must-not-be-logged',
        FIXTURE_LOG: eventLog,
        FIXTURE_DIRECT: direct,
        FIXTURE_API: api,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    const events = readFileSync(eventLog, 'utf8').trim().split('\n')
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-token-must-not-be-logged/)
    return { result, events, commands: events.map((line) => line.split('\t')[0] ?? '') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('pinned Gitleaks installer', () => {
  it('uses a successful direct download without an API request and verifies before extraction', () => {
    const run = runInstall('ok')
    assert.equal(run.result.status, 0, run.result.stderr)
    assert.deepEqual(run.commands, ['curl', 'sha256sum', 'tar', 'gitleaks'])
  })

  it('replaces a failed partial direct download with the same official API asset', () => {
    const run = runInstall('fail')
    assert.equal(run.result.status, 0, run.result.stderr)
    assert.deepEqual(run.commands, ['curl', 'curl', 'sha256sum', 'tar', 'gitleaks'])
    for (const event of run.events.filter((line) => line.startsWith('curl\t'))) {
      assert.match(event, /--connect-timeout\t10\t--max-time\t30/)
      assert.match(event, /--retry-max-time\t60/)
    }
  })

  it('fails closed when both download routes fail', () => {
    const run = runInstall('fail', 'fail')
    assert.notEqual(run.result.status, 0)
    assert.deepEqual(run.commands, ['curl', 'curl'])
  })

  for (const direct of ['ok', 'fail'] as const) {
    it(`rejects a corrupt ${direct === 'ok' ? 'direct' : 'API'} archive before extraction`, () => {
      const run = runInstall(direct === 'ok' ? 'corrupt' : 'fail', 'corrupt')
      assert.notEqual(run.result.status, 0)
      assert.ok(run.commands.includes('sha256sum'))
      assert.ok(!run.commands.includes('tar'))
      assert.ok(!run.commands.includes('gitleaks'))
    })
  }

  it('fails closed when a successful command does not produce an archive', () => {
    const run = runInstall('missing')
    assert.notEqual(run.result.status, 0)
    assert.deepEqual(run.commands, ['curl', 'sha256sum'])
  })

  it('retains the version, checksum and same-repository or queue secret-scan guard', () => {
    assert.deepEqual(pins, {
      GITLEAKS_VERSION: '8.30.1',
      GITLEAKS_LINUX_X64_SHA256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    })
    const guard =
      "github.event_name == 'merge_group' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)"
    assert.equal(install.if, guard)
    assert.equal(scan.if, guard)
    assert.match(scanScript, /--log-opts="--full-history --diff-filter=tuxdb HEAD" \./)
  })
})
