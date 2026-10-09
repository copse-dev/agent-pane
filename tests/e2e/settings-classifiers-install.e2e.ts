import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { FAKE_WINNOW_PIN, writeFakeClassifierTools } from '../helpers/fake-classifier-tools.ts'

/**
 * "Download and run" in the real app: real IPC, the real manager, the real
 * cache preparation and real child processes. Only the tools at the process
 * boundary are fake (`git` and `python3` ahead of the system ones on PATH, see
 * tests/helpers/fake-classifier-tools.ts), so nothing is downloaded and the
 * "server" is a small HTTP listener on Winnow's port. The product has no test
 * flag: it simply finds a different `git` on its PATH.
 */

const CACHE = join(tmpdir(), 'copse-e2e-classifier-cache')
const WORK = mkdtempSync(join(tmpdir(), 'copse-e2e-classifier-tools-'))
const BIN = join(WORK, 'bin')
const LOG = join(WORK, 'calls.log')
const KEYS = [
  'PATH',
  'COPSE_CLASSIFIER_CACHE',
  'FAKE_LOG',
  'FAKE_GIT_MODE',
  'FAKE_PY_MODE',
  'FAKE_PY_SETUP_DELAY_MS',
] as const

describe('Download and run a local classifier', function () {
  this.timeout(120_000)
  const runnerEnv = new Map<string, string | undefined>(KEYS.map((key) => [key, process.env[key]]))

  /**
   * Hand the app an environment and restart it. The app inherits the runner's
   * environment as well as the env file, so `writeE2eEnv` sets both. The runner
   * starts its drivers by absolute path, so it does not need the real PATH while
   * the app has the fake one; `after` puts every value back.
   */
  async function restartWith(env: Record<string, string | undefined>): Promise<void> {
    writeE2eEnv(env)
    await browser.reloadSession()
  }

  const base = {
    // The app prepends /usr/bin and /bin to a PATH that lacks them, which would put the
    // real tools ahead of the fakes. Listing them after the fakes leaves nothing to prepend.
    PATH: `${BIN}:/usr/bin:/bin`,
    COPSE_CLASSIFIER_CACHE: CACHE,
    FAKE_LOG: LOG,
    FAKE_GIT_MODE: undefined,
    FAKE_PY_MODE: undefined,
    FAKE_PY_SETUP_DELAY_MS: undefined,
  }

  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    rmSync(CACHE, { recursive: true, force: true })
    writeFakeClassifierTools(BIN)
    writeFileSync(LOG, '')
  })

  after(async () => {
    writeE2eEnv(Object.fromEntries(KEYS.map((key) => [key, undefined])))
    for (const key of KEYS) {
      const original = runnerEnv.get(key)
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    resetUserData()
    rmSync(CACHE, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
  })

  async function open(env: Record<string, string | undefined>): Promise<void> {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-classifier-install')
    await restartWith({ ...base, ...env })
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('#settings-classifiers-host').waitForDisplayed()
    await $('[data-local-id="winnow"]').waitForDisplayed({ timeout: 10_000 })
  }

  async function phase(): Promise<string> {
    return $('[data-local-id="winnow"]').getAttribute('data-phase')
  }

  async function waitForPhase(expected: string, timeout = 30_000): Promise<void> {
    await browser.waitUntil(async () => (await phase()) === expected, {
      timeout,
      timeoutMsg: `Winnow never reached phase ${expected}; it is ${await phase()}`,
    })
  }

  async function downloadAndConfirm(): Promise<void> {
    await $('[data-local-id="winnow"] .classifier-local-install').click()
    await $('#confirm-dialog[open]').waitForDisplayed()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
  }

  /** The detail line of the row, as one string. */
  async function rowText(): Promise<string> {
    return $('[data-local-id="winnow"]').getText()
  }

  it('asks first, then sets up at the pinned revision, starts, and saves the connection', async () => {
    await open({ FAKE_PY_SETUP_DELAY_MS: '6000' })
    const row = $('[data-local-id="winnow"]')
    await expect(row).toHaveText(expect.stringContaining('Not installed'))
    await expect(row.$('.classifier-local-install')).toBeEnabled()

    await row.$('.classifier-local-install').click()
    await $('#confirm-dialog[open]').waitForDisplayed()
    await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('12.5 GB'))
    await expect($('#confirm-dialog')).toHaveText(
      expect.stringContaining('github.com/EldanRing/winnow-inference'),
    )
    await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('git, python3'))
    await saveElementScreenshot('#confirm-dialog', 'settings-classifiers-install-confirm.png')
    // Declining downloads nothing.
    await $('#confirm-dialog .confirm-dialog-cancel').click()
    // Detection only asks each tool for its version; nothing is cloned or set up until confirmed.
    assert.deepEqual(
      readFileSync(LOG, 'utf8')
        .split('\n')
        .filter((line) => line && !line.endsWith('--version')),
      [],
      'nothing was downloaded before the person confirmed',
    )
    assert.equal(await phase(), 'not-installed')

    await downloadAndConfirm()
    await waitForPhase('installing')
    await expect(row.$('.classifier-local-stop')).toHaveText('Cancel')
    assert.equal(await row.$('.classifier-local-install').isExisting(), false)
    await browser.waitUntil(async () => (await rowText()).includes('Downloading model'), {
      timeout: 15_000,
      timeoutMsg: `setup output never reached the row: ${await rowText()}`,
    })
    await saveElementScreenshot(
      '[data-local-id="winnow"]',
      'settings-classifiers-install-progress.png',
    )

    await waitForPhase('running', 60_000)
    await expect(row).toHaveText(expect.stringContaining('connection saved'))
    await expect(row.$('.classifier-local-stop')).toHaveText('Stop')
    assert.equal(await row.$('.classifier-local-error').isExisting(), false)
    // The connection exists, and was not chosen for screening or background questions.
    await expect($('[data-classifier-id="winnow"]')).toBeDisplayed()
    await expect($('[name="classifierScreening"]')).toHaveValue('')
    await expect($('[name="classifierBackground"]')).toHaveValue('')
    await saveElementScreenshot(
      '[data-local-id="winnow"]',
      'settings-classifiers-install-running.png',
    )

    const log = readFileSync(LOG, 'utf8')
    assert.match(log, /git clone --quiet https:\/\/github\.com\/EldanRing\/winnow-inference\.git /)
    assert.ok(log.includes(`git checkout --quiet --detach ${FAKE_WINNOW_PIN}`))
    assert.match(log, /python3 scripts\/setup\.py --text-only --model-dir /)
    assert.match(log, /python3 scripts\/serve\.py --text-only --model-dir /)
    assert.ok(existsSync(join(CACHE, 'winnow', FAKE_WINNOW_PIN, '.copse-setup-complete')))
  })

  it('answers an explicit test call from the server it started, and records its usage', async () => {
    // The app from the previous test is still up with Winnow running.
    await waitForPhase('running')
    const host = $('#settings-classifiers-host')
    await host.$('[data-classifier-id="winnow"]').click()
    const test = host.$('.classifier-test')
    await test.scrollIntoView({ block: 'center' })
    await test.click()
    await browser.waitUntil(
      async () => /Test succeeded/.test(await host.$('.classifier-status').getText()),
      { timeout: 15_000, timeoutMsg: 'the test call did not succeed' },
    )
    const result = await host.$('.classifier-status').getText()
    assert.match(result, /color: red/)
    assert.match(result, /winnow-fake/)
    await saveElementScreenshot(
      '#settings-classifiers-host',
      'settings-classifiers-install-test.png',
    )

    // The reported tokens reached the usage ledger as classifier usage.
    await $('#settings-dialog button[data-section="usage"]').click()
    const table = $('.usage-classifier-table')
    await table.waitForDisplayed({ timeout: 15_000 })
    await expect(table.$('tbody tr')).toHaveText(expect.stringContaining('Winnow-12B (local)'))
    await expect(table.$('tbody tr')).toHaveText(expect.stringContaining('winnow-fake'))
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('[data-local-id="winnow"]').waitForDisplayed()
  })

  it('stops, then uninstalls only after confirming, and leaves the saved connection', async () => {
    const row = $('[data-local-id="winnow"]')
    await row.$('.classifier-local-stop').click()
    await waitForPhase('installed')
    await expect(row.$('.classifier-local-start')).toBeDisplayed()
    await expect(row.$('.classifier-local-uninstall')).toBeDisplayed()
    await saveElementScreenshot(
      '[data-local-id="winnow"]',
      'settings-classifiers-install-stopped.png',
    )

    await row.$('.classifier-local-uninstall').click()
    await $('#confirm-dialog[open]').waitForDisplayed()
    await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('Uninstall Winnow-12B?'))
    await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('saved connection stays'))
    await saveElementScreenshot(
      '#confirm-dialog',
      'settings-classifiers-install-uninstall-confirm.png',
    )
    await $('#confirm-dialog .confirm-dialog-cancel').click()
    assert.ok(existsSync(join(CACHE, 'winnow')), 'declining deletes nothing')

    await row.$('.classifier-local-uninstall').click()
    await $('#confirm-dialog[open]').waitForDisplayed()
    await $('#confirm-dialog .confirm-dialog-confirm').click()
    await waitForPhase('not-installed')
    assert.equal(existsSync(join(CACHE, 'winnow')), false, 'the checkout and models are gone')
    await expect(row).toHaveText(expect.stringContaining('connection saved'))
    assert.equal((await $$('[data-classifier-id="winnow"]')).length, 1)
  })

  const failures: ReadonlyArray<{
    name: string
    env: Record<string, string>
    expected: RegExp
    screenshot: string
  }> = [
    {
      name: 'offline',
      env: { FAKE_GIT_MODE: 'offline' },
      expected:
        /Could not reach the network to download Winnow-12B.*Could not resolve host: github\.com/s,
      screenshot: 'settings-classifiers-install-offline.png',
    },
    {
      name: 'a pinned version that cannot be fetched',
      env: { FAKE_GIT_MODE: 'bad-rev' },
      expected: /Could not fetch the pinned version of Winnow-12B \(77d14580c673\)/,
      screenshot: 'settings-classifiers-install-bad-revision.png',
    },
    {
      name: 'running out of disk space',
      env: { FAKE_PY_MODE: 'enospc' },
      expected: /Winnow-12B ran out of disk space during setup/,
      screenshot: 'settings-classifiers-install-no-space.png',
    },
  ]

  for (const failure of failures) {
    it(`shows ${failure.name} on the row and offers to try again`, async () => {
      rmSync(CACHE, { recursive: true, force: true })
      await open(failure.env)
      await downloadAndConfirm()
      const row = $('[data-local-id="winnow"]')
      await row.$('.classifier-local-error').waitForDisplayed({ timeout: 30_000 })
      assert.match(await row.$('.classifier-local-error').getText(), failure.expected)
      assert.equal(await phase(), 'not-installed')
      await expect(row.$('.classifier-local-install')).toBeEnabled()
      assert.equal(
        (await $$('[data-classifier-id="winnow"]')).length,
        0,
        'a failed setup saves no connection',
      )
      await saveElementScreenshot('[data-local-id="winnow"]', failure.screenshot)
    })
  }
})
