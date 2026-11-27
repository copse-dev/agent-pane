/**
 * A command contained in the project sandbox never sees the user's tool or
 * cloud credentials: not from ASRT's wrap env (process.env verbatim on POSIX)
 * and not from a caller's overlay, which run_shell builds from process.env.
 * Only a credential the caller selected for that run (`keepCredentialEnv`)
 * reaches it. Outside the sandbox nothing changes: an approved `gh` or `aws`
 * still gets its token.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalExecutionRuntime } from './local-runtime.ts'
import type { ExecutionRuntime, RuntimeExecRequest } from '../services/execution-runtime/runtime.ts'

const CANARIES: Record<string, string> = {
  GITHUB_TOKEN: 'ghp_canary_github_token_value_000000000000',
  GH_TOKEN: 'gho_canary_gh_token_value_00000000000000000',
  AWS_ACCESS_KEY_ID: 'AKIACANARY0000000000',
  AWS_SECRET_ACCESS_KEY: 'canary-aws-secret-access-key-value',
  AWS_SESSION_TOKEN: 'canary-aws-session-token-value',
  NPM_TOKEN: 'npm_canary_token_value',
  GHCR_PAT: 'canary-ghcr-personal-access-token',
  SENTRY_AUTH_TOKEN: 'canary-sentry-auth-token',
}

function runtimeWithWrapEnv(wrapEnv: NodeJS.ProcessEnv, sandboxEnabled = true): ExecutionRuntime {
  return createLocalExecutionRuntime({
    spawn: (file, args, options) => spawn(file, [...args], options),
    wrapWithSandboxArgv: (command) =>
      Promise.resolve({ argv: ['/bin/sh', '-c', command], env: wrapEnv }),
    isSandboxEnabled: () => sandboxEnabled,
    isSpawnableWorkingDirectory: () => Promise.resolve(true),
    releaseSandboxLease: () => {},
  })
}

function done(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', () => {
      resolve(stdout)
    })
  })
}

function request(
  cwd: string,
  commandLine: string,
  overrides: Partial<RuntimeExecRequest> = {},
): RuntimeExecRequest {
  return {
    command: { kind: 'shell', commandLine },
    cwd,
    // run_shell's overlay is a scrubbed copy of process.env, so it carries
    // every tool credential the user exported.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...CANARIES, KEEP_ME: 'plain' },
    stdio: 'pipe',
    local: { sandbox: true, plan: () => ({ config: {} }) },
    ...overrides,
  }
}

describe('contained commands get no inherited credentials', () => {
  it('an env dump written to the workspace holds none of them', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'copse-contained-env-')))
    try {
      const runtime = runtimeWithWrapEnv({ ...CANARIES, HOME: dir })
      const execution = await runtime.exec(request(dir, 'env > ci-debug-env.txt; echo ok'))
      assert.equal((await done(execution.child)).trim(), 'ok')
      const dump = readFileSync(join(dir, 'ci-debug-env.txt'), 'utf8')
      for (const [key, value] of Object.entries(CANARIES)) {
        assert.ok(!dump.includes(value), `${key} reached the contained command`)
      }
      assert.match(dump, /^KEEP_ME=plain$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a token piped from the env into a login is unset', async () => {
    const runtime = runtimeWithWrapEnv(CANARIES)
    const execution = await runtime.exec(
      request(tmpdir(), 'printf "%s" "${GHCR_PAT:-unset}|${GITHUB_TOKEN:-unset}"'),
    )
    assert.equal(await done(execution.child), 'unset|unset')
  })

  it('keeps a credential the caller selected for this run', async () => {
    const runtime = runtimeWithWrapEnv({})
    const execution = await runtime.exec(
      request(tmpdir(), 'printf "%s|%s" "${GH_TOKEN:-unset}" "${GITHUB_TOKEN:-unset}"', {
        local: { sandbox: true, keepCredentialEnv: ['GH_TOKEN'], plan: () => ({ config: {} }) },
      }),
    )
    assert.equal(await done(execution.child), `${CANARIES['GH_TOKEN'] ?? ''}|unset`)
  })

  it('leaves an approved command outside the sandbox its credentials', async () => {
    const runtime = runtimeWithWrapEnv({}, false)
    const execution = await runtime.exec(
      request(tmpdir(), 'printf "%s" "${GITHUB_TOKEN:-unset}"', {
        local: { sandbox: false, plan: () => ({ config: {} }) },
      }),
    )
    assert.equal(await done(execution.child), CANARIES['GITHUB_TOKEN'])
  })
})
