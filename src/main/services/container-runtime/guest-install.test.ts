import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { volumeTrouble } from './guest-install.ts'
import {
  DEPENDENCY_INSTALL_ORIGINS,
  electronBinaryStep,
  guestEnvironmentNote,
  sanitizedOriginUrl,
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
        [
          ['build native modules', false],
          ['fetch the Electron binary', false],
        ],
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
          ['fetch the Electron binary', 'install.js', false],
          ['project postinstall', 'run postinstall', false],
          ['project prepare', 'run prepare', false],
        ],
      )
      // A manifest that is not JSON costs the lifecycle steps, not the install.
      writeFileSync(join(dir, 'package.json'), '{not json')
      assert.equal(dependencyInstallFor(dir)?.steps.length, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the store beside the checkout, never inside it', () => {
    assert.ok(PNPM_STORE_DIR.startsWith('/workspace/'))
    assert.ok(!PNPM_STORE_DIR.startsWith('/workspace/repo'))
    assert.equal(PACKAGE_REGISTRY_ORIGIN, 'registry.npmjs.org:443')
  })

  it('admits the registry and GitHub, on 443 only, and nothing else', () => {
    assert.ok(DEPENDENCY_INSTALL_ORIGINS.includes(PACKAGE_REGISTRY_ORIGIN))
    assert.ok(DEPENDENCY_INSTALL_ORIGINS.includes('github.com:443'))
    assert.ok(DEPENDENCY_INSTALL_ORIGINS.includes('*.githubusercontent.com:443'))
    for (const origin of DEPENDENCY_INSTALL_ORIGINS) assert.match(origin, /:443$/)
    assert.ok(DEPENDENCY_INSTALL_ORIGINS.includes('*.electronjs.org:443'))
    assert.ok(
      !DEPENDENCY_INSTALL_ORIGINS.some((origin) => origin.includes('nodejs.org')),
      'node headers come from the image',
    )
    assert.equal(DEPENDENCY_INSTALL_ORIGINS.length, 6)
  })
})

describe('volumeTrouble', () => {
  it('is silent for a directory that takes writes and names the failure for one that does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-volume-'))
    try {
      assert.equal(volumeTrouble(dir), null)
      assert.match(volumeTrouble(join(dir, 'gone')) ?? '', /no longer takes writes \(ENOENT\)/)
      assert.match(volumeTrouble(join(dir, 'gone')) ?? '', /no longer mounted, or the disk/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    assert.equal(
      env['ELECTRON_SKIP_BINARY_DOWNLOAD'],
      undefined,
      'Electron comes from GitHub, which the install admits',
    )
    assert.equal(env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1')
    assert.equal(env['CI'], '1')
    const offline = dependencyInstallEnv({ PATH: '/usr/bin' }, null)
    assert.equal(offline['HTTPS_PROXY'], undefined)
    assert.equal(offline['npm_config_nodedir'], undefined)
    const withHeaders = dependencyInstallEnv({}, null, { nodeDir: '/usr/local' })
    assert.equal(withHeaders['npm_config_nodedir'], '/usr/local')
  })
})

describe('guestEnvironmentNote', () => {
  it('always says the shell is offline, then what the install left', () => {
    for (const note of [
      guestEnvironmentNote(null),
      guestEnvironmentNote({ lockfile: null, failed: [], aborted: false }),
      guestEnvironmentNote({ lockfile: 'pnpm-lock.yaml', failed: [], aborted: false }),
      guestEnvironmentNote({
        lockfile: 'pnpm-lock.yaml',
        failed: ['project postinstall'],
        aborted: false,
      }),
      guestEnvironmentNote({
        lockfile: 'pnpm-lock.yaml',
        failed: ['fetch and link'],
        aborted: true,
      }),
    ]) {
      assert.match(note, /no network access/)
      assert.match(note, /do not run installs/)
    }
    assert.match(guestEnvironmentNote(null), /not installed for this run/)
    assert.match(
      guestEnvironmentNote({ lockfile: null, failed: [], aborted: false }),
      /No lockfile/,
    )
    assert.match(
      guestEnvironmentNote({ lockfile: 'pnpm-lock.yaml', failed: [], aborted: false }),
      /installed from pnpm-lock\.yaml before you started\./,
    )
    assert.match(
      guestEnvironmentNote({
        lockfile: 'pnpm-lock.yaml',
        failed: ['project postinstall'],
        aborted: false,
      }),
      /skipped: project postinstall/,
    )
    assert.match(
      guestEnvironmentNote({
        lockfile: 'pnpm-lock.yaml',
        failed: ['fetch and link'],
        aborted: true,
      }),
      /treat node_modules as absent/,
    )
  })
})

describe('electronBinaryStep', () => {
  it('runs only when the package is there and its binary is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-electron-'))
    try {
      const step = electronBinaryStep(dir)
      assert.equal(step.required, false)
      assert.equal(step.cwd, join(dir, 'node_modules', 'electron'))
      const when = step.when
      assert.ok(when)
      assert.equal(when(), false, 'no package')
      mkdirSync(join(dir, 'node_modules', 'electron', 'dist'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'electron', 'install.js'), '')
      assert.equal(when(), true, 'package without a binary')
      writeFileSync(join(dir, 'node_modules', 'electron', 'dist', 'electron'), '')
      assert.equal(when(), false, 'binary present')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sanitizedOriginUrl', () => {
  it('keeps the address and drops any credential in it', () => {
    assert.equal(sanitizedOriginUrl(null), null)
    assert.equal(sanitizedOriginUrl('  '), null)
    assert.equal(
      sanitizedOriginUrl('https://x-access-token:ghp_secret@github.com/copse-dev/agent-pane.git'),
      'https://github.com/copse-dev/agent-pane.git',
    )
    assert.equal(
      sanitizedOriginUrl('git@github.com:copse-dev/agent-pane.git'),
      'git@github.com:copse-dev/agent-pane.git',
    )
    assert.equal(sanitizedOriginUrl('/Users/me/repo'), '/Users/me/repo')
  })
})
