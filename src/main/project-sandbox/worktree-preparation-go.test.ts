import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import { runWorktreePreparationProcess } from './worktree-preparation.ts'
import { inspectWorktreePreparation, prepareWorktree } from '../services/worktree-preparation.ts'

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function makeFixtureWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat) return
  if (stat.isDirectory()) {
    chmodSync(path, 0o700)
    for (const entry of readdirSync(path)) makeFixtureWritable(join(path, entry))
  } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600)
}

it(
  'does not grant a fake home-style go wrapper access to its grandparent',
  { skip: process.platform === 'win32' },
  async (t) => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'fake-go-home-test-')))
    // Same reason as the locked-module fixture below: setup runs before the
    // try, so only a hook tied to the directory itself always removes it.
    t.after(() => {
      rmSync(parent, { recursive: true, force: true })
    })
    const root = join(parent, 'project')
    const fakeHome = join(parent, 'fake-home')
    const outside = join(parent, 'outside')
    const wrapper = join(fakeHome, 'bin', 'go')
    mkdirSync(root)
    write(join(outside, 'secret'), 'must stay private')
    const goArch = process.arch === 'x64' ? 'amd64' : process.arch === 'ia32' ? '386' : process.arch
    write(
      join(fakeHome, 'pkg', 'tool', `${process.platform}_${goArch}`, 'compile'),
      'fake compiler marker',
    )
    symlinkSync(join(outside, 'secret'), join(fakeHome, 'VERSION'))
    symlinkSync(outside, join(fakeHome, 'src'))
    write(wrapper, '#!/bin/sh\ncat "$FAKE_GO_HOME/src/secret" || cat "$FAKE_GO_HOME/VERSION"\n')
    chmodSync(wrapper, 0o700)
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    try {
      await assert.rejects(
        runWorktreePreparationProcess(wrapper, [], {
          root,
          env: { ...process.env, FAKE_GO_HOME: fakeHome },
          mode: 'preflight',
          offline: true,
          goBookkeeping: true,
        }),
        /failed/,
      )

      rmSync(fakeHome, { recursive: true, force: true })
      write(join(fakeHome, 'secret'), 'the toolchain root must stay private')
      write(join(fakeHome, 'VERSION'), 'go1.26.5\n')
      write(
        join(fakeHome, 'pkg', 'tool', `${process.platform}_${goArch}`, 'compile'),
        'fake compiler marker',
      )
      symlinkSync('.', join(fakeHome, 'src'))
      write(wrapper, '#!/bin/sh\ncat "$FAKE_GO_HOME/src/secret"\n')
      chmodSync(wrapper, 0o700)
      await assert.rejects(
        runWorktreePreparationProcess(wrapper, [], {
          root,
          env: { ...process.env, FAKE_GO_HOME: fakeHome },
          mode: 'preflight',
          offline: true,
          goBookkeeping: true,
        }),
        /failed/,
      )
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
    }
  },
)

