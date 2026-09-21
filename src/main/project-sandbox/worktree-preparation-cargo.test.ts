import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import {
  legacyPreparationRuntimeReadPaths,
  preparationCacheRoots,
  runWorktreePreparationProcess,
} from './worktree-preparation.ts'
import {
  inspectWorktreePreparation,
  prepareWorktree,
  resolveInstalledRustToolchainBin,
} from '../services/worktree-preparation.ts'

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function makeWritable(path: string): void {
  const entry = existsSync(path) ? realpathSync(path) : null
  if (!entry) return
  const stat = readdirSync(path, { withFileTypes: true })
  chmodSync(path, 0o700)
  for (const child of stat) {
    const childPath = join(path, child.name)
    if (child.isDirectory()) makeWritable(childPath)
    else chmodSync(childPath, 0o600)
  }
}

it('retains rustup reads for reviewed declarations but excludes them from automatic Cargo', () => {
  assert.deepEqual(legacyPreparationRuntimeReadPaths(true), [])
  assert.deepEqual(legacyPreparationRuntimeReadPaths(false), [
    join(homedir(), '.cargo/bin'),
    join(homedir(), '.rustup/toolchains'),
  ])
})

it(
  'fetches, reuses, and repairs a real locked Cargo dependency without executing project code',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async (t) => {
    const toolchainBin = resolveInstalledRustToolchainBin(process.cwd(), process.env)
    if (!toolchainBin || spawnSync(join(toolchainBin, 'cargo'), ['--version']).status !== 0) {
      t.skip('real Cargo fixture requires an installed direct Cargo toolchain')
      return
    }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cargo-preparation-test-')))
    const root = join(parent, 'project')
    const dependency = join(root, 'fixture-dependency')
    const marker = join(parent, 'build-script-ran')
    mkdirSync(join(dependency, 'src'), { recursive: true })
    write(
      join(dependency, 'Cargo.toml'),
      '[package]\nname="fixture-dependency"\nversion="0.1.0"\nedition="2021"\nbuild="build.rs"\n',
    )
    write(join(dependency, 'src/lib.rs'), 'pub const VALUE: usize = 42;\n')
    write(
      join(dependency, 'build.rs'),
      `fn main(){std::fs::write(${JSON.stringify(marker)}, "executed").unwrap();}\n`,
    )
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'fixture@example.test'],
      ['config', 'user.name', 'Fixture'],
      ['add', '.'],
      ['commit', '-qm', 'fixture'],
    ]) {
      const result = spawnSync('git', args, { cwd: dependency, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dependency,
      encoding: 'utf8',
    }).stdout.trim()
    mkdirSync(join(root, 'src'), { recursive: true })
    const manifest = `[package]\nname="fixture-app"\nversion="0.1.0"\nedition="2021"\n\n[dependencies]\nfixture-dependency={git="file://${dependency}",rev="${revision}"}\n`
    const source = 'fn main(){println!("{}", fixture_dependency::VALUE);}\n'
    write(join(root, 'Cargo.toml'), manifest)
    write(join(root, 'src/main.rs'), source)
    const authorCache = join(parent, 'author-cargo')
    const author = spawnSync(
      join(toolchainBin, 'cargo'),
      [
        'generate-lockfile',
        '--manifest-path',
        join(root, 'Cargo.toml'),
        '--config',
        'net.git-fetch-with-cli=false',
      ],
      { env: { PATH: toolchainBin, CARGO_HOME: authorCache }, encoding: 'utf8' },
    )
    assert.equal(author.status, 0, author.stderr)
    const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8')
    const profile = join(parent, 'profile')
    const env = {
      ...process.env,
      PATH: `${join(root, 'hostile-bin')}:${process.env['PATH'] ?? ''}`,
      COPSE_DIR: profile,
      RUSTC_WRAPPER: join(root, 'hostile-wrapper'),
      CARGO_REGISTRY_TOKEN: 'must-not-reach-cargo',
      RUSTFLAGS: '--cfg hostile',
    }
    write(join(root, 'hostile-wrapper'), `#!/bin/sh\necho wrapper > ${marker}\nexit 1\n`)
    chmodSync(join(root, 'hostile-wrapper'), 0o700)
    write(join(root, 'hostile-bin', 'cargo'), `#!/bin/sh\necho path-fallback > ${marker}\nexit 1\n`)
    chmodSync(join(root, 'hostile-bin', 'cargo'), 0o700)
    const cargoHome = join(profile, 'cache', 'cargo')
    const outsideCache = join(parent, 'outside-cache')
    mkdirSync(cargoHome, { recursive: true })
    mkdirSync(outsideCache)
    symlinkSync(outsideCache, join(cargoHome, 'git'))
    assert.throws(() => preparationCacheRoots(env, true, true), /Cargo preparation cache structure/)
    assert.deepEqual(readdirSync(outsideCache), [])
    rmSync(join(cargoHome, 'git'))
    write(
      join(cargoHome, 'config.toml'),
      '[registry]\nglobal-credential-providers=["cargo:token-from-stdout echo hostile"]\n',
    )
    assert.throws(
      () => preparationCacheRoots(env, true, true),
      /must not contain configuration or credentials/,
    )
    rmSync(join(cargoHome, 'config.toml'))
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    try {
      write(
        join(parent, '.cargo', 'config.toml'),
        '[registry]\nglobal-credential-providers=["cargo:token-from-stdout echo hostile"]\n',
      )
      await assert.rejects(
        runWorktreePreparationProcess('cargo', ['--version'], {
          root,
          env: { ...env, CARGO_HOME: cargoHome },
          mode: 'preflight',
          offline: true,
          cargoAdapter: true,
        }),
        /ancestor configuration/,
      )
      rmSync(join(parent, '.cargo'), { recursive: true, force: true })
      write(join(parent, 'Cargo.toml'), '[workspace]\nmembers=["project"]\n')
      await assert.rejects(
        runWorktreePreparationProcess('cargo', ['--version'], {
          root,
          env: { ...env, CARGO_HOME: cargoHome },
          mode: 'preflight',
          offline: true,
          cargoAdapter: true,
        }),
        /enclosing workspace manifest/,
      )
      rmSync(join(parent, 'Cargo.toml'))
      assert.match(
        await runWorktreePreparationProcess(join(toolchainBin, 'cargo'), ['--version'], {
          root,
          env: { ...env, CARGO_HOME: cargoHome },
          mode: 'preflight',
          offline: true,
          cargoAdapter: true,
        }),
        /^cargo /,
      )
      assert.equal(existsSync(marker), false)
      assert.match(
        await runWorktreePreparationProcess(
          process.execPath,
          [
            '-e',
            'const {spawnSync}=require("node:child_process");const r=spawnSync(process.env.RUSTC,["-vV"],{encoding:"utf8"});if(r.status!==0)process.exit(r.status??1);process.stdout.write(r.stdout)',
          ],
          {
            root,
            env: {
              ...env,
              CARGO_HOME: cargoHome,
              CARGO: join(toolchainBin, 'cargo'),
              RUSTC: join(toolchainBin, 'rustc'),
            },
            mode: 'preflight',
            offline: true,
            cargoAdapter: true,
            additionalExecutables: [join(toolchainBin, 'rustc')],
          },
        ),
        /^rustc /,
      )
      assert.equal(existsSync(marker), false)
      const before = await inspectWorktreePreparation(root, { env })
      assert.equal(before.state, 'absent')
      const options = {
        env,
        planFingerprint: before.planFingerprint,
        offline: false,
        signal: new AbortController().signal,
      }
      assert.equal((await prepareWorktree(root, options)).state, 'ready')
      assert.equal(readFileSync(join(root, 'Cargo.toml'), 'utf8'), manifest)
      assert.equal(readFileSync(join(root, 'Cargo.lock'), 'utf8'), lock)
      assert.equal(readFileSync(join(root, 'src/main.rs'), 'utf8'), source)
      assert.equal(existsSync(marker), false)

      assert.equal(
        await runWorktreePreparationProcess(
          process.execPath,
          [
            '-e',
            `const fs=require('node:fs'),path=require('node:path');
for(const [name,target] of [['scratch',path.join(process.env.TMPDIR,'ok')],['cache',path.join(process.env.CARGO_HOME,'preflight-write')],['project',path.resolve('preflight-write')]]){
try{fs.writeFileSync(target,'bad');console.log(name+':writable')}catch{console.log(name+':blocked')}}`,
          ],
          {
            root,
            env: { ...env, CARGO_HOME: cargoHome },
            mode: 'preflight',
            offline: true,
            cargoAdapter: true,
          },
        ),
        'scratch:writable\ncache:blocked\nproject:blocked',
      )
      assert.equal((await inspectWorktreePreparation(root, { env, offline: true })).state, 'ready')

      const checkouts = join(cargoHome, 'git', 'checkouts')
      makeWritable(checkouts)
      rmSync(checkouts, { recursive: true, force: true })
      assert.equal((await prepareWorktree(root, { ...options, offline: true })).state, 'ready')
      assert.equal(existsSync(marker), false)

      write(join(root, 'Cargo.toml'), manifest.replace('fixture-app', 'fixture-app-changed'))
      const stale = await inspectWorktreePreparation(root, { env, offline: true })
      assert.equal(stale.state, 'unavailable-offline')
      await assert.rejects(
        prepareWorktree(root, {
          ...options,
          offline: true,
          planFingerprint: stale.planFingerprint,
        }),
        /unavailable offline/,
      )
      assert.equal(readFileSync(join(root, 'Cargo.lock'), 'utf8'), lock)
      assert.equal(existsSync(marker), false)
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
      makeWritable(parent)
      rmSync(parent, { recursive: true, force: true })
    }
  },
)
