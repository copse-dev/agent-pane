import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import { removeTrailingGlobSuffix } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'
import { toolchainReadExceptions } from './toolchain-read-guard.ts'
import {
  linkPreparationNodeToolchain,
  preparationNodeToolchainReadPaths,
  preparationPathEnvironment,
} from './preparation-node-toolchain.ts'

it(
  'resolves fnm directory and package-manager symlinks without granting the registry or installation',
  { skip: process.platform === 'win32' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-fnm-')))
    try {
      const installation = join(root, 'node-versions', 'v24.20.0', 'installation')
      const multishell = join(root, 'fnm_multishells', 'session')
      const bin = join(installation, 'bin')
      mkdirSync(bin, { recursive: true })
      mkdirSync(dirname(multishell), { recursive: true })
      writeFileSync(join(bin, 'node'), '')
      chmodSync(join(bin, 'node'), 0o755)
      for (const [command, implementation] of [
        ['npm', 'npm/bin/npm-cli.js'],
        ['npx', 'npm/bin/npx-cli.js'],
        ['corepack', 'corepack/dist/corepack.js'],
        ['pnpm', 'corepack/dist/pnpm.js'],
      ]) {
        assert.ok(command && implementation)
        const target = join(installation, 'lib/node_modules', implementation)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, '')
        chmodSync(target, 0o755)
        symlinkSync(join('../lib/node_modules', implementation), join(bin, command))
      }
      symlinkSync(installation, multishell, 'dir')
      const path = join(multishell, 'bin')
      assert.equal(
        preparationPathEnvironment({ PATH: `${path}:/usr/bin:/missing` })['PATH'],
        `${bin}:/usr/bin:/missing`,
      )
      const allow = preparationNodeToolchainReadPaths({ PATH: path })
      for (const command of ['node', 'npm', 'npx', 'corepack', 'pnpm']) {
        assert.ok(allow.includes(realpathSync(join(bin, command))))
      }
      assert.ok(!allow.some((entry) => entry.startsWith(multishell)))
      for (const name of ['npm', 'corepack']) {
        assert.ok(allow.includes(join(installation, 'lib/node_modules', name)))
      }
      for (const path of [
        root,
        dirname(multishell),
        multishell,
        installation,
        bin,
        join(installation, 'lib/node_modules'),
      ]) {
        assert.ok(!allow.includes(path), path)
        assert.ok(!allow.includes(`${path}/**`), path)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it(
  'keeps npx available from an npm installation even when no npm launcher is on PATH',
  { skip: process.platform === 'win32' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-npx-')))
    try {
      const bin = join(root, 'installation', 'bin')
      const implementation = join(root, 'installation', 'lib/node_modules/npm')
      const cli = join(implementation, 'bin/npx-cli.js')
      const links = join(root, 'links')
      mkdirSync(bin, { recursive: true })
      mkdirSync(dirname(cli), { recursive: true })
      mkdirSync(links)
      writeFileSync(cli, '#!/usr/bin/env node\n')
      chmodSync(cli, 0o755)
      symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', join(bin, 'npx'))
      const linked = linkPreparationNodeToolchain({ PATH: bin }, links)
      assert.equal(linked['PATH'], `${links}:${bin}`)
      assert.equal(readlinkSync(join(links, 'npx')), cli)
      const allow = preparationNodeToolchainReadPaths({ PATH: bin })
      assert.ok(allow.includes(cli))
      assert.ok(allow.includes(`${implementation}/**`))
      assert.ok(!allow.includes(`${bin}/**`))
      assert.ok(!allow.includes(`${join(root, 'installation')}/**`))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it(
  'links each first PATH match to its canonical executable ahead of the original PATH',
  { skip: process.platform === 'win32' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-links-')))
    try {
      const installation = join(root, 'installation')
      const bin = join(installation, 'bin')
      const shadowed = join(root, 'shadowed')
      const links = join(root, 'links')
      mkdirSync(bin, { recursive: true })
      mkdirSync(shadowed)
      mkdirSync(links)
      writeFileSync(join(bin, 'node'), '')
      chmodSync(join(bin, 'node'), 0o755)
      const cli = join(installation, 'lib/node_modules/npm/bin/npm-cli.js')
      mkdirSync(dirname(cli), { recursive: true })
      writeFileSync(cli, '')
      chmodSync(cli, 0o755)
      symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(bin, 'npm'))
      writeFileSync(join(shadowed, 'npm'), '')
      chmodSync(join(shadowed, 'npm'), 0o755)
      const path = `${bin}:${shadowed}`
      const linked = linkPreparationNodeToolchain({ PATH: path }, links)
      assert.equal(linked['PATH'], `${links}:${path}`)
      assert.deepEqual(readdirSync(links).sort(), ['node', 'npm'])
      assert.equal(readlinkSync(join(links, 'node')), join(bin, 'node'))
      assert.equal(readlinkSync(join(links, 'npm')), cli)
      const empty = join(root, 'empty')
      mkdirSync(empty)
      const env = { PATH: join(root, 'missing') }
      assert.equal(linkPreparationNodeToolchain(env, empty), env)
      assert.deepEqual(readdirSync(empty), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it(
  'does not turn loose executables, stale aliases, or non-executable files into directory grants',
  { skip: process.platform === 'win32' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-loose-node-')))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'node'), '')
      chmodSync(join(bin, 'node'), 0o755)
      writeFileSync(join(bin, 'npm'), '')
      symlinkSync(join(root, 'missing'), join(bin, 'corepack'))
      assert.deepEqual(preparationNodeToolchainReadPaths({ PATH: bin }), [join(bin, 'node')])
      assert.deepEqual(preparationNodeToolchainReadPaths({}), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it(
  'does not grant or link a toolchain executable redirected into credentials',
  { skip: process.platform === 'win32' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-node-credential-')))
    try {
      const bin = join(home, 'project', 'node_modules', '.bin')
      const target = join(home, '.ssh', 'id_ed25519')
      const links = join(home, 'links')
      mkdirSync(bin, { recursive: true })
      mkdirSync(dirname(target), { recursive: true })
      mkdirSync(links)
      writeFileSync(target, 'synthetic credential\n')
      chmodSync(target, 0o755)
      symlinkSync(target, join(bin, 'node'))
      symlinkSync(target, join(bin, 'npx'))
      const env = { PATH: bin }
      assert.deepEqual(preparationNodeToolchainReadPaths(env, home), [])
      assert.equal(linkPreparationNodeToolchain(env, links), env)
      assert.deepEqual(readdirSync(links), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
)

it(
  'grants the install trees behind Volta, asdf, and mise shims, never the manager root',
  { skip: process.platform === 'win32' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-shims-')))
    const executable = (path: string, body = ''): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      chmodSync(path, 0o755)
    }
    try {
      const volta = join(home, '.volta')
      executable(join(volta, 'bin', 'volta-shim'))
      symlinkSync('volta-shim', join(volta, 'bin', 'node'))
      executable(join(volta, 'tools', 'image', 'node', '24.20.0', 'bin', 'node'))

      const asdf = join(home, '.asdf')
      executable(join(asdf, 'shims', 'node'), '#!/usr/bin/env bash\nexec asdf exec node "$@"\n')
      executable(join(asdf, 'installs', 'nodejs', '24.20.0', 'bin', 'node'))
      mkdirSync(join(asdf, 'plugins', 'nodejs'), { recursive: true })

      const mise = join(home, '.local', 'share', 'mise')
      executable(join(home, '.local', 'bin', 'mise'))
      mkdirSync(join(mise, 'shims'), { recursive: true })
      symlinkSync(join(home, '.local', 'bin', 'mise'), join(mise, 'shims', 'node'))
      executable(join(mise, 'installs', 'node', '24.20.0', 'bin', 'node'))

      const cases: Array<[string, string, string[]]> = [
        [join(volta, 'bin'), volta, ['bin', 'tools']],
        [join(asdf, 'shims'), asdf, ['shims', 'installs', 'plugins']],
        [join(mise, 'shims'), mise, ['shims', 'installs']],
      ]
      for (const [path, root, subtrees] of cases) {
        const allow = preparationNodeToolchainReadPaths({ PATH: path }, home)
        for (const subtree of subtrees) {
          assert.ok(allow.includes(join(root, subtree)), `${root} ${subtree}`)
          assert.ok(allow.includes(`${join(root, subtree)}/**`), `${root} ${subtree}`)
        }
        for (const broad of [home, root, join(home, '.local')]) {
          assert.ok(!allow.includes(broad), broad)
          assert.ok(!allow.includes(`${broad}/**`), broad)
        }
      }

      // The data root follows the manager's override variable.
      const custom = join(home, 'volta-home')
      executable(join(custom, 'bin', 'volta-shim'))
      symlinkSync('volta-shim', join(custom, 'bin', 'node'))
      mkdirSync(join(custom, 'tools'))
      const overridden = preparationNodeToolchainReadPaths(
        { PATH: join(custom, 'bin'), VOLTA_HOME: custom },
        home,
      )
      assert.ok(overridden.includes(`${join(custom, 'tools')}/**`))
      assert.ok(!overridden.includes(`${join(volta, 'tools')}/**`))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
)

it(
  'does not treat an unrelated bin directory, or a manager rooted at home, as a shim layout',
  { skip: process.platform === 'win32' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-not-shims-')))
    try {
      for (const path of [join(home, 'bin', 'node'), join(home, '.volta', 'tools', 'node')]) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
        chmodSync(path, 0o755)
      }
      mkdirSync(join(home, 'tools'))
      const bin = join(home, 'bin')
      assert.deepEqual(preparationNodeToolchainReadPaths({ PATH: bin }, home), [join(bin, 'node')])
      assert.deepEqual(preparationNodeToolchainReadPaths({ PATH: bin, VOLTA_HOME: home }, home), [
        join(bin, 'node'),
      ])
      assert.deepEqual(
        preparationNodeToolchainReadPaths({ PATH: bin, VOLTA_HOME: 'relative' }, home),
        [join(bin, 'node')],
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
)

it(
  'refuses redirected shim subtrees instead of recursively granting their targets or aliases',
  { skip: process.platform === 'win32' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-shim-redirect-')))
    try {
      const root = join(home, '.asdf')
      const shims = join(root, 'shims')
      mkdirSync(shims, { recursive: true })
      writeFileSync(join(shims, 'node'), '')
      chmodSync(join(shims, 'node'), 0o755)
      const credentials = join(home, '.ssh')
      mkdirSync(credentials)
      const subtree = join(root, 'installs')
      for (const target of [home, dirname(home), credentials, root]) {
        symlinkSync(target, subtree, 'dir')
        const allow = preparationNodeToolchainReadPaths({ PATH: shims }, home)
        for (const unsafe of [subtree, target]) {
          assert.ok(!allow.includes(unsafe), unsafe)
          assert.ok(!allow.includes(`${unsafe}/**`), unsafe)
        }
        assert.ok(allow.includes(`${shims}/**`), 'unredirected shims stay available')
        unlinkSync(subtree)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
)

it(
  'rejects redirected home and credential manager roots while retaining a safe relocated manager',
  { skip: process.platform === 'win32' },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-manager-redirect-')))
    try {
      const alias = join(home, '.asdf')
      for (const target of [home, join(home, '.ssh'), join(home, '.config', 'gh')]) {
        const shims = join(target, 'shims')
        mkdirSync(shims, { recursive: true })
        mkdirSync(join(target, 'installs'), { recursive: true })
        writeFileSync(join(shims, 'node'), '')
        chmodSync(join(shims, 'node'), 0o755)
        symlinkSync(target, alias, 'dir')
        const allow = preparationNodeToolchainReadPaths({ PATH: join(alias, 'shims') }, home)
        assert.ok(!allow.some((entry) => entry.endsWith('/**')), target)
        unlinkSync(alias)
      }
      const target = join(home, 'relocated-asdf')
      const shims = join(target, 'shims')
      mkdirSync(shims, { recursive: true })
      mkdirSync(join(target, 'installs'))
      writeFileSync(join(shims, 'node'), '')
      chmodSync(join(shims, 'node'), 0o755)
      symlinkSync(target, alias, 'dir')
      const allow = preparationNodeToolchainReadPaths({ PATH: join(alias, 'shims') }, home)
      assert.ok(!allow.includes(`${join(alias, 'installs')}/**`))
      assert.ok(allow.includes(`${join(target, 'installs')}/**`))
      assert.ok(!allow.includes(`${target}/**`))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  },
)

it('does not render a later credential target through a replaced preparation executable alias', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-retarget-node-')))
  try {
    const project = join(home, 'project')
    const bin = join(project, 'node_modules', '.bin')
    const node = join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin', 'node')
    const credential = join(home, '.codex', 'auth.json')
    for (const path of [node, credential]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'synthetic fixture\n')
    }
    chmodSync(node, 0o755)
    mkdirSync(bin, { recursive: true })
    const alias = join(bin, 'node')
    symlinkSync(node, alias)
    const allow = toolchainReadExceptions(
      preparationNodeToolchainReadPaths({ PATH: bin }, home),
      [home],
      [project],
    )
    unlinkSync(alias)
    symlinkSync(credential, alias)
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: {
        denyOnly: [home],
        allowWithinDeny: [project, ...allow.map(removeTrailingGlobSuffix)],
      },
      writeConfig: { allowOnly: ['/dev/null'], denyWithinAllow: [] },
    })
    assert.ok(profile.includes(JSON.stringify(node)), 'the canonical runtime remains granted')
    assert.ok(!profile.includes(JSON.stringify(credential)), 'ASRT must not re-resolve the alias')

    for (const target of [credential, bin]) {
      unlinkSync(alias)
      symlinkSync(target, alias)
      assert.deepEqual(preparationNodeToolchainReadPaths({ PATH: bin }, home), [], target)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
