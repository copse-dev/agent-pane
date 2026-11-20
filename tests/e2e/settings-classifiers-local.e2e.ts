import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  pinTextForCapture,
  saveElementScreenshot,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

const WINNOW_PORT = 8091

/**
 * Detection and install offers for self-hosted classifiers. A real listener on
 * Winnow's port stands in for a server started elsewhere; the app only probes
 * the port, so no model, Python or download is involved. The install itself is
 * covered by the manager's unit tests.
 */
describe('local classifier servers in settings', () => {
  let listener: Server | undefined

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ TYPESAFE_API_KEY: 'e2e-not-a-real-key', FEATHERLESS_API_KEY: '' })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-classifier-local')
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({ TYPESAFE_API_KEY: undefined, FEATHERLESS_API_KEY: undefined })
    resetUserData()
    await new Promise<void>((resolve) => {
      if (!listener) {
        resolve()
        return
      }
      listener.close(() => {
        resolve()
      })
    })
  })

  async function openClassifiers(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('#settings-classifiers-host').waitForDisplayed()
  }

  it('offers a download for servers that are not installed and a setup for a key it found', async () => {
    await openClassifiers()
    const winnow = $('[data-local-id="winnow"]')
    await winnow.waitForDisplayed({ timeout: 10_000 })
    await expect(winnow).toHaveText(expect.stringContaining('Not installed'))
    // Whether a server can be downloaded depends on the tools on this machine's PATH.
    await expect($('[data-local-id="kev"]')).toHaveText(expect.stringContaining('Not installed'))
    const strands = $('[data-local-id="strands-decider"]')
    await expect(strands).toHaveText(expect.stringContaining('Strands Decider 2B'))
    await expect(strands).toHaveText(expect.stringContaining('Not installed'))
    const hosted = $('[data-hosted-id="typesafe"]')
    await expect(hosted).toHaveText(expect.stringContaining('TYPESAFE_API_KEY'))
    assert.equal(
      await $('[data-hosted-id="featherless"]').isExisting(),
      false,
      'an empty key is not a hint',
    )
    // The key's value is never shown.
    assert.equal(
      (await $('#settings-classifiers-host').getText()).includes('e2e-not-a-real-key'),
      false,
    )

    // The captures show Winnow only: whether Kev is offered depends on uv being on this machine's PATH.
    // The download asks first, naming size, source and tools, and does nothing when declined.
    const install = winnow.$('.classifier-local-install')
    if (await install.isEnabled()) {
      await expect(winnow).toHaveText(expect.stringContaining('12.5 GB'))
      await install.click()
      await $('#confirm-dialog[open]').waitForDisplayed()
      await expect($('#confirm-dialog')).toHaveText(expect.stringContaining('12.5 GB'))
      await expect($('#confirm-dialog')).toHaveText(
        expect.stringContaining('github.com/EldanRing/winnow-inference'),
      )
      await saveElementScreenshot('#confirm-dialog', 'settings-classifiers-local-confirm.png')
      await $('#confirm-dialog .confirm-dialog-cancel').click()
      await expect(winnow).toHaveText(expect.stringContaining('Not installed'))
    }
    await saveElementScreenshot('[data-local-id="winnow"]', 'settings-classifiers-local-offer.png')
  })

  it('detects a server that is already running and adds its connection on request', async () => {
    listener = createServer((socket) => {
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      listener?.once('error', reject)
      listener?.listen(WINNOW_PORT, '127.0.0.1', resolve)
    })
    // Reopening the section probes again.
    await $('#settings-dialog button[data-section="general"]').click()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    const winnow = $('[data-local-id="winnow"]')
    await browser.waitUntil(async () => (await winnow.getAttribute('data-phase')) === 'external', {
      timeout: 10_000,
      timeoutMsg: 'a listener on the Winnow port was not detected',
    })
    await expect(winnow).toHaveText(expect.stringContaining('Detected running on'))
    assert.equal(await winnow.$('.classifier-local-install').isExisting(), false)

    await winnow.$('.classifier-local-connect').click()
    await browser.waitUntil(
      async () => (await $$('[data-classifier-id="winnow"]').getElements()).length === 1,
      {
        timeout: 10_000,
        timeoutMsg: 'the detected server was not saved as a connection',
      },
    )
    await expect(winnow).toHaveText(expect.stringContaining('connection saved'))
    assert.equal(await winnow.$('.classifier-local-connect').isExisting(), false)
    await saveElementScreenshot(
      '[data-local-id="winnow"]',
      'settings-classifiers-local-detected.png',
    )
  })

  it('offers Strands Decider as a keyless preset for its local server', async () => {
    // Strands Decider's catalog row looks like Winnow's (above), and its offer depends on
    // uv being on PATH, as Kev's does; the preset it saves is what this captures.
    const host = $('#settings-classifiers-host')
    await host.$('.classifier-add').click()
    await host.$('[name="classifierPreset"]').selectByAttribute('value', 'strands-decider')
    await host.$('.classifier-create').click()
    await expect(host.$('[name="classifierLabel"]')).toHaveValue('Strands Decider 2B (local)')
    await expect(host.$('[name="classifierModel"]')).toHaveValue(
      'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    )
    await expect(host.$('[name="classifierUrl"]')).toHaveValue('http://127.0.0.1:8011/v1')
    await expect(host.$('.classifier-credentials')).not.toBeDisplayed()
    // The draft's profile ID ends in a random suffix.
    const restore = await pinTextForCapture(
      '#settings-classifiers-host .classifier-form .field-hint code',
      /-[0-9a-f]{8}$/,
      '-00000000',
    )
    try {
      await saveElementScreenshot(
        '#settings-classifiers-host .classifier-form',
        'settings-classifiers-local-strands-preset.png',
      )
    } finally {
      await restore()
    }
  })
})