it(
  'prepares, verifies, repairs, and executes a real locked Go module offline',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async (t) => {
    if (
      spawnSync('go', ['version']).status !== 0 ||
      spawnSync('python3', ['--version']).status !== 0
    ) {
      t.skip('real Go fixture requires installed Go and Python; no global tool installation')
      return
    }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'go-preparation-test-')))
    // Registered against the temporary directory itself, not the try/finally
    // below: `go mod tidy` populates a read-only module cache under `parent`
    // during setup, so a failure before the body is reached would otherwise
    // strand it. When this fixture runs inside a review cell's own tmp, that
    // stranded tree is what later fails the cell's cleanup with EACCES (#2945).
    t.after(() => {
      makeFixtureWritable(parent)
      rmSync(parent, { recursive: true, force: true })
    })
    const root = join(parent, 'project')
    const proxy = join(root, 'proxy', 'example.test', 'dep', '@v')
    mkdirSync(proxy, { recursive: true })
    write(join(proxy, 'v1.0.0.info'), '{"Version":"v1.0.0","Time":"2025-01-01T00:00:00Z"}\n')
    write(join(proxy, 'v1.0.0.mod'), 'module example.test/dep\n\ngo 1.24\n')
    const zip = spawnSync(
      'python3',
      [
        '-c',
        `import sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('example.test/dep@v1.0.0/dep.go', 'package dep\\nconst Value = 42\\n')`,
        join(proxy, 'v1.0.0.zip'),
      ],
      { encoding: 'utf8' },
    )
    assert.equal(zip.status, 0, zip.stderr)
    const manifest = 'module example.test/app\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\n'
    const source =
      'package main\nimport ("fmt"; "example.test/dep")\nfunc main(){fmt.Println(dep.Value)}\n'
    const workspace = 'go 1.24\nuse .\n'
    write(join(root, 'go.mod'), manifest)
    write(join(root, 'go.work'), workspace)
    write(join(root, 'main.go'), source)
    const author = spawnSync('go', ['mod', 'tidy'], {
      cwd: root,
      env: {
        ...process.env,
        GOWORK: 'off',
        GOTOOLCHAIN: 'local',
        GOPROXY: `file://${join(root, 'proxy')}`,
        GOSUMDB: 'off',
        GOMODCACHE: join(parent, 'author-cache'),
      },
      encoding: 'utf8',
    })
    assert.equal(author.status, 0, author.stderr)
    const originalSum = readFileSync(join(root, 'go.sum'), 'utf8')
    const profile = join(parent, 'profile')
    const env = {
      ...process.env,
      COPSE_DIR: profile,
      GOPROXY: `file://${join(root, 'proxy')}`,
      GOSUMDB: 'off',
      GOFLAGS: '-mod=mod',
      GOWORK: '/outside/go.work',
      GOTOOLCHAIN: 'auto',
    }
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    try {
      const before = await inspectWorktreePreparation(root, { env })
      assert.equal(before.state, 'absent')
      const options = {
        env,
        planFingerprint: before.planFingerprint,
        offline: false,
        signal: new AbortController().signal,
      }
      assert.equal((await prepareWorktree(root, options)).state, 'ready')
      assert.equal(readFileSync(join(root, 'go.mod'), 'utf8'), manifest)
      assert.equal(readFileSync(join(root, 'go.sum'), 'utf8'), originalSum)
      assert.equal(readFileSync(join(root, 'main.go'), 'utf8'), source)
      assert.equal(readFileSync(join(root, 'go.work'), 'utf8'), workspace)
      assert.equal(existsSync(join(root, 'go.work.sum')), false)

      const goEnv = {
        ...env,
        GOENV: 'off',
        GOTOOLCHAIN: 'local',
        GOFLAGS: '-mod=readonly',
        GOWORK: join(root, 'go.work'),
        GOPROXY: 'off',
        GOMODCACHE: join(profile, 'cache', 'go', 'mod'),
        GOCACHE: join(profile, 'cache', 'go', 'build'),
        GOPATH: join(profile, 'cache', 'go', 'path'),
      }
      assert.equal(
        await runWorktreePreparationProcess(
          process.execPath,
          [
            '-e',
            `const fs=require('node:fs'),path=require('node:path');
for(const [name,target] of [['scratch',path.join(process.env.TMPDIR,'ok')],['module-cache',path.join(process.env.GOMODCACHE,'preflight-write')],['project',path.resolve('preflight-write')]]){
  try{fs.writeFileSync(target,'bad');console.log(name+':writable')}catch{console.log(name+':blocked')}
}`,
          ],
          { root, env: goEnv, mode: 'preflight', offline: true, goBookkeeping: true },
        ),
        'scratch:writable\nmodule-cache:blocked\nproject:blocked',
      )
      assert.equal(
        await runWorktreePreparationProcess('go', ['run', '-mod=readonly', '.'], {
          root,
          env: goEnv,
          mode: 'prepare',
          offline: true,
          projectWritable: false,
          goBookkeeping: true,
        }),
        '42',
      )
      assert.equal(
        await runWorktreePreparationProcess(
          process.execPath,
          [
            '-e',
            `const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.GOMODCACHE,'prepare-write'),'ok');
try{fs.writeFileSync('project-write','bad');console.log('project:writable')}catch{console.log('cache:writable; project:blocked')}`,
          ],
          {
            root,
            env: goEnv,
            mode: 'prepare',
            offline: true,
            projectWritable: false,
            goBookkeeping: true,
          },
        ),
        'cache:writable; project:blocked',
      )
      assert.equal(existsSync(join(root, 'project-write')), false)

      const extracted = join(profile, 'cache', 'go', 'mod', 'example.test', 'dep@v1.0.0')
      chmodSync(join(extracted, 'dep.go'), 0o600)
      write(join(extracted, 'dep.go'), 'package dep\nconst Value = 13\n')
      const corrupt = await inspectWorktreePreparation(root, { env })
      assert.equal(corrupt.state, 'corrupt')
      assert.match(
        corrupt.components.find((component) => component.name === 'Verified Go module cache')
          ?.detail ?? '',
        /modified|failed/i,
      )
      makeFixtureWritable(extracted)
      rmSync(extracted, { recursive: true })
      assert.equal((await prepareWorktree(root, { ...options, offline: true })).state, 'ready')

      write(join(root, 'main.go'), source.replace('"example.test/dep"', '"example.test/missing"'))
      await assert.rejects(prepareWorktree(root, options), /plan changed/)
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
      assert.equal(readFileSync(join(root, 'go.mod'), 'utf8'), manifest)
      assert.equal(readFileSync(join(root, 'go.sum'), 'utf8'), originalSum)

      write(join(root, 'main.go'), source)
      write(join(root, 'go.sum'), '')
      const staleLock = await inspectWorktreePreparation(root, { env, offline: true })
      assert.equal(staleLock.state, 'unavailable-offline')
      await assert.rejects(
        prepareWorktree(root, {
          ...options,
          offline: true,
          planFingerprint: staleLock.planFingerprint,
        }),
        /unavailable offline/,
      )
      assert.equal(readFileSync(join(root, 'go.sum'), 'utf8'), '')
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
    }
  },
)
