import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import { globToRegex } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'
import { sensitiveTargetReason } from '@copse/shell-guard/sensitive-paths.ts'
import {
  SANDBOX_READ_APPROVED_FOLDERS_SETTING,
  SANDBOX_READ_PROJECT_FOLDERS_SETTING,
  SANDBOX_READ_WORKSPACE_ONLY_SETTING,
  effectiveSandboxReadPolicy,
} from '@shared/sandbox-read-access.ts'
import { deleteSetting, setSetting } from '../services/storage/settings.ts'
import { runWithWorkspaceRoot } from '../services/workspace.ts'
import { baseSandboxConfig, workspaceSandboxOverlay } from './config.ts'
import {
  approvedFolderLinuxDenies,
  approvedFolderReadPlan,
  approvedFolderSecretDenyEntries,
  approvedFolderStillSafe,
  cacheReadRootCandidates,
  isApprovedFolderSecretName,
  resolveStandingReadRoots,
  toolchainReadRootCandidates,
} from './sandbox-read-access.ts'

const ALL_ON = { toolchains: true, caches: true, approvedFolders: true }

function fakeHome(): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-read-access-')))
  writeFileSync(join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=x\n')
  return {
    home,
    cleanup: (): void => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

describe('effectiveSandboxReadPolicy', () => {
  it('keeps each switch, and workspace-only turns every group off', () => {
    assert.deepEqual(
      effectiveSandboxReadPolicy({ ...ALL_ON, caches: false, workspaceOnly: false }),
      { toolchains: true, caches: false, approvedFolders: true },
    )
    assert.deepEqual(effectiveSandboxReadPolicy({ ...ALL_ON, workspaceOnly: true }), {
      toolchains: false,
      caches: false,
      approvedFolders: false,
    })
  })
})

describe('standing read root candidates', () => {
  it('names Xcode, Homebrew and version managers on macOS, and linuxbrew only on Linux', () => {
    const home = '/Users/dev'
    const mac = toolchainReadRootCandidates({}, home, 'darwin')
    for (const path of [
      '/Library/Developer/CommandLineTools',
      '/opt/homebrew',
      '/Users/dev/.nvm/versions',
      '/Users/dev/.rustup/toolchains',
      '/Users/dev/Library/Application Support/fnm/node-versions',
    ]) {
      assert.ok(mac.includes(path), path)
    }
    assert.ok(!mac.includes('/home/linuxbrew/.linuxbrew'))
    const linux = toolchainReadRootCandidates({ NVM_DIR: '/opt/nvm' }, '/home/dev', 'linux')
    assert.ok(linux.includes('/home/linuxbrew/.linuxbrew'))
    assert.ok(linux.includes('/opt/nvm/versions'))
    assert.ok(!linux.includes('/opt/homebrew'))
  })

  it('follows cache overrides and ignores relative ones', () => {
    const caches = cacheReadRootCandidates(
      { CARGO_HOME: '/data/cargo', GOMODCACHE: 'relative/mod', XDG_CACHE_HOME: '/data/cache' },
      '/home/dev',
      'linux',
    )
    assert.ok(caches.includes('/data/cargo/registry'))
    assert.ok(caches.includes('/data/cache/pip'))
    assert.ok(caches.includes('/home/dev/go/pkg/mod'), 'a relative GOMODCACHE falls back')
    assert.ok(!caches.some((path) => path.includes('relative')))
    assert.ok(!caches.some((path) => path.includes('Library')), 'macOS caches only on macOS')
  })
})

describe('resolveStandingReadRoots', () => {
  it('resolves only existing roots of the groups that are on', () => {
    const { home, cleanup } = fakeHome()
    try {
      mkdirSync(join(home, '.nvm', 'versions', 'node', 'v24.0.0'), { recursive: true })
      mkdirSync(join(home, '.npm', '_logs'), { recursive: true })
      const env = { HOME: home }
      // Fixed system roots (a runner's linuxbrew) may exist too; check only home's.
      const underHome = (
        roots: ReturnType<typeof resolveStandingReadRoots>,
      ): ReturnType<typeof resolveStandingReadRoots> =>
        roots.filter(({ canonical }) => canonical.startsWith(home + '/'))
      const both = underHome(resolveStandingReadRoots(ALL_ON, env, home, 'linux'))
      assert.deepEqual(
        both.map(({ group, canonical }) => [group, canonical]),
        [
          ['toolchains', join(home, '.nvm', 'versions')],
          ['caches', join(home, '.npm', '_logs')],
        ],
      )
      const cachesOnly = underHome(
        resolveStandingReadRoots({ ...ALL_ON, toolchains: false }, env, home, 'linux'),
      )
      assert.deepEqual(
        cachesOnly.map(({ group }) => group),
        ['caches'],
      )
      assert.deepEqual(
        resolveStandingReadRoots(
          { toolchains: false, caches: false, approvedFolders: true },
          env,
          home,
          'linux',
        ),
        [],
      )
    } finally {
      cleanup()
    }
  })

  it('drops a root that sits inside or would cover a credential store', () => {
    const { home, cleanup } = fakeHome()
    try {
      // NVM_DIR pointed into ~/.ssh, and a cache home that is home itself.
      mkdirSync(join(home, '.ssh', 'versions'), { recursive: true })
      mkdirSync(join(home, 'pip'), { recursive: true })
      const env = { HOME: home, NVM_DIR: join(home, '.ssh'), XDG_CACHE_HOME: home }
      const roots = resolveStandingReadRoots(ALL_ON, env, home, 'linux').map((r) => r.canonical)
      assert.ok(!roots.includes(join(home, '.ssh', 'versions')), 'inside ~/.ssh')
      assert.ok(roots.includes(join(home, 'pip')), 'an ordinary folder under home stays')
    } finally {
      cleanup()
    }
  })
})

/** Names `sensitiveTargetReason` calls credentials, in the cases people write them. */
const CREDENTIAL_NAMES = [
  '.env',
  '.ENV',
  '.env.release',
  '.Env.Local',
  'server.pem',
  'SERVER.PEM',
  'tls.Key',
  'store.p12',
  'cert.pfx',
  'app.jks',
  'release.keystore',
  'putty.ppk',
  'public-key.asc',
  'AuthKey_ABC123.p8',
  'AUTHKEY.P8',
  'id_rsa',
  'id_ed25519',
  'ID_ECDSA',
  'secrets.json',
  'App.Secrets.yaml',
  'credentials.json',
  'Credentials',
  'aws_credentials.txt',
  '.npmrc',
  '.NETRC',
  '.pypirc',
  '.git-credentials',
  'master.key',
  'secring.gpg',
]

describe('approved folder credential names', () => {
  const root = '/Users/dev/code/sibling'

  it('denies every name the classifier calls a credential, in any case, on macOS', () => {
    const regexes = approvedFolderSecretDenyEntries(root).map(
      (entry) => new RegExp(globToRegex(entry)),
    )
    for (const name of CREDENTIAL_NAMES) {
      const path = `${root}/config/${name}`
      assert.ok(sensitiveTargetReason(path, path) !== null, `the classifier flags ${name}`)
      assert.ok(
        regexes.some((regex) => regex.test(path)),
        `macOS denies ${name}`,
      )
      assert.ok(isApprovedFolderSecretName(name), `Linux denies ${name}`)
    }
    assert.ok(!regexes.some((regex) => regex.test(`${root}/src/main.ts`)))
    assert.ok(!isApprovedFolderSecretName('README.md'))
  })

  it('denies credential folders at any depth, in any case', () => {
    const regexes = approvedFolderSecretDenyEntries(root).map(
      (entry) => new RegExp(globToRegex(entry)),
    )
    for (const path of [`${root}/.ssh/id`, `${root}/deep/.AWS/config`, `${root}/x/.gnupg/a`]) {
      assert.ok(
        regexes.some((regex) => regex.test(path)),
        path,
      )
    }
  })
})

describe('approved folders on Linux', () => {
  function folder(): { root: string; cleanup: () => void } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'approved-folder-walk-')))
    writeFileSync(join(root, 'README.md'), 'readme\n')
    writeFileSync(join(root, '.ENV'), 'TOKEN=x\n')
    mkdirSync(join(root, 'config', '.ssh'), { recursive: true })
    writeFileSync(join(root, 'config', '.ssh', 'id_rsa'), 'key\n')
    writeFileSync(join(root, 'config', 'Server.PEM'), 'key\n')
    return {
      root,
      cleanup: (): void => {
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  it('denies the credential paths the walk finds, and not their siblings', () => {
    const { root, cleanup } = folder()
    try {
      assert.deepEqual(
        new Set(approvedFolderLinuxDenies(root)),
        new Set([
          join(root, '.ENV'),
          join(root, 'config', '.ssh'),
          join(root, 'config', 'Server.PEM'),
        ]),
      )
    } finally {
      cleanup()
    }
  })

  it(
    'keeps every deny when a subfolder cannot be read, and denies that subfolder whole',
    { skip: process.getuid?.() === 0 ? 'root reads mode-000 folders' : false },
    () => {
      const { root, cleanup } = folder()
      const locked = join(root, 'data')
      mkdirSync(locked)
      chmodSync(locked, 0o000)
      try {
        const denies = approvedFolderLinuxDenies(root)
        assert.ok(denies !== null)
        assert.ok(denies.includes(join(root, '.ENV')))
        assert.ok(denies.includes(locked))
      } finally {
        chmodSync(locked, 0o700)
        cleanup()
      }
    },
  )

  it('gives the folder up rather than allow it without its denies', () => {
    const { root, cleanup } = folder()
    try {
      assert.equal(approvedFolderLinuxDenies(root, { entries: 2, denies: 100 }), null)
      assert.equal(approvedFolderLinuxDenies(root, { entries: 100, denies: 1 }), null)
      const missing = join(root, 'gone')
      const plan = approvedFolderReadPlan([root, missing], 'linux')
      assert.deepEqual(plan.readable, [root])
      assert.ok(plan.deny.every((path) => path.startsWith(root + '/')))
      const mac = approvedFolderReadPlan([root, missing], 'darwin')
      assert.deepEqual(mac.readable, [root, missing])
    } finally {
      cleanup()
    }
  })
})

describe('approvedFolderStillSafe', () => {
  it('refuses a folder inside Copse’s own profile folder', () => {
    const { home, cleanup } = fakeHome()
    try {
      const profile = join(home, 'profile')
      const plugins = join(profile, 'plugins')
      const sibling = join(home, 'code', 'sibling')
      mkdirSync(plugins, { recursive: true })
      mkdirSync(sibling, { recursive: true })
      const env = { HOME: home, COPSE_DIR: profile }
      assert.equal(approvedFolderStillSafe(plugins, env, home), false)
      assert.equal(approvedFolderStillSafe(profile, env, home), false)
      assert.equal(approvedFolderStillSafe(sibling, env, home), true)
    } finally {
      cleanup()
    }
  })
})

describe('approved folder credentials in the macOS profile', () => {
  it('re-denies credentials after the folder allow, so seatbelt (last match wins) denies them', () => {
    const root = '/Users/dev/code/sibling'
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: {
        denyOnly: ['/Users/dev', ...approvedFolderSecretDenyEntries(root)],
        allowWithinDeny: [root],
      },
      writeConfig: { allowOnly: ['/dev/null'], denyWithinAllow: [] },
    })
    const allowAt = profile.indexOf(`(subpath "${root}")`)
    assert.ok(allowAt > 0, 'the folder is allowed')
    const after = profile.slice(allowAt)
    const denyBlock = after.indexOf('(deny file-read*')
    assert.ok(denyBlock > 0, 'a read deny follows the allow')
    assert.ok(
      after.slice(denyBlock).includes('^/Users/dev/code/sibling/(.*/)?') &&
        after.slice(denyBlock).includes('[eE][nN][vV]'),
      'the .env deny is in it',
    )
  })
})

