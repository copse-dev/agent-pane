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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
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
      for (const command of ['node', 'npm', 'corepack', 'pnpm']) {
        assert.ok(allow.includes(join(multishell, 'bin', command)))
        assert.ok(allow.includes(join(bin, command)))
        assert.ok(allow.includes(realpathSync(join(bin, command))))
      }
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
