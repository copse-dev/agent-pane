import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PACKAGE_REGISTRY_ORIGIN,
  PNPM_STORE_DIR,
  dependencyInstallEnv,
  dependencyInstallFor,
} from './guest-install.ts'

describe('dependencyInstallFor', () => {
  it('picks pnpm for a pnpm lockfile, npm ci for a package-lock, nothing otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-install-'))
    try {
      assert.equal(dependencyInstallFor(dir), null)
      writeFileSync(join(dir, 'package-lock.json'), '{}\n')
      const npm = dependencyInstallFor(dir)
      assert.ok(npm)
      const [npmFetch, npmRebuild] = npm.steps
      assert.ok(npmFetch && npmRebuild)
      assert.equal(npmFetch.command, 'npm')
      assert.deepEqual(npmFetch.args.slice(0, 2), ['ci', '--ignore-scripts'])
      assert.equal(npmFetch.required, true)
      assert.deepEqual(npmRebuild.args.slice(0, 1), ['rebuild'])
      assert.equal(npmRebuild.required, false)
      // pnpm's lockfile wins when both are present: it is the one pnpm keeps.
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      const pnpm = dependencyInstallFor(dir)
      assert.ok(pnpm)
      assert.equal(pnpm.lockfile, 'pnpm-lock.yaml')
      const fetch = pnpm.steps[0]
      assert.ok(fetch)
      assert.equal(fetch.command, 'pnpm')
      assert.ok(fetch.args.includes('--frozen-lockfile'))
      assert.ok(fetch.args.includes('--ignore-scripts'), 'scripts run in their own step')
      assert.ok(fetch.args.includes(`--store-dir=${PNPM_STORE_DIR}`))
      assert.equal(fetch.required, true)
      assert.deepEqual(
        pnpm.steps.slice(1).map((step) => [step.label, step.required]),
        [['build native modules', false]],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs the project's own postinstall and prepare as best-effort steps, in that order", () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-install-'))
    try {
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { prepare: 'x', postinstall: 'y', test: 'z' } }),
      )
      const install = dependencyInstallFor(dir)
      assert.ok(install)
      assert.deepEqual(
        install.steps.map((step) => [step.label, step.args.join(' '), step.required]),
        [
          [
            'fetch and link',
            `install --frozen-lockfile --ignore-scripts --reporter=append-only --store-dir=${PNPM_STORE_DIR}`,
            true,
          ],
          ['build native modules', 'rebuild --reporter=append-only', false],
          ['project postinstall', 'run postinstall', false],
          ['project prepare', 'run prepare', false],
        ],
      )
      // A manifest that is not JSON costs the lifecycle steps, not the install.
      writeFileSync(join(dir, 'package.json'), '{not json')
      assert.equal(dependencyInstallFor(dir)?.steps.length, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the store beside the checkout, never inside it', () => {
    assert.ok(PNPM_STORE_DIR.startsWith('/workspace/'))
    assert.ok(!PNPM_STORE_DIR.startsWith('/workspace/repo'))
    assert.equal(PACKAGE_REGISTRY_ORIGIN, 'registry.npmjs.org:443')
  })
})

describe('dependencyInstallEnv', () => {
  it('gives the install the run proxy and switches every binary download off', () => {
    const env = dependencyInstallEnv(
      { PATH: '/usr/bin', HOME: '/home/copse' },
      { url: 'http://run:tok@127.0.0.1:3128', noProxy: '127.0.0.1' },
    )
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['HTTPS_PROXY'], 'http://run:tok@127.0.0.1:3128')
    assert.equal(env['http_proxy'], 'http://run:tok@127.0.0.1:3128')
    assert.equal(env['NO_PROXY'], '127.0.0.1')
    assert.equal(env['ELECTRON_SKIP_BINARY_DOWNLOAD'], '1')
    assert.equal(env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1')
    assert.equal(env['CI'], '1')
    const offline = dependencyInstallEnv({ PATH: '/usr/bin' }, null)
    assert.equal(offline['HTTPS_PROXY'], undefined)
  })
})
