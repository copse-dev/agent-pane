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
import {
  PREPARATION_CONFIG,
  PREPARATION_STAMP,
  readWorktreePreparationPlan,
} from '../services/worktree-preparation-plan.ts'

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
    prepareWorktree(root, {
      env,
      planFingerprint: '0'.repeat(64),
      signal: new AbortController().signal,
    }),
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
      join(root, PREPARATION_CONFIG),
      JSON.stringify({
        version: 1,
        checks: [
          { name: 'Runtime', command: { command: './probe', args: [] }, outputIncludes: 'ready' },
        ],
      }),
    )
    const targets = [
      join(root, 'probe-write'),
      join(profile, 'cache/pnpm-store/probe-write'),
      join(parent, 'probe-write'),
    ]
    write(
      join(root, 'probe'),
      `#!/usr/bin/env node\nconst fs=require('node:fs');for(const p of ${JSON.stringify(targets)}){try{fs.writeFileSync(p,'escaped')}catch{}}console.log('ready')`,
      true,
    )
    const report = await inspectWorktreePreparation(root, { env })
    assert.equal(
      report.components.find((component) => component.name === 'Runtime')?.ready,
      true,
      JSON.stringify(report),
    )
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
    write(
      join(root, 'package.json'),
      JSON.stringify({ name: 'unrelated-app', packageManager: 'pnpm@10.34.5' }),
    )
    write(join(root, 'pnpm-lock.yaml'), 'fixture lock')
    write(
      join(root, PREPARATION_CONFIG),
      JSON.stringify({
        version: 1,
        inputs: ['scripts/setup.mjs'],
        prepare: [{ command: 'node', args: ['scripts/setup.mjs'] }],
        checks: [{ name: 'Built artifact', path: 'artifact' }],
      }),
    )
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
      } else {const p=cp.spawnSync(process.execPath,['scripts/setup.mjs'],{stdio:'inherit'});process.exit(p.status??1)}
    `,
      true,
    )
    write(
      join(root, 'scripts/setup.mjs'),
      `import {writeFileSync} from 'node:fs';writeFileSync('native-ran','yes');writeFileSync(${JSON.stringify(outside)},'escaped')`,
    )
    await assert.rejects(
      prepareWorktree(root, {
        env: fixtureEnv,
        planFingerprint: readWorktreePreparationPlan(root).fingerprint,
        offline: true,
        signal: new AbortController().signal,
      }),
      /unavailable offline/,
    )
    assert.equal(readFileSync(join(root, 'install-ran'), 'utf8'), 'yes')
    assert.equal(readFileSync(join(root, 'native-ran'), 'utf8'), 'yes')
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync(installOutside), false)
    assert.equal(existsSync(join(root, PREPARATION_STAMP)), false)
  })

  it('records a successful preparation, reuses it, and confines redirected readiness writes', async () => {
    const fixtureEnv = { ...env, PATH: `${join(root, 'bin')}:${env['PATH'] ?? ''}` }
    const files = { artifact: 'prepared' }
    write(
      join(root, 'scripts/setup.mjs'),
      `
      import fs from 'node:fs';import path from 'node:path';
      for(const [name, contents] of Object.entries(${JSON.stringify(files)})) {
        fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name, contents);fs.chmodSync(name,0o755);
      }
      fs.appendFileSync('native-count','x');
    `,
    )
    const options = {
      env: fixtureEnv,
      offline: true,
      planFingerprint: readWorktreePreparationPlan(root).fingerprint,
      signal: new AbortController().signal,
    }
    assert.equal((await prepareWorktree(root, options)).state, 'ready')
    assert.equal((await prepareWorktree(root, options)).state, 'ready')
    assert.equal(readFileSync(join(root, 'native-count'), 'utf8'), 'x')

    rmSync(join(root, PREPARATION_STAMP))
    const outside = join(parent, 'redirected-fingerprint')
    symlinkSync(outside, join(root, PREPARATION_STAMP))
    await assert.rejects(prepareWorktree(root, options), /failed/)
    assert.equal(existsSync(outside), false)
  })
  it('prepares a non-Node project and rejects a changed plan before executing it', async () => {
    const other = join(parent, 'non-node')
    write(
      join(other, PREPARATION_CONFIG),
      JSON.stringify({
        version: 1,
        inputs: ['setup.sh'],
        prepare: [{ command: '/bin/sh', args: ['setup.sh'] }],
        checks: [{ name: 'Build output', path: 'output' }],
      }),
    )
    write(join(other, 'setup.sh'), 'printf prepared > output\n')
    const options = {
      env: { ...env, PATH: '/usr/bin:/bin' },
      offline: true,
      planFingerprint: readWorktreePreparationPlan(other).fingerprint,
      signal: new AbortController().signal,
    }
    assert.equal((await prepareWorktree(other, options)).state, 'ready')
    assert.equal(readFileSync(join(other, 'output'), 'utf8'), 'prepared')
    write(join(other, 'setup.sh'), 'printf changed > output\n')
    await assert.rejects(prepareWorktree(other, options), /plan changed/)
    assert.equal(readFileSync(join(other, 'output'), 'utf8'), 'prepared')
  })
  it('validates a real Python virtual environment whose interpreter is a symlink', async () => {
    const other = join(parent, 'python-project')
    write(
      join(other, PREPARATION_CONFIG),
      JSON.stringify({
        version: 1,
        prepare: [{ command: 'python3', args: ['-m', 'venv', '--without-pip', '.venv'] }],
        checks: [
          {
            name: 'Python environment',
            path: '.venv/bin/python',
            command: { command: '.venv/bin/python', args: ['--version'] },
            outputIncludes: 'Python',
          },
        ],
      }),
    )
    const options = {
      env,
      offline: true,
      planFingerprint: readWorktreePreparationPlan(other).fingerprint,
      signal: new AbortController().signal,
    }
    assert.equal((await prepareWorktree(other, options)).state, 'ready')
    assert.equal((await prepareWorktree(other, options)).state, 'ready')
  })
  it('adapts the legacy Yarn CA setting while retaining the firewall proxy and Node trust', async () => {
    const other = join(parent, 'yarn-compatibility')
    const bin = join(other, 'bin')
    const certificate = join(other, 'test-ca.pem')
    write(join(other, 'package.json'), '{"packageManager":"yarn@3.8.7"}')
    write(join(other, 'yarn.lock'), '__metadata:\n  version: 6')
    write(certificate, '')
    write(
      join(profile, 'cache/socket-firewall/bin/sfw'),
      `#!/bin/sh
