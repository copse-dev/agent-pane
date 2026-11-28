import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_RENEWAL_CLI_ARGS,
  CLAUDE_RENEWAL_WINDOW_MS,
  claudeLoginRenewalTarget,
  claudeTokenNeedsRenewal,
  renewClaudeLogin,
  renewClaudeLoginAfterRefusal,
  renewClaudeLoginIfDue,
  type ClaudeLoginRenewalDeps,
  type ClaudeLoginRenewalInput,
} from './claude-login-renewal.ts'

const NOW = 1_800_000_000_000
const ADAPTER_BIN = '/opt/copse-test/bin/claude-agent-acp'
const ADAPTER_DIR = '/opt/copse-test/lib/node_modules/@agentclientprotocol/claude-agent-acp'

function input(overrides: Partial<ClaudeLoginRenewalInput> = {}): ClaudeLoginRenewalInput {
  return {
    agent: { id: 'claude-acp', command: 'claude-agent-acp', args: [] },
    sandbox: { allowedDomains: ['anthropic.com'], homeDirs: ['.claude'], allowMacOsKeychain: true },
    localSandboxed: true,
    writableRoots: ['/Users/someone/project'],
    ...overrides,
  }
}

function keychain(expiresAt: number | null): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt } })
}

function deps(overrides: Partial<ClaudeLoginRenewalDeps> = {}): {
  deps: ClaudeLoginRenewalDeps
  runs: { binary: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }[]
} {
  const runs: { binary: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }[] =
    []
  return {
    runs,
    deps: {
      platform: 'darwin',
      resolveBinary: () => Promise.resolve(ADAPTER_BIN),
      findAdapterDir: () => Promise.resolve(ADAPTER_DIR),
      readKeychainCredentials: () => Promise.resolve(keychain(NOW - 1000)),
      run: (binary, args, options): Promise<boolean> => {
        runs.push({ binary, args, env: options.env, cwd: options.cwd })
        return Promise.resolve(true)
      },
      now: () => NOW,
      ...overrides,
    },
  }
}

describe('claudeTokenNeedsRenewal', () => {
  it('matches Claude’s own five-minute renewal window', () => {
    assert.equal(claudeTokenNeedsRenewal(NOW - 1, NOW), true)
    assert.equal(claudeTokenNeedsRenewal(NOW + CLAUDE_RENEWAL_WINDOW_MS, NOW), true)
    assert.equal(claudeTokenNeedsRenewal(NOW + CLAUDE_RENEWAL_WINDOW_MS + 1, NOW), false)
    // A bare token carries no expiry and is never renewed.
    assert.equal(claudeTokenNeedsRenewal(null, NOW), false)
  })
})

describe('claudeLoginRenewalTarget', () => {
  it('runs the adapter’s bundled CLI in print mode with nothing of the user’s loaded', async () => {
    const target = await claudeLoginRenewalTarget(
      input({ agent: { id: 'claude-acp', command: 'claude-agent-acp', args: ['--x'] } }),
      deps().deps,
    )
    assert.deepEqual(target, { binary: ADAPTER_BIN, args: ['--x', ...CLAUDE_RENEWAL_CLI_ARGS] })
    const args = target.args
    assert.equal(args[1], '--cli')
    assert.ok(args.includes('--strict-mcp-config'))
    assert.ok(args.includes('--no-session-persistence'))
    // `--bare` skips Keychain reads, which is the whole point here.
    assert.ok(!args.includes('--bare'))
    assert.equal(args[args.indexOf('--tools') + 1], '')
    assert.equal(args[args.indexOf('--setting-sources') + 1], '')
  })

  it('serves only a local sandboxed agent with the Keychain read grant, on macOS', async () => {
    const { deps: d } = deps()
    assert.equal(await claudeLoginRenewalTarget(input(), { ...d, platform: 'linux' }), null)
    assert.equal(await claudeLoginRenewalTarget(input({ localSandboxed: false }), d), null)
    assert.equal(await claudeLoginRenewalTarget(input({ sandbox: undefined }), d), null)
    assert.equal(
      await claudeLoginRenewalTarget(input({ sandbox: { allowedDomains: [] } }), d),
      null,
    )
  })

  it('leaves an agent with its own credential or config dir alone', async () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_EXECUTABLE',
    ]) {
      const target = await claudeLoginRenewalTarget(
        input({ agent: { id: 'claude-acp', command: 'claude-agent-acp', env: { [name]: 'x' } } }),
        deps().deps,
      )
      assert.equal(target, null, name)
    }
  })

  it('needs the claude-agent-acp package, which forwards --cli', async () => {
    const { deps: d } = deps({ findAdapterDir: () => Promise.resolve(null) })
    assert.equal(await claudeLoginRenewalTarget(input(), d), null)
    const { deps: unresolved } = deps({ resolveBinary: () => Promise.resolve(null) })
    assert.equal(await claudeLoginRenewalTarget(input(), unresolved), null)
  })

  // Running a file the sandboxed agent could have replaced, outside the
  // sandbox, would be an escape.
  it('refuses an adapter anywhere the sandboxed agent can write', async () => {
    const cases = [
      { bin: '/Users/someone/project/node_modules/.bin/claude-agent-acp', dir: ADAPTER_DIR },
      { bin: ADAPTER_BIN, dir: '/Users/someone/project/node_modules/claude-agent-acp' },
      { bin: join(homedir(), '.claude', 'bin', 'claude-agent-acp'), dir: ADAPTER_DIR },
      { bin: join(tmpdir(), 'claude-agent-acp'), dir: ADAPTER_DIR },
      { bin: '/tmp/claude-501/claude-agent-acp', dir: ADAPTER_DIR },
    ]
    for (const { bin, dir } of cases) {
      const { deps: d } = deps({
        resolveBinary: () => Promise.resolve(bin),
        findAdapterDir: () => Promise.resolve(dir),
      })
      assert.equal(await claudeLoginRenewalTarget(input(), d), null, `${bin} / ${dir}`)
    }
  })
})

