import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  acpSshTarget,
  buildRemoteAcpCommand,
  buildRemoteAcpLoginCommand,
  buildRemoteAcpLoginScript,
  buildRemoteEnvPreamble,
  REMOTE_ENV_READ_PREAMBLE,
  canonicalizeRemotePathScript,
  isAcpOverSshEnabled,
  parseCanonicalizedRemotePath,
  parseRemoteAgentProbe,
  parseVersionManagerHits,
  remoteAgentProbeScript,
  remoteNpmInstallScript,
  remoteVersionManagerSearchScript,
  formatRemoteAcpInstallApproval,
} from './acp-ssh-transport.ts'

const REMOTE_ROOT = '/remote/project'

async function setUpSshWorkspace(): Promise<void> {
  await setSetting('sshWorkspaceEnabled', true)
  await setSetting('sshWorkspaceHosts', [
    { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
  ])
  storageSet('activeProjectId', 'p1')
  storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
  setWorkspaceRootForTest(REMOTE_ROOT)
}

describe('acpSshTarget gating', () => {
  beforeEach(async () => {
    await setUpSshWorkspace()
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('returns null when the ACP-over-SSH opt-in is off, even on an SSH workspace', async () => {
    await setSetting('acpOverSshEnabled', false)
    assert.equal(isAcpOverSshEnabled(), false)
    assert.equal(acpSshTarget(REMOTE_ROOT), null)
  })

  it('resolves the remote host + root when the opt-in is on', async () => {
    await setSetting('acpOverSshEnabled', true)
    assert.deepEqual(acpSshTarget(REMOTE_ROOT), { hostId: 'dev', remoteRoot: REMOTE_ROOT })
  })

  it('returns null for a local (non-SSH) cwd even with the opt-in on', async () => {
    await setSetting('acpOverSshEnabled', true)
    assert.equal(acpSshTarget('/some/local/path'), null)
  })

  it('returns null when SSH workspaces themselves are disabled', async () => {
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceEnabled', false)
    // Fails closed: no remote target without the underlying SSH workspace feature.
    assert.equal(acpSshTarget(REMOTE_ROOT), null)
  })
})

describe('buildRemoteAcpCommand', () => {
  it('wraps the agent in cd + sh -c + exec on the remote root, through the login shell', () => {
    const cmd = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
    )
    assert.match(cmd, /^cd '\/remote\/project' && sh -c /)
    // The outer wrapper hands off to the resolved login shell (`-lc`) so PATH
    // resolution matches resolveRemoteAgentPath's preflight. The shell path is
    // nested inside the outer wrapper's own quoting, so its surrounding
    // quotes come back escaped (`'\''`) rather than clean.
    assert.match(cmd, /\/bin\/bash.*-lc/)
    // The agent itself still replaces that login shell in turn (clean signals,
    // accurate PGID) — nested quoting escapes the inner command's own quotes.
    assert.match(cmd, /exec .*claude-code-acp/)
    // The PGID marker is printed before the agent so the remote group is killable.
    assert.match(cmd, /__COPSE_PGID__=/)
  })

  it('never runs the agent under setsid — setsid forks under sshd and orphans stdin', () => {
    // sshd already makes the remote command a session leader, so util-linux
    // `setsid` forks; the parent exits, sshd closes the stdin pipe, and the
    // agent reads EOF and quits before answering `initialize`. This surfaced
    // to users as "ACP connection closed" on every ACP-over-SSH turn.
    const cmd = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
    )
    assert.ok(!cmd.includes('setsid'), 'the ACP agent must keep sshd’s stdin pipe alive')
  })

  it('posix-quotes the command and arguments', () => {
    const cmd = buildRemoteAcpCommand(
      { command: 'my agent', args: ['--flag', 'a b'], cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
    )
    // Assert the *escaped* quotes, not bare presence. The agent command is
    // posix-quoted, then that whole string is posix-quoted again for the
    // login shell, so each original `'` arrives as `'\''`. Matching only the
    // substring `my agent` would still pass with posixQuote removed entirely,
    // which is precisely the word-splitting/injection bug this guards.
    assert.match(cmd, /'\\''my agent'\\''/, 'command with a space stays one quoted word')
    assert.match(cmd, /'\\''a b'\\''/, 'argument with a space stays one quoted word')
  })

  it('injects the probed remote PATH into the spawn env when provided', () => {
    const cmd = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
      '/home/alice/.nvm/versions/node/v22/bin:/usr/bin:/bin',
    )
    // Quoted once for the env prefix, then re-quoted by the outer wrappers.
    assert.ok(
      cmd.includes('PATH='),
      'the captured remote PATH must be re-exported so a version-managed agent resolves',
    )
    assert.ok(cmd.includes('/home/alice/.nvm/versions/node/v22/bin'))
  })

  it('does not inject a PATH override when no remote PATH was captured', () => {
    const cmd = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
      null,
    )
    assert.ok(!cmd.includes('PATH='), 'without a probe result the login shell PATH stands alone')
  })

  it('never forwards local provider secrets to the remote agent', () => {
    const secret = 'sk-should-never-appear'
    const prior = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = secret
    try {
      const cmd = buildRemoteAcpCommand(
        { command: 'claude-code-acp', cwd: REMOTE_ROOT },
        REMOTE_ROOT,
        '/bin/bash',
      )
      assert.ok(!cmd.includes(secret), 'the remote command must not contain local API keys')
      assert.ok(!cmd.includes('ANTHROPIC_API_KEY'), 'no provider key names leak either')
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = prior
    }
  })
})