if [ "$1" = --version ]; then echo 2.0.6; exit 0; fi
export YARN_HTTPS_CA_FILE_PATH=legacy-unsupported
export NODE_EXTRA_CA_CERTS=${JSON.stringify(certificate)}
export HTTPS_PROXY=http://127.0.0.1:12345
exec "$@"
`,
      true,
    )
    write(
      join(bin, 'corepack'),
      `#!/usr/bin/env node
if(process.argv.includes('--version')) console.log('3.8.7');
else {
  const assert=require('node:assert/strict');
  assert.equal(process.env.YARN_HTTPS_CA_FILE_PATH,undefined);
  assert.equal(process.env.NODE_EXTRA_CA_CERTS,${JSON.stringify(certificate)});
  assert.equal(process.env.HTTPS_PROXY,'http://127.0.0.1:12345');
  require('node:fs').writeFileSync('compatibility-checked','yes');
}
`,
      true,
    )
    const options = {
      env: { ...env, PATH: `${bin}:${env['PATH'] ?? ''}` },
      offline: true,
      planFingerprint: readWorktreePreparationPlan(other).fingerprint,
      signal: new AbortController().signal,
    }
    assert.equal((await prepareWorktree(other, options)).state, 'ready')
    assert.equal(readFileSync(join(other, 'compatibility-checked'), 'utf8'), 'yes')
  })
})
