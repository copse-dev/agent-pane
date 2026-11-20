import assert from 'node:assert/strict'
import childProcess, {
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { promisify } from 'node:util'

const realExecFile = childProcess.execFile
const execute = promisify(realExecFile)
const children: ChildProcess[] = []
const requests: { args: readonly string[]; timeout: number | undefined }[] = []
const nativeFailures: unknown[] = []
let shortDeadline = false
let bin = ''
let originalPath: string | undefined
let signInToClaude: typeof import('./claude-sign-in.ts').signInToClaude

/** Only the external-process deadline changes; each attempt still spawns and reaps a real child. */
async function runFixture(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  assert.equal(file, 'claude')
  assert.equal(options.cwd, homedir())
  assert.equal(options.encoding, 'utf8')
  requests.push({ args, timeout: options.timeout })
  const running = execute(file, args, {
    ...options,
    ...(shortDeadline ? { timeout: 500 } : {}),
  })
  children.push(running.child)
  try {
    return await running
  } catch (error) {
    nativeFailures.push(error)
    throw error
  }
}

function installFixture(mode: string): void {
  writeFileSync(join(bin, 'mode'), mode)
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const directory = path.dirname(process.argv[1])
const mode = fs.readFileSync(path.join(directory, 'mode'), 'utf8')
const command = process.argv[3]
fs.appendFileSync(path.join(directory, 'calls'), command + '\\n')
if (command === 'login' && mode === 'nonzero') process.exit(19)
if (command === 'login' && mode === 'cancel') process.kill(process.pid, 'SIGTERM')
if (command === 'status' && mode === 'status-failure') process.exit(23)
if ((command === 'login' && mode === 'login-timeout') ||
    (command === 'status' && mode === 'status-timeout')) {
  setInterval(() => {}, 1000)
} else if (command === 'status') {
  process.stdout.write(mode === 'invalid-status' ? '{broken' :
    JSON.stringify({ authMethod: mode === 'api-key' ? 'api_key' : 'claude.ai' }))
}
`,
    { mode: 0o755 },
  )
}

async function retrySuccessfully(): Promise<void> {
  shortDeadline = false
  installFixture('success')
  assert.deepEqual(await signInToClaude(), { ok: true })
  assert.deepEqual(
    requests.slice(-2).map((request) => request.args),
    [
      ['auth', 'login'],
      ['auth', 'status'],
    ],
  )
}

const FAILED = {
  ok: false,
  error: 'Claude sign-in did not complete. Try again, or run claude auth login in a terminal.',
}
const NOT_SUBSCRIPTION = {
  ok: false,
  error: 'Claude is using an API key or token, not a Claude subscription sign-in.',
}

// These executable fixtures use POSIX shebangs, like the owning Electron auth spec.
describe('Claude sign-in process boundary', { skip: process.platform === 'win32' }, () => {
  before(async () => {
    // Keep the existing execFile boundary and its promisified stdout/stderr contract.
    childProcess.execFile = new Proxy(realExecFile.bind(childProcess), {
      get(target, property, receiver): unknown {
        return property === promisify.custom ? runFixture : Reflect.get(target, property, receiver)
      },
    })
    syncBuiltinESMExports()
    ;({ signInToClaude } = await import('./claude-sign-in.ts'))
  })

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'copse-claude-auth-test-'))
    originalPath = process.env['PATH']
    // A controlled PATH cannot fall through to an installed provider CLI.
    process.env['PATH'] = bin
    shortDeadline = false
    requests.length = 0
    nativeFailures.length = 0
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = originalPath
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(bin, { recursive: true, force: true })
  })

  after(() => {
    childProcess.execFile = realExecFile
    syncBuiltinESMExports()
  })

  it('reports a missing CLI and permits a successful new attempt', async () => {
    assert.deepEqual(await signInToClaude(), {
      ok: false,
      error: 'Claude Code is not installed or is not on Copse’s PATH.',
    })
    assert.equal(requests.length, 1)
    await retrySuccessfully()
  })

  for (const mode of ['nonzero', 'cancel', 'status-failure']) {
    it(`reports ${mode} and releases the pending attempt for retry`, async () => {
      installFixture(mode)
      assert.deepEqual(await signInToClaude(), FAILED)
      assert.deepEqual(
        readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n'),
        mode === 'status-failure' ? ['login', 'status'] : ['login'],
      )
      assert.equal(nativeFailures.length, 1)
      if (mode === 'cancel') {
        const failure = nativeFailures[0]
        assert.ok(failure instanceof Error && 'signal' in failure)
        assert.equal(failure.signal, 'SIGTERM')
      }
      await retrySuccessfully()
    })
  }

  for (const mode of ['api-key', 'invalid-status']) {
    it(`rejects ${mode} authentication status and permits a subscription retry`, async () => {
      installFixture(mode)
      assert.deepEqual(await signInToClaude(), NOT_SUBSCRIPTION)
      assert.equal(nativeFailures.length, 0)
      await retrySuccessfully()
    })
  }

  for (const phase of ['login', 'status']) {
    it(`bounds ${phase}, reaps its timed-out child and permits retry`, async () => {
      installFixture(`${phase}-timeout`)
      shortDeadline = true
      const pending = signInToClaude()
      assert.equal(signInToClaude(), pending, 'simultaneous clicks must share one attempt')
      assert.deepEqual(await pending, FAILED)
      assert.deepEqual(
        requests.map((request) => request.timeout),
        phase === 'login' ? [300_000] : [300_000, 10_000],
      )
      const failure = nativeFailures[0]
      assert.ok(failure instanceof Error && 'killed' in failure && 'signal' in failure)
      assert.equal(failure.killed, true)
      assert.equal(failure.signal, 'SIGTERM')
      assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null))
      await retrySuccessfully()
    })
  }
})
