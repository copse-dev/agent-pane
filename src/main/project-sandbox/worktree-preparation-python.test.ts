import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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

const WHEEL_FIXTURE_SCRIPT = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as wheel:
    wheel.writestr('sample_fixture.py', 'VALUE = 42\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: sample-fixture\\nVersion: 1.0.0\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/RECORD', '')
`

function serveWheel(wheel: string, wheelName: string): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    if (request.url === '/simple/sample-fixture/') {
      response.setHeader('content-type', 'text/html')
      response.end(`<a href="/packages/${wheelName}">${wheelName}</a>`)
      return
    }
    if (request.url === `/packages/${wheelName}`) {
      response.end(readFileSync(wheel))
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
}

async function exercisePipPreparation(
  parent: string,
  root: string,
  wheel: string,
  wheelName: string,
): Promise<void> {
  const server = serveWheel(wheel, wheelName)
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const env = {
    ...process.env,
    COPSE_DIR: join(parent, 'profile'),
    PIP_INDEX_URL: `http://127.0.0.1:${String(address.port)}/simple`,
    PIP_TRUSTED_HOST: '127.0.0.1',
  }
  try {
    await runPipPreparationFixture(root, env)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise()
      })
    })
    rmSync(parent, { recursive: true, force: true })
  }
}

async function runPipPreparationFixture(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    await preparePipFixture(root, env)
  } finally {
    setProjectSandboxEnabled(false)
    await SandboxManager.reset()
  }
}

async function preparePipFixture(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const before = await inspectWorktreePreparation(root, { env })
  assert.equal(before.state, 'absent')
  const prepared = await prepareWorktree(root, {
    env,
    planFingerprint: before.planFingerprint,
    offline: false,
    signal: new AbortController().signal,
  })
  assert.equal(prepared.state, 'ready')
  assert.equal(
    await runWorktreePreparationProcess(
      '.venv/bin/python',
      ['-I', '-c', 'import sample_fixture; print(sample_fixture.VALUE)'],
      { root, env, mode: 'preflight', offline: true },
    ),
    '42',
  )
  assert.equal((await inspectWorktreePreparation(root, { env, offline: true })).state, 'ready')
}

it(
  'preflight scratch is disposable and does not grant project or shared-cache writes',
  { skip: process.platform === 'win32' },
  async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'preflight-scratch-test-')))
    const root = join(parent, 'project')
    mkdirSync(root)
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    try {
      const scratch = await runWorktreePreparationProcess(
        process.execPath,
        [
          '-e',
          `
      const fs=require('node:fs'),path=require('node:path');
      fs.writeFileSync(path.join(process.env.TMPDIR,'bookkeeping'),'ok');
      try{fs.writeFileSync('escape','bad');process.exit(2)}catch{}
      console.log(process.env.TMPDIR);
    `,
        ],
        {
          root,
          env: { ...process.env, COPSE_DIR: join(parent, 'profile') },
          mode: 'preflight',
          offline: true,
        },
      )
      assert.equal(existsSync(scratch), false)
      assert.deepEqual(readdirSync(root), [])
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
      rmSync(parent, { recursive: true, force: true })
    }
  },
)

