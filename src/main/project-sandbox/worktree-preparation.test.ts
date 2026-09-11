import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import { acquireSandboxNetworkScope } from './network-scope.ts'
import { preparationCacheRoots, runWorktreePreparationProcess } from './worktree-preparation.ts'
import {
  inspectWorktreePreparation,
  preparationEnvironment,
  prepareWorktree,
} from '../services/worktree-preparation.ts'
import { NATIVE_PREPARATION_SCRIPT } from '../../../scripts/lib/native-artifacts.mts'
import { DEV_STATE } from '../../../scripts/lib/dev-sync.mts'

const parent = realpathSync(mkdtempSync(join(tmpdir(), 'copse-preparation-boundary-')))
const root = join(parent, 'worktree')
const profile = join(parent, 'profile')
const env = preparationEnvironment({ ...process.env, COPSE_DIR: profile })

function write(path: string, contents: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  if (executable) chmodSync(path, 0o755)
}

after(async () => {
  setProjectSandboxEnabled(false)
  await SandboxManager.reset()
  rmSync(parent, { recursive: true, force: true })
})

it('fails closed before running preparation or preflight when the sandbox is unavailable', async () => {
  mkdirSync(root, { recursive: true })
  setProjectSandboxEnabled(false)
  await assert.rejects(
    prepareWorktree(root, { env, signal: new AbortController().signal }),
    /active OS sandbox/,
  )
  await assert.rejects(inspectWorktreePreparation(root, { env }), /active OS sandbox/)
  await assert.rejects(
    runWorktreePreparationProcess(process.execPath, ['-e', 'process.exit(0)'], {
      root,
      env,
      mode: 'prepare',
      offline: false,
    }),
    /active OS sandbox/,
  )
})

it(
  'rejects cache symlinks without creating anything in their target',
  { skip: process.platform === 'win32' },
  () => {
    const cache = join(profile, 'cache')
    mkdirSync(cache, { recursive: true })
    const target = join(parent, 'unrelated')
    mkdirSync(target)
    symlinkSync(target, join(cache, 'pnpm-store'), 'dir')
    try {
      assert.throws(() => preparationCacheRoots(env, true), /must not be a symlink/)
      assert.equal(existsSync(join(cache, 'socket-firewall')), false)
    } finally {
      rmSync(join(cache, 'pnpm-store'))
    }
  },
)