describe('remote re-auth login terminal command', () => {
  beforeEach(async () => {
    await setUpSshWorkspace()
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
  })

  it('is the bare login command with a missing-CLI guard — never wrapped in ssh', () => {
    const cmd = buildRemoteAcpLoginCommand('claude /login', {
      hostId: 'dev',
      remoteRoot: REMOTE_ROOT,
    })
    assert.ok(cmd)
    assert.ok(cmd.includes('claude /login'))
    assert.ok(cmd.includes('command -v claude'), 'missing-CLI hint guard precedes the login')
    // Regression pin: on an SSH workspace the Shells tab is already a pty on
    // the host. Wrapping this in `ssh -tt …` ran ssh ON the host, nested, with
    // this machine's identity-file and ControlMaster-socket paths — which do
    // not exist there ("Warning: Identity file … not accessible",
    // "unix_listener: cannot bind …: No such file or directory").
    assert.ok(!/\bssh\b/.test(cmd), 'no ssh nesting: the terminal tab is already on the host')
    assert.ok(!cmd.includes('$SHELL'), 'no shell wrapper: the tab shell is already interactive')
  })

  it('returns null when the host is no longer configured', () => {
    assert.equal(
      buildRemoteAcpLoginCommand('claude /login', { hostId: 'ghost', remoteRoot: REMOTE_ROOT }),
      null,
    )
  })

  it('the remote script runs the login command (executed, not string-matched)', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-reauth-'))
    try {
      // Empty HOME so the test exercises the script itself, not this
      // machine's dotfiles.
      const stdout = execFileSync('bash', ['-c', buildRemoteAcpLoginScript('echo LOGIN-RAN')], {
        env: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      assert.ok(stdout.includes('LOGIN-RAN'))
      assert.ok(!stdout.includes('is not installed'), 'no missing-CLI hint when the client exists')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a missing client CLI prints the install hint before the shell error', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-reauth-'))
    try {
      const script = buildRemoteAcpLoginScript('definitely-missing-xyz-cmd /login')
      let stdout = ''
      try {
        stdout = execFileSync('bash', ['-c', script], {
          env: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch (err) {
        if (err instanceof Error && 'stdout' in err && typeof err.stdout === 'string') {
          stdout = err.stdout
        }
      }
      assert.ok(stdout.includes('definitely-missing-xyz-cmd is not installed on this host'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('approved env forwarding (stdin preamble)', () => {
  it('builds one base64 line of export statements, null when there is nothing to forward', () => {
    assert.equal(buildRemoteEnvPreamble(undefined), null)
    assert.equal(buildRemoteEnvPreamble({}), null)
    const line = buildRemoteEnvPreamble({ ANTHROPIC_API_KEY: "sk-w'ei\nrd", B: 'plain' })
    assert.ok(line && !line.includes('\n'), 'must stay a single stdin line')
    const script = Buffer.from(line, 'base64').toString('utf8')
    assert.match(script, /^export ANTHROPIC_API_KEY=/m)
    assert.match(script, /^export B='plain'$/m)
  })

  it('rejects env names that are not shell identifiers instead of interpolating them', () => {
    assert.throws(() => buildRemoteEnvPreamble({ 'evil; rm -rf /': 'x' }), /shell identifier/)
  })

  it('adds the stdin read/eval preamble only when env is forwarded, and never puts values on argv', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-secret-value' }
    const withEnv = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT, env },
      REMOTE_ROOT,
      '/bin/bash',
    )
    const withoutEnv = buildRemoteAcpCommand(
      { command: 'claude-code-acp', cwd: REMOTE_ROOT },
      REMOTE_ROOT,
      '/bin/bash',
    )
    assert.ok(withEnv.includes('__copse_env'), 'forwarded env must arm the stdin read')
    assert.ok(!withoutEnv.includes('__copse_env'), 'no forwarded env, no stdin read')
    // The whole point of the stdin protocol: the value must be absent from the
    // remote command line, where `ps` would show it to other users (zed#38392).
    assert.ok(!withEnv.includes('sk-secret-value'))
    assert.ok(!withEnv.includes('ANTHROPIC_API_KEY'))
  })

  it('the read/eval fragment lands the vars and hands the rest of stdin to the agent intact', () => {
    // Executes the exact fragment buildRemoteAcpCommand emits, driven the way
    // spawnRemoteAcpTransport drives it: preamble line first, JSON-RPC after.
    const preamble = buildRemoteEnvPreamble({ COPSE_TEST_TOKEN: "tok'en value" })
    assert.ok(preamble)
    const agent = `${REMOTE_ENV_READ_PREAMBLE}printf '%s\\n' "$COPSE_TEST_TOKEN"; exec cat`
    const stdout = execFileSync('sh', ['-c', agent], {
      input: `${preamble}\n{"jsonrpc":"2.0","id":1}\n`,
      encoding: 'utf8',
    })
    assert.equal(stdout, `tok'en value\n{"jsonrpc":"2.0","id":1}\n`)
  })

  it('EOF before any preamble still execs the agent (unauthenticated beats never-spawned)', () => {
    const agent = `${REMOTE_ENV_READ_PREAMBLE}printf 'alive %s\\n' "\${COPSE_TEST_TOKEN:-unset}"`
    const stdout = execFileSync('sh', ['-c', agent], { input: '', encoding: 'utf8' })
    assert.equal(stdout, 'alive unset\n')
  })
})

describe('remote agent probe', () => {
  it('reports FOUND with the shell PATH when the agent is on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-probe-'))
    try {
      const bin = join(dir, 'claude-code-acp')
      writeFileSync(bin, '#!/bin/sh\nexit 0\n')
      chmodSync(bin, 0o755)
      const stdout = execFileSync('bash', ['-c', remoteAgentProbeScript('claude-code-acp')], {
        env: { PATH: `${dir}:/usr/bin:/bin` },
        encoding: 'utf8',
      })
      const parsed = parseRemoteAgentProbe(stdout)
      assert.ok(parsed?.found, 'agent on PATH must parse as found')
      assert.ok(parsed.path?.includes(dir), 'the probe must capture the PATH that resolved it')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports MISSING when the agent is absent, even with rc noise on stdout', () => {
    const noisy = `Welcome to devbox!\n${execFileSync(
      'bash',
      ['-c', remoteAgentProbeScript('definitely-not-installed-agent')],
      { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
    )}trailing motd line`
    const parsed = parseRemoteAgentProbe(noisy)
    // MISSING still carries $PATH: it is the base the version-manager search
    // prepends onto when the agent lives under a non-default Node version.
    assert.deepEqual(parsed, { found: false, path: '/usr/bin:/bin' })
  })

  it('returns null when no marker line is present (probe never ran)', () => {
    assert.equal(parseRemoteAgentProbe('bash: some unrelated error\n'), null)
    assert.equal(parseRemoteAgentProbe(''), null)
  })
})

describe('version-manager search (agent under a non-default Node version)', () => {
  it('finds an fnm-installed agent that no login shell PATH exposes', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-fnm-'))
    try {
      // Mirrors the real layout: several versions installed, agent only under
      // the newest, default still pointing at the oldest.
      const versions = ['v18.16.0', 'v20.20.0', 'v22.21.1']
      for (const v of versions) {
        mkdirSync(join(home, '.local/share/fnm/node-versions', v, 'installation/bin'), {
          recursive: true,
        })
      }
      const agentDir = join(home, '.local/share/fnm/node-versions/v22.21.1/installation/bin')
      const bin = join(agentDir, 'claude-agent-acp')
      writeFileSync(bin, '#!/usr/bin/env node\n')
      chmodSync(bin, 0o755)

      const stdout = execFileSync(
        'sh',
        ['-c', remoteVersionManagerSearchScript(), 'sh', 'claude-agent-acp'],
        { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
      )
      assert.deepEqual(parseVersionManagerHits(stdout), [agentDir])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('prefers the newest Node version when the agent is installed under several', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-nvm-'))
    try {
      const dirs = ['v18.16.0', 'v22.21.1', 'v20.20.0'].map((v) =>
        join(home, '.nvm/versions/node', v, 'bin'),
      )
      for (const d of dirs) {
        mkdirSync(d, { recursive: true })
        const bin = join(d, 'claude-agent-acp')
        writeFileSync(bin, '#!/usr/bin/env node\n')
        chmodSync(bin, 0o755)
      }
      const stdout = execFileSync(
        'sh',
        ['-c', remoteVersionManagerSearchScript(), 'sh', 'claude-agent-acp'],
        { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
      )
      const hits = parseVersionManagerHits(stdout)
      assert.ok(hits[0]?.includes('v22.21.1'), `newest must sort first, got ${hits[0] ?? '<none>'}`)
      assert.equal(hits.length, 3)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns nothing (and does not fail) when no version manager holds the agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-none-'))
    try {
      const stdout = execFileSync(
        'sh',
        ['-c', remoteVersionManagerSearchScript(), 'sh', 'claude-agent-acp'],
        { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
      )
      assert.deepEqual(parseVersionManagerHits(stdout), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('remote PATH canonicalization', () => {
  it('resolves per-shell symlink dirs (fnm multishells) to their stable target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-canon-'))
    try {
      const stable = join(dir, 'stable-install', 'bin')
      mkdirSync(stable, { recursive: true })
      const ephemeral = join(dir, '1341661_1788086692301')
      symlinkSync(join(dir, 'stable-install'), ephemeral)
      const input = `${join(ephemeral, 'bin')}:/usr/bin:/bin`
      const stdout = execFileSync('sh', ['-c', canonicalizeRemotePathScript(), 'sh', input], {
        encoding: 'utf8',
      })
      const canon = parseCanonicalizedRemotePath(stdout)
      assert.ok(canon, 'canonicalization must emit a marker line')
      const entries = canon.split(':')
      assert.ok(
        entries[0]?.endsWith(join('stable-install', 'bin')),
        `symlinked entry must resolve to its target, got ${entries[0] ?? '<empty>'}`,
      )
      assert.ok(!canon.includes('1341661_'), 'the ephemeral symlink must not survive')
      assert.ok(entries.includes('/usr/bin') && entries.includes('/bin'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps unresolvable entries as-is and survives rc noise on stdout', () => {
    const input = '/nonexistent-dir-xyz:/bin'
    const stdout = `motd banner\n${execFileSync('sh', ['-c', canonicalizeRemotePathScript(), 'sh', input], { encoding: 'utf8' })}trailing`
    const canon = parseCanonicalizedRemotePath(stdout)
    assert.ok(canon)
    assert.ok(canon.split(':').includes('/nonexistent-dir-xyz'))
  })

  it('returns null when no marker line is present', () => {
    assert.equal(parseCanonicalizedRemotePath('sh: readlink: not found\n'), null)
    assert.equal(parseCanonicalizedRemotePath(''), null)
  })
})

describe('remote adapter install', () => {
  it('installs into the given Node prefix without invoking a version manager', () => {
    const script = remoteNpmInstallScript(
      '@agentclientprotocol/claude-agent-acp',
      '/home/u/.local/share/fnm/node-versions/v22.21.1/installation/bin',
    )
    assert.match(script, /^env PATH='[^']+':"\$PATH" npm install -g --ignore-scripts /)
    assert.ok(script.includes("'@agentclientprotocol/claude-agent-acp'"))
    // Repointing the host default (`fnm default`, `nvm alias default`) is never
    // acceptable on a shared remote — the prefix is selected via PATH instead.
    // (The prefix path itself contains "fnm"; what must be absent is any
    // *invocation* of a version manager.)
    assert.ok(!/(^|\s)(fnm|nvm|asdf|volta)\s/.test(script), script)
    assert.ok(!script.includes('sudo'), 'must never escalate on the remote')
  })

  it('falls back to the login shell npm when no version manager prefix is found', () => {
    const script = remoteNpmInstallScript('@agentclientprotocol/claude-agent-acp', null)
    assert.equal(script, "npm install -g --ignore-scripts '@agentclientprotocol/claude-agent-acp'")
  })

  it('passes the package name to npm as a single literal argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-install-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin, { recursive: true })
      const argvLog = join(dir, 'argv')
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvLog}\n`)
      chmodSync(join(bin, 'npm'), 0o755)
      // The package name comes from the pinned catalog, never from the remote —
      // the quoting is what keeps that guarantee from being one bad edit away.
      const script = remoteNpmInstallScript('evil; rm -rf ~', bin)
      execFileSync('sh', ['-c', script], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
      assert.deepEqual(readFileSync(argvLog, 'utf8').trimEnd().split('\n'), [
        'install',
        '-g',
        '--ignore-scripts',
        'evil; rm -rf ~',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discloses the Socket Firewall gap and the untouched default in the approval', () => {
    const { title, body } = formatRemoteAcpInstallApproval({
      pkg: '@agentclientprotocol/claude-agent-acp',
      hostLabel: 'Dev',
      npmBinDir: '/home/u/.local/share/fnm/node-versions/v22.21.1/installation/bin',
    })
    assert.ok(title.includes('Dev'), 'the host must be named in the title')
    assert.ok(body.includes('@agentclientprotocol/claude-agent-acp'))
    assert.ok(body.includes('v22.21.1'), 'the target Node prefix must be shown')
    assert.ok(body.includes('default Node version unchanged'))
    // The local path installs through Socket Firewall; a remote install cannot.
    // That divergence must be stated, never silently accepted for the user.
    assert.ok(body.includes('Socket Firewall'))
    assert.ok(body.includes('--ignore-scripts'))
  })

  it('describes the login-shell npm when there is no version manager prefix', () => {
    const { body } = formatRemoteAcpInstallApproval({
      pkg: '@agentclientprotocol/claude-agent-acp',
      hostLabel: 'dev.example.com',
      npmBinDir: null,
    })
    assert.ok(body.includes('login shell'))
    assert.ok(!body.includes('default Node version unchanged'))
  })

  it('locates npm across version managers with the same sweep used for the agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-npm-'))
    try {
      const older = join(home, '.local/share/fnm/node-versions/v18.16.0/installation/bin')
      const newer = join(home, '.local/share/fnm/node-versions/v22.21.1/installation/bin')
      for (const dir of [older, newer]) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'npm'), '#!/bin/sh\n')
        chmodSync(join(dir, 'npm'), 0o755)
      }
      const stdout = execFileSync('sh', ['-c', remoteVersionManagerSearchScript(), 'sh', 'npm'], {
        env: { HOME: home, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      })
      // Newest first: the agent needs a newer Node than these hosts default to.
      assert.equal(parseVersionManagerHits(stdout)[0], newer)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
