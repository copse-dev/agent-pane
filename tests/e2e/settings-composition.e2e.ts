import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_SCREENSHOT_DIR,
  prepareE2eScreenshot,
  saveElementScreenshot,
  waitForSettledLayout,
  withCaptureFrame,
} from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { withFrozenAnimations } from './helpers/frozen-animations.ts'

const SKILL = 'settings-navigation-fixture'
const INSTRUCTIONS = 'Prefer readable names and focused changes.'

describe('Settings section composition, validation and sticky actions', () => {
  let workspace = ''
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspace = seedStableWorkspace({
      files: {
        [`.cursor/skills/${SKILL}/SKILL.md`]: `---\nname: ${SKILL}\ndescription: A skill loaded through the final Sources section.\n---\n\n# Settings fixture\n`,
      },
    })
    seedEmptyProject(workspace, 'e2e-settings-composition')
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('shows the three General groups with providers contracted', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[type="submit"]').waitForEnabled({ timeout: 15_000 })
    const groups = await browser.execute(() =>
      [
        ...document.querySelectorAll(
          '.settings-section[data-section="general"] > fieldset > legend, .settings-section[data-section="general"] > .settings-mount > fieldset > legend',
        ),
      ].map((legend) => legend.textContent.trim()),
    )
    assert.deepEqual(groups, ['Coding agents', 'API keys', 'Models'])
    assert.equal(
      await browser.execute(() =>
        [
          ...document.querySelectorAll('.settings-section[data-section="general"] .provider-chip'),
        ].some((chip) => chip.classList.contains('active')),
      ),
      false,
    )
    await saveElementScreenshot('#settings-dialog', 'settings-composition-general.png')
    const model = $('[data-model-setting-target="model"]')
    await browser.waitUntil(async () => (await model.getText()).includes(': auto from plan'), {
      timeout: 15_000,
    })
    assert.doesNotMatch(await model.getText(), /—/)
    await browser.execute(() => {
      document.querySelector('#settings-models-section')?.scrollIntoView({ block: 'start' })
    })
    await saveElementScreenshot('#settings-dialog', 'settings-composition-models.png')
  })

  it('reveals an invalid field, preserves the ordinary draft, and saves the corrected values', async () => {
    const dialog = $('#settings-dialog')
    const previous = await browser.execute(() => window.api.settings.getSnapshot())
    await dialog.$('button[data-section="agent"]').click()
    await dialog.$('[name="customInstructions"]').setValue(INSTRUCTIONS)
    await dialog.$('button[data-section="appearance"]').click()
    await dialog.$('[name="theme"]').selectByAttribute('value', 'light')
    assert.equal(await browser.execute(() => document.documentElement.dataset['theme']), 'light')
    await dialog.$('[name="fontSize"]').setValue('100')
    await dialog.$('button[data-section="agent"]').click()
    await dialog.$('button[type="submit"]').click()
    await expect(dialog).toBeDisplayed()
    assert.equal(
      await browser.execute(() => document.activeElement?.getAttribute('name')),
      'fontSize',
    )
    assert.equal(
      (await browser.execute(() => window.api.settings.getSnapshot())).customInstructions,
      previous.customInstructions,
    )
    await withCaptureFrame(async () => {
      await prepareE2eScreenshot()
      await waitForSettledLayout('#settings-dialog')
      const invalid = await browser.execute(() => {
        const field = document.querySelector<HTMLInputElement>('[name="fontSize"]')
        if (!field) throw new Error('Missing font size field')
        return {
          accepted: field.reportValidity(),
          overflow: field.validity.rangeOverflow,
          message: field.validationMessage,
        }
      })
      assert.equal(invalid.accepted, false)
      assert.equal(invalid.overflow, true)
      assert.notEqual(invalid.message, '')
      // Chromium owns this popup outside the page DOM. Re-open after capture
      // sizing, then wait for its longest transition (1166.67ms scale; opacity
      // is 466.67ms and text is 700ms in Blink validation_bubble.css). The
      // overlay has its own internal page, so app DOM geometry cannot observe it.
      await browser.pause(1500)
      // Chromium's native validation bubble is outside the DOM animation API.
      // Require consecutive identical frames so its fade-in cannot leak through
      // the screenshot's otherwise frozen renderer animations.
      await withFrozenAnimations(async () => {
        let previousFrame = ''
        let stableFrames = 0
        await browser.waitUntil(
          async () => {
            const frame = await browser.takeScreenshot()
            stableFrames = frame === previousFrame ? stableFrames + 1 : 0
            previousFrame = frame
            return stableFrames >= 2
          },
          { timeout: 5_000, interval: 200, timeoutMsg: 'native validation bubble did not settle' },
        )
      })
      await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'settings-composition-invalid-save.png'))
    })
    await dialog.$('[name="fontSize"]').setValue('16')
    await prepareE2eScreenshot()
    const footer = await browser.execute(() => {
      const form = document.querySelector<HTMLFormElement>('#settings-dialog form')
      const actions = document.querySelector('.settings-buttons')
      if (!form || !actions) throw new Error('Missing Settings content or actions')
      form.scrollTop = form.scrollHeight
      const viewport = form.getBoundingClientRect()
      const buttons = actions.getBoundingClientRect()
      return {
        top: buttons.top,
        bottom: buttons.bottom,
        viewportBottom: viewport.bottom,
        position: getComputedStyle(actions).position,
      }
    })
    assert.equal(footer.position, 'sticky')
    assert.ok(footer.bottom <= footer.viewportBottom + 1)
    assert.ok(footer.top < footer.viewportBottom)
    await expect(dialog.$('.settings-buttons button[type="submit"]')).toBeDisplayed()
    await dialog.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'settings-composition-sticky-footer.png'))
    await dialog.$('button[type="submit"]').click()
    await dialog.waitForDisplayed({ timeout: 15_000, reverse: true })
    const saved = await browser.execute(() => window.api.settings.getSnapshot())
    assert.equal(saved.customInstructions, INSTRUCTIONS)
    assert.equal(saved.fontSize, 16)
    assert.equal(saved.theme, 'light')
  })

  it('loads final skill metadata and folder controls through the Sources owner', async () => {
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[data-section="customise"]').click()
    await browser.waitUntil(
      async () => (await $('#sources-skills-list').getText()).includes(SKILL),
      { timeout: 15_000 },
    )
    await expect($('#sources-skill-roots')).toExist()
    await expect($('#sources-skills-status')).toExist()
    await browser.execute((name) => {
      const row = [...document.querySelectorAll('#sources-skills-list .sources-row')].find(
        (entry) => entry.textContent.includes(name),
      )
      if (!row) throw new Error('Missing project skill row')
      row.scrollIntoView({ block: 'center' })
    }, SKILL)
    await saveElementScreenshot('#settings-dialog', 'settings-composition-sources.png')
    await dialog.$('.sources-skill-folders summary').click()
    await $('#sources-skill-roots').scrollIntoView({ block: 'center' })
    await saveElementScreenshot('#settings-dialog', 'settings-composition-source-folders.png')
    await dialog.$('#settings-cancel').click()
  })

  it('presents Copse pack names and keeps disabled packs below active packs', async () => {
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await dialog.$('button[type="submit"]').waitForEnabled({ timeout: 15_000 })
    await dialog.$('button[data-section="customise"]').click()
    await browser.waitUntil(async () => (await $('#plugins-reload-status').getText()) === '', {
      timeout: 15_000,
    })
    const selector = '#plugins-list .plugin-row[data-plugin-id="copse.post-turn-review"]'
    await $(selector).waitForExist({ timeout: 5_000 })
    await browser.execute((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: 'center' })
    }, selector)
    assert.equal(await $(`${selector} .plugin-name`).getText(), 'Post turn review')
    assert.equal(await $(`${selector} .plugin-badge-first-party`).getText(), 'COPSE')
    if (!(await $(`${selector} .plugin-toggle-input`).isSelected())) {
      await $(`${selector} .plugin-toggle`).click()
      await browser.waitUntil(
        async () => (await $(selector).getAttribute('data-enabled')) === 'true',
      )
    }
    await $(`${selector} .plugin-toggle`).click()
    await browser.waitUntil(
      async () => (await $(selector).getAttribute('data-enabled')) === 'false',
    )
    const states = await browser.execute(() =>
      [...document.querySelectorAll('#plugins-list .plugin-row')].map((entry) =>
        entry.getAttribute('data-enabled'),
      ),
    )
    const firstDisabled = states.indexOf('false')
    assert.ok(firstDisabled >= 0)
    assert.ok(states.slice(firstDisabled).every((state) => state === 'false'))
    await browser.execute((selector) => {
      document.querySelector(selector)?.scrollIntoView({ block: 'center' })
    }, selector)
    await saveElementScreenshot('#settings-dialog', 'settings-composition-packs.png')
    await dialog.$('#settings-cancel').click()
  })
})