describe('real worktree preparation containment', { skip: process.platform === 'win32' }, () => {
  before(async () => {
    // Never skip a supported platform after init failure: these tests must prove
    // kernel enforcement, not silently turn green without executing a sandbox.
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
  })

  it('allows preparation writes only in the worktree and managed caches, including through symlinks', async () => {
    const outside = join(parent, 'outside-write')
    const startup = join(root, 'startup.sh')
    write(startup, 'printf escaped > "$ESCAPE_TARGET"\n')
    const throughLink = join(root, 'redirect')
    symlinkSync(parent, throughLink, 'dir')
    const cache = preparationCacheRoots(env, true)[0]
    assert.ok(cache)
    const result = await runWorktreePreparationProcess(
      process.execPath,
      [
        '-e',
        `
      const fs=require('node:fs');
      if (process.env.TMPDIR !== process.argv[1].replace(/allowed$/, '.tmp/worktree-preparation')) throw new Error('scratch escaped');
      fs.writeFileSync(process.argv[1], 'workspace');
      fs.writeFileSync(process.argv[2], 'cache');
      fs.mkdirSync('node_modules/example/.idea', {recursive:true});
      fs.writeFileSync('node_modules/example/.idea/metadata', 'inert package metadata');
      for (const path of process.argv.slice(3)) {
        try { fs.writeFileSync(path, 'escaped'); process.exitCode=1 }
        catch (error) { if (!['EPERM','EACCES','EROFS'].includes(error.code)) throw error }
      }
      console.log('contained');
    `,
        join(root, 'allowed'),
        join(cache, 'allowed'),
        outside,
        join(throughLink, 'symlink-write'),
        join(root, '.gitconfig'),
      ],
      {
        root,
        env: { ...env, BASH_ENV: startup, ENV: startup, ESCAPE_TARGET: outside },
        mode: 'prepare',
        offline: true,
      },
    )
    assert.equal(result, 'contained')
    assert.equal(readFileSync(join(root, 'allowed'), 'utf8'), 'workspace')
    assert.equal(readFileSync(join(cache, 'allowed'), 'utf8'), 'cache')
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync(join(parent, 'symlink-write')), false)
    assert.equal(existsSync(join(root, '.gitconfig')), false)
    assert.equal(
      readFileSync(join(root, 'node_modules/example/.idea/metadata'), 'utf8'),
      'inert package metadata',
    )
  })

  it('runs spoofed version probes read-only, including against workspace and cache files', async () => {
    write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'copse-panel',
        packageManager: 'pnpm@10.34.5',
        scripts: { 'prepare:native': NATIVE_PREPARATION_SCRIPT },
      }),
    )
    write(join(root, '.nvmrc'), process.versions.node)
    const driver = join(root, 'node_modules/electron-chromedriver')
    write(join(driver, 'package.json'), '{"version":"44.0.0"}')
    write(join(root, 'node_modules/electron/package.json'), '{"version":"44.0.0"}')
    write(join(root, 'node_modules/electron/dist/version'), '44.0.0')
    write(join(root, 'node_modules/electron/path.txt'), 'electron')
    write(
      join(root, 'node_modules/electron/dist/electron'),
      '#!/bin/sh\necho 152.0.7977.65\n',
      true,
    )
    const targets = [
      join(root, 'probe-write'),
      join(profile, 'cache/pnpm-store/probe-write'),
      join(parent, 'probe-write'),
    ]
    write(
      join(driver, 'bin/chromedriver'),
      `#!/usr/bin/env node\nconst fs=require('node:fs');for(const p of ${JSON.stringify(targets)}){try{fs.writeFileSync(p,'escaped')}catch{}}console.log('ChromeDriver 152.0.7977.65')`,
      true,
    )
    const report = await inspectWorktreePreparation(root, { env })
    assert.equal(report.components.chromedriver.ready, true, JSON.stringify(report))
    for (const path of targets) assert.equal(existsSync(path), false, path)
  })

  it('denies offline network even while another process has a global network grant', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.end('download')
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const release = acquireSandboxNetworkScope({
      domains: ['*'],
      allowLocalBinding: true,
      label: 'preparation regression test',
    })
    const args = [
      '-e',
      `fetch(process.argv[1], {signal:AbortSignal.timeout(1500)}).then(r=>r.text()).then(console.log).catch(()=>process.exit(7))`,
      `http://127.0.0.1:${String(address.port)}/artifact`,
    ]
    try {
      assert.equal(
        await runWorktreePreparationProcess(process.execPath, args, {
          root,
          env,
          mode: 'prepare',
          offline: false,
        }),
        'download',
      )
      await assert.rejects(
        runWorktreePreparationProcess(process.execPath, args, {
          root,
          env,
          mode: 'prepare',
          offline: true,
        }),
        /failed/,
      )
      await assert.rejects(
        runWorktreePreparationProcess(process.execPath, args, {
          root,
          env,
          mode: 'preflight',
          offline: false,
        }),
        /failed/,
      )
      assert.equal(requests, 1)
    } finally {
      release()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
  })

  it('contains a spoofed repository native-preparation script through the real prepare operation', async () => {
    const outside = join(parent, 'native-escape')
    const installOutside = join(parent, 'install-escape')
    const fakeBin = join(root, 'bin')
    const fixtureEnv = { ...env, PATH: `${fakeBin}:${env['PATH'] ?? ''}` }
    const firewall = join(profile, 'cache/socket-firewall/bin/sfw')
    write(
      firewall,
      '#!/bin/sh\nif [ "$1" = --version ]; then echo 2.0.6; else exec "$@"; fi\n',
      true,
    )
    write(
      join(fakeBin, 'corepack'),
      `#!/usr/bin/env node
      const fs=require('node:fs'), cp=require('node:child_process');
      if(process.argv.includes('--version')) console.log('10.34.5');
      else if(process.argv.includes('install')) {
        fs.writeFileSync('install-ran','yes');
        try {fs.writeFileSync(${JSON.stringify(installOutside)},'escaped')}catch{}
      } else {const p=cp.spawnSync(process.execPath,['scripts/prepare-native-artifacts.mts'],{stdio:'inherit'});process.exit(p.status??1)}
    `,
      true,
    )
    write(
      join(root, 'scripts/prepare-native-artifacts.mts'),
      `import {writeFileSync} from 'node:fs';writeFileSync('native-ran','yes');writeFileSync(${JSON.stringify(outside)},'escaped')`,
    )
    await assert.rejects(
      prepareWorktree(root, {
        env: fixtureEnv,
        offline: true,
        signal: new AbortController().signal,
      }),
      /unavailable offline/,
    )
    assert.equal(readFileSync(join(root, 'install-ran'), 'utf8'), 'yes')
    assert.equal(readFileSync(join(root, 'native-ran'), 'utf8'), 'yes')
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync(installOutside), false)
    assert.equal(existsSync(join(root, DEV_STATE.dependencies)), false)
  })

  it('records a successful preparation, reuses it, and confines redirected readiness writes', async () => {
    const fixtureEnv = { ...env, PATH: `${join(root, 'bin')}:${env['PATH'] ?? ''}` }
    const files = {
      'node_modules/.modules.yaml': 'ready',
      'node_modules/esbuild/package.json': '{"version":"1.0.0"}',
      'node_modules/electron/package.json': '{"version":"44.0.0"}',
      'node_modules/electron/dist/version': '44.0.0',
      'node_modules/electron/path.txt': 'electron',
      'node_modules/electron/dist/electron': '#!/bin/sh\necho 152.0.7977.65\n',
      'node_modules/electron-chromedriver/bin/chromedriver':
        '#!/bin/sh\necho "ChromeDriver 152.0.7977.65"\n',
      'vendor/gortex/gortex': '#!/bin/sh\necho "gortex 0.60.0"\n',
    }
    write(
      join(root, 'scripts/prepare-native-artifacts.mts'),
      `
      import fs from 'node:fs';import path from 'node:path';
      for(const [name, contents] of Object.entries(${JSON.stringify(files)})) {
        fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name, contents);fs.chmodSync(name,0o755);
      }
      fs.appendFileSync('native-count','x');
    `,
    )
    const options = { env: fixtureEnv, offline: true, signal: new AbortController().signal }
    assert.equal((await prepareWorktree(root, options)).state, 'ready')
    assert.equal((await prepareWorktree(root, options)).state, 'ready')
    assert.equal(readFileSync(join(root, 'native-count'), 'utf8'), 'x')

    rmSync(join(root, DEV_STATE.dependencies))
    const outside = join(parent, 'redirected-fingerprint')
    symlinkSync(outside, join(root, DEV_STATE.dependencies))
    await assert.rejects(prepareWorktree(root, options), /failed/)
    assert.equal(existsSync(outside), false)
  })
})