it(
  'prepares and repairs a real locked uv dependency offline without a project declaration',
  { skip: process.platform === 'win32' },
  async (t) => {
    if (
      spawnSync('uv', ['--version']).status !== 0 ||
      spawnSync('python3', ['--version']).status !== 0
    ) {
      t.skip('real uv fixture requires installed uv and Python; no global tool installation')
      return
    }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'uv-preparation-test-')))
    const root = join(parent, 'project')
    mkdirSync(join(root, 'vendor'), { recursive: true })
    const wheel = join(root, 'vendor/sample_fixture-1.0.0-py3-none-any.whl')
    const archive = spawnSync(
      'python3',
      [
        '-c',
        `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as wheel:
    wheel.writestr('sample_fixture.py', 'VALUE = 42\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: sample-fixture\\nVersion: 1.0.0\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
    wheel.writestr('sample_fixture-1.0.0.dist-info/RECORD', '')
`,
        wheel,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(archive.status, 0, archive.stderr)
    const manifest =
      '[project]\nname="ordinary-app"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=["sample-fixture==1.0.0"]\n[tool.uv.sources]\nsample-fixture={path="vendor/sample_fixture-1.0.0-py3-none-any.whl"}\n'
    writeFileSync(join(root, 'pyproject.toml'), manifest)
    // Fixture authoring creates the reviewed lock. The product only consumes it.
    const lock = spawnSync(
      'uv',
      ['lock', '--offline', '--no-python-downloads', '--cache-dir', join(parent, 'author-cache')],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(lock.status, 0, lock.stderr)
    const originalLock = readFileSync(join(root, 'uv.lock'), 'utf8')
    const env = { ...process.env, COPSE_DIR: join(parent, 'profile') }
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    setProjectSandboxEnabled(true)
    try {
      const before = await inspectWorktreePreparation(root, { env })
      assert.equal(before.state, 'absent')
      const options = {
        env,
        planFingerprint: before.planFingerprint,
        offline: true,
        signal: new AbortController().signal,
      }
      assert.equal((await prepareWorktree(root, options)).state, 'ready')
      assert.equal((await prepareWorktree(root, options)).state, 'ready')
      assert.equal(readFileSync(join(root, 'uv.lock'), 'utf8'), originalLock)
      assert.equal(
        await runWorktreePreparationProcess(
          '.venv/bin/python',
          ['-I', '-c', 'import sample_fixture; print(sample_fixture.VALUE)'],
          { root, env, mode: 'preflight', offline: true },
        ),
        '42',
      )
      const pythonLib = readdirSync(join(root, '.venv/lib')).find((name) =>
        name.startsWith('python'),
      )
      assert.ok(pythonLib)
      const sitePackages = join(root, '.venv/lib', pythonLib, 'site-packages')
      rmSync(join(sitePackages, 'sample_fixture-1.0.0.dist-info'), { recursive: true })
      assert.equal((await inspectWorktreePreparation(root, { env })).state, 'corrupt')
      assert.equal((await prepareWorktree(root, options)).state, 'ready')
      writeFileSync(
        join(root, 'pyproject.toml'),
        manifest.replace('dependencies=[', 'dependencies=["unavailable-fixture==1.0.0",'),
      )
      await assert.rejects(prepareWorktree(root, options), /plan changed/)
      const stale = await inspectWorktreePreparation(root, { env })
      assert.match(
        stale.components.find((component) => component.name === 'Locked Python dependencies')
          ?.detail ?? '',
        /uv failed|lock|resolve/i,
      )
      await assert.rejects(
        prepareWorktree(root, { ...options, planFingerprint: stale.planFingerprint }),
        /unavailable offline/,
      )
      assert.equal(readFileSync(join(root, 'uv.lock'), 'utf8'), originalLock)
      writeFileSync(join(root, 'pyproject.toml'), manifest)
      rmSync(join(root, '.venv'), { recursive: true })
      rmSync(wheel)
      assert.equal(
        (await inspectWorktreePreparation(root, { env, offline: true })).state,
        'unavailable-offline',
      )
      await assert.rejects(prepareWorktree(root, options), /unavailable offline/)
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
      rmSync(parent, { recursive: true, force: true })
    }
  },
)

it(
  'installs a real hash-locked wheel through pip without running source builds',
  { skip: process.platform === 'win32' },
  async (t) => {
    if (spawnSync('python3', ['-m', 'pip', '--version']).status !== 0) {
      t.skip('real pip fixture requires installed Python and pip; no global tool installation')
      return
    }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'pip-preparation-test-')))
    const root = join(parent, 'project')
    mkdirSync(join(root, 'vendor'), { recursive: true })
    const wheelName = 'sample_fixture-1.0.0-py3-none-any.whl'
    const wheel = join(root, 'vendor', wheelName)
    const archive = spawnSync('python3', ['-c', WHEEL_FIXTURE_SCRIPT, wheel], {
      encoding: 'utf8',
    })
    assert.equal(archive.status, 0, archive.stderr)
    const hash = createHash('sha256').update(readFileSync(wheel)).digest('hex')
    writeFileSync(join(root, 'requirements.lock'), `sample-fixture==1.0.0 --hash=sha256:${hash}\n`)
    await exercisePipPreparation(parent, root, wheel, wheelName)
  },
)
