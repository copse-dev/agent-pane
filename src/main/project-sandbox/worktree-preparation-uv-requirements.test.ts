import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { baseSandboxConfig } from './config.ts'
import { setProjectSandboxEnabled } from './enabled.ts'
import { runWorktreePreparationProcess } from './worktree-preparation.ts'
import { inspectWorktreePreparation, prepareWorktree } from '../services/worktree-preparation.ts'
import {
  formatPreparationApproval,
  readWorktreePreparationPlan,
} from '../services/worktree-preparation-plan.ts'

it(
  'prepares an explicit hash-locked uv requirements declaration on installed Python 3.9 offline',
  { skip: process.platform === 'win32' },
  async (t) => {
    const python = ['python3.9', '/usr/bin/python3'].find((candidate) => {
      const result = spawnSync(
        candidate,
        ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
        { encoding: 'utf8' },
      )
      return result.status === 0 && result.stdout.trim() === '3.9'
    })
    // The readiness check needs `uv pip sync --check`, which uv 0.12.18 added.
    // An older uv rejects the option, so the fixture could never reach ready.
    const syncHelp = spawnSync('uv', ['pip', 'sync', '--help'], { encoding: 'utf8' })
    const uvHasSyncCheck = syncHelp.status === 0 && /^\s*--check(?:\s|$)/m.test(syncHelp.stdout)
    if (!python || !uvHasSyncCheck) {
      t.skip(
        'requires already-installed Python 3.9 and uv 0.12.18 or later (`uv pip sync --check`); no runtime or installer download',
      )
      return
    }
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'uv-requirements-declaration-')))
    t.after(() => {
      rmSync(parent, { recursive: true, force: true })
    })
    const root = join(parent, 'project')
    mkdirSync(join(root, 'vendor'), { recursive: true })
    mkdirSync(join(root, '.copse'))
    const wheel = join(root, 'vendor', 'sample_fixture-1.0.0-py3-none-any.whl')
    const archive = spawnSync(
      python,
      [
        '-I',
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
    const lock = `sample-fixture==1.0.0 --hash=sha256:${createHash('sha256').update(readFileSync(wheel)).digest('hex')}\n`
    const manifest =
      '[project]\nname="ordinary-python39"\nversion="0.1.0"\nrequires-python="==3.9.*"\n'
    writeFileSync(join(root, 'requirements.lock'), lock)
    writeFileSync(join(root, 'pyproject.toml'), manifest)
    writeFileSync(join(root, '.python-version'), '3.9\n')
    const identityArgs = [
      '-I',
      '-c',
      'import sys; print(sys.version); print(sys.implementation.cache_tag); print(sys.base_prefix)',
    ]
    const hostIdentity = spawnSync(python, identityArgs, { encoding: 'utf8' })
    assert.equal(hostIdentity.status, 0)
    const syncArgs = [
      'pip',
      'sync',
      '--python',
      '.venv/bin/python',
      '--no-python-downloads',
      '--require-hashes',
      '--only-binary=:all:',
      '--no-index',
      '--find-links',
      'vendor',
      'requirements.lock',
    ]
    writeFileSync(
      join(root, '.copse/worktree-preparation.json'),
      JSON.stringify({
        version: 1,
        inputs: ['requirements.lock', 'pyproject.toml', '.python-version', 'vendor'],
        prepare: [
          { command: python, args: ['-m', 'venv', '--without-pip', '.venv'] },
          { command: 'uv', args: syncArgs },
        ],
        checks: [
          { name: 'uv', command: { command: 'uv', args: ['--version'] }, fingerprintOutput: true },
          {
            name: 'Python environment',
            path: '.venv/bin/python',
            command: { command: '.venv/bin/python', args: identityArgs },
            fingerprintOutput: true,
          },
          {
            name: 'Hash-locked requirements',
            command: { command: 'uv', args: [...syncArgs, '--check', '--offline', '--no-cache'] },
          },
          {
            name: 'Consistent dependencies',
            command: {
              command: 'uv',
              args: [
                'pip',
                'check',
                '--python',
                '.venv/bin/python',
                '--no-python-downloads',
                '--offline',
                '--no-cache',
              ],
            },
          },
        ],
      }),
    )
    const env = { ...process.env, COPSE_DIR: join(parent, 'profile') }
    try {
      await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
      setProjectSandboxEnabled(true)
      const plan = readWorktreePreparationPlan(root)
      assert.deepEqual(plan.problems, [])
      assert.equal(
        plan.ecosystem,
        null,
        'the explicit declaration owns setup; this is not automatic pip readiness',
      )
      const approval = formatPreparationApproval(plan, true)
      assert.match(approval.body, /--without-pip/)
      assert.match(approval.body, /--require-hashes/)
      assert.match(approval.body, /--only-binary=:all:/)
      assert.match(approval.bodyAdvice, /executes repository code/)
      const before = await inspectWorktreePreparation(root, { env })
      assert.equal(before.state, 'absent')
      const prepare = (): ReturnType<typeof prepareWorktree> =>
        prepareWorktree(root, {
          env,
          offline: true,
          planFingerprint: before.planFingerprint,
          signal: new AbortController().signal,
        })
      assert.equal((await prepare()).state, 'ready')
      assert.equal(
        await runWorktreePreparationProcess('.venv/bin/python', identityArgs, {
          root,
          env,
          mode: 'preflight',
          offline: true,
        }),
        hostIdentity.stdout.trim(),
      )
      assert.equal(
        await runWorktreePreparationProcess(
          '.venv/bin/python',
          ['-I', '-c', 'import sample_fixture; print(sample_fixture.VALUE)'],
          { root, env, mode: 'preflight', offline: true },
        ),
        '42',
      )
      assert.equal((await inspectWorktreePreparation(root, { env, offline: true })).state, 'ready')
      const site = await runWorktreePreparationProcess(
        '.venv/bin/python',
        ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
        { root, env, mode: 'preflight', offline: true },
      )
      assert.ok(site.startsWith(join(root, '.venv') + sep))
      rmSync(join(site, 'sample_fixture-1.0.0.dist-info'), { recursive: true })
      assert.equal((await inspectWorktreePreparation(root, { env })).state, 'corrupt')
      assert.equal((await prepare()).state, 'ready')
      assert.equal(readFileSync(join(root, 'requirements.lock'), 'utf8'), lock)
      assert.equal(readFileSync(join(root, 'pyproject.toml'), 'utf8'), manifest)
      assert.equal(readFileSync(join(root, '.python-version'), 'utf8'), '3.9\n')
      assert.equal(
        spawnSync(python, identityArgs, { encoding: 'utf8' }).stdout,
        hostIdentity.stdout,
      )
      t.diagnostic(
        'Existing declaration prepared/repaired exact installed Python 3.9 offline with ordinary hash-locked wheel; no pip bootstrap or security-overlay execution',
      )
    } finally {
      setProjectSandboxEnabled(false)
      await SandboxManager.reset()
    }
  },
)