describe('renewClaudeLoginIfDue', () => {
  it('renews before the turn when the token is inside Claude’s window', async () => {
    const { deps: d, runs } = deps()
    assert.equal(await renewClaudeLoginIfDue(input(), d), true)
    assert.equal(runs.length, 1)
    const [run] = runs
    assert.ok(run)
    assert.equal(run.binary, ADAPTER_BIN)
    // A throwaway config dir, with the account's default login, lock and item.
    assert.equal(run.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'], '')
    assert.ok(run.env['CLAUDE_CONFIG_DIR']?.startsWith(tmpdir()))
    assert.ok(run.cwd.startsWith(tmpdir()))
  })

  it('does nothing while the token is still good, or when there is no login to read', async () => {
    const fresh = deps({
      readKeychainCredentials: () => Promise.resolve(keychain(NOW + 60 * 60 * 1000)),
    })
    assert.equal(await renewClaudeLoginIfDue(input(), fresh.deps), false)
    assert.equal(fresh.runs.length, 0)
    const none = deps({ readKeychainCredentials: () => Promise.resolve(null) })
    assert.equal(await renewClaudeLoginIfDue(input(), none.deps), false)
    assert.equal(none.runs.length, 0)
  })

  it('reads nothing for an agent it cannot serve', async () => {
    let read = false
    const { deps: d } = deps({
      readKeychainCredentials: () => {
        read = true
        return Promise.resolve(keychain(NOW))
      },
    })
    assert.equal(await renewClaudeLoginIfDue(input({ localSandboxed: false }), d), false)
    assert.equal(read, false)
  })

  it('reports a failed run as not renewed', async () => {
    const { deps: d } = deps({ run: () => Promise.resolve(false) })
    assert.equal(await renewClaudeLoginIfDue(input(), d), false)
  })

  it('shares one run between turns that start together', async () => {
    let release: (ok: boolean) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let runs = 0
    const { deps: d } = deps({
      run: () => {
        runs += 1
        markStarted()
        return new Promise((resolve) => {
          release = resolve
        })
      },
    })
    const target = { binary: ADAPTER_BIN, args: CLAUDE_RENEWAL_CLI_ARGS }
    const first = renewClaudeLogin(target, d)
    const second = renewClaudeLogin(target, d)
    await started
    release(true)
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.equal(runs, 1)
  })
})

describe('renewClaudeLoginAfterRefusal', () => {
  it('renews without checking the expiry Claude already acted on', async () => {
    let read = false
    const { deps: d, runs } = deps({
      readKeychainCredentials: () => {
        read = true
        return Promise.resolve(keychain(NOW + 60 * 60 * 1000))
      },
    })
    assert.equal(await renewClaudeLoginAfterRefusal(input(), d), true)
    assert.equal(runs.length, 1)
    assert.equal(read, false)
  })
})