describe('approved folders inside the real workspace sandbox', () => {
  afterEach(async () => {
    await deleteSetting(SANDBOX_READ_PROJECT_FOLDERS_SETTING)
    await deleteSetting(SANDBOX_READ_APPROVED_FOLDERS_SETTING)
    await deleteSetting(SANDBOX_READ_WORKSPACE_ONLY_SETTING)
  })

  it(
    'reads an approved sibling under home, never its credentials, and never writes it',
    { skip: process.platform === 'win32', timeout: 60_000 },
    async (t) => {
      try {
        await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
      } catch (error) {
        t.skip(`requires the OS sandbox: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-read-project-')))
      // Under home, which the sandbox otherwise denies wholesale.
      const sibling = realpathSync(mkdtempSync(join(homedir(), 'sandbox-read-sibling-')))
      try {
        writeFileSync(join(sibling, 'README.md'), 'sibling readme\n')
        writeFileSync(join(sibling, '.env'), 'TOKEN=secret\n')
        mkdirSync(join(sibling, 'config'))
        writeFileSync(join(sibling, 'config', 'server.pem'), 'PRIVATE\n')
        // A folder the user cannot list (a container's data directory owned by
        // another uid) must not drop the credential denies on Linux.
        mkdirSync(join(sibling, 'data'))
        chmodSync(join(sibling, 'data'), 0o000)
        await setSetting(SANDBOX_READ_PROJECT_FOLDERS_SETTING, { [workspace]: [sibling] })
        const run = async (command: string): Promise<{ status: number | null; output: string }> => {
          const overlay = runWithWorkspaceRoot(workspace, () => workspaceSandboxOverlay(workspace))
          const { argv } = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh', overlay)
          const [file = '', ...args] = argv
          const result = spawnSync(file, args, { cwd: workspace, encoding: 'utf8' })
          return { status: result.status, output: `${result.stdout}${result.stderr}` }
        }

        const probe = await run('true')
        if (probe.status !== 0) {
          t.skip(`the OS sandbox cannot start a process on this host: ${probe.output.trim()}`)
          return
        }
        const readme = await run(`cat "${join(sibling, 'README.md')}"`)
        assert.equal(readme.status, 0, readme.output)
        assert.match(readme.output, /sibling readme/)
        for (const secret of ['.env', join('config', 'server.pem')]) {
          const result = await run(`cat "${join(sibling, secret)}"`)
          assert.notEqual(result.status, 0, `${secret} must stay unreadable\n${result.output}`)
          assert.doesNotMatch(result.output, /secret|PRIVATE/)
        }
        const write = await run(`touch "${join(sibling, 'planted')}"`)
        assert.notEqual(write.status, 0, `an approved folder is never writable\n${write.output}`)

        await setSetting(SANDBOX_READ_WORKSPACE_ONLY_SETTING, true)
        const locked = await run(`cat "${join(sibling, 'README.md')}"`)
        assert.notEqual(locked.status, 0, `workspace only hides it again\n${locked.output}`)
      } finally {
        await SandboxManager.reset()
        rmSync(workspace, { recursive: true, force: true })
        try {
          chmodSync(join(sibling, 'data'), 0o700)
        } catch {
          // Not created when the sandbox could not start.
        }
        rmSync(sibling, { recursive: true, force: true })
      }
    },
  )
})
