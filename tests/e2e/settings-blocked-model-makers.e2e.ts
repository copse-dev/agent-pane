import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

describe('blocked model makers in Settings', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-blocked-model-makers')
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lets a user block xAI and keeps the choice after reopening Settings', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()

    const block = $('#settings-model-maker-block-host')
    await expect(block).toBeDisplayed()
    assert.equal(await block.$$('input[name="blockedModelMakers"]').length, 6)
    const xai = block.$('input[value="xai"]')
    assert.equal(await xai.isSelected(), false)
    await xai.click()
    assert.equal(await xai.isSelected(), true)

    await browser.execute(() => {
      document
        .querySelector('#settings-model-maker-block-host')
        ?.scrollIntoView({ block: 'center' })
    })
    // Makers fill the grid row by row, three to a row. Every box in a row has to
    // share its top, or the row reads as ragged.
    const boxes = await browser.execute(() =>
      Array.from(
        document.querySelectorAll(
          '#settings-model-maker-block-host input[name="blockedModelMakers"]',
        ),
        (input) => {
          const { top, left } = input.getBoundingClientRect()
          return { top, left }
        },
      ),
    )
    for (const row of [boxes.slice(0, 3), boxes.slice(3, 6)]) {
      const [first, ...rest] = row
      assert.ok(first, 'each row has a maker')
      let previousLeft = first.left
      for (const box of rest) {
        assert.ok(box.left > previousLeft, 'a row runs left to right across the columns')
        previousLeft = box.left
        assert.ok(
          Math.abs(box.top - first.top) <= 1,
          `maker checkboxes in a row line up: ${JSON.stringify(row)}`,
        )
      }
    }

    await block.$('h4').moveTo()
    await saveElementScreenshot('#settings-dialog', 'settings-blocked-model-makers.png')

    await $('#settings-dialog .settings-buttons button[type="submit"]').click()
    await expect($('#settings-dialog')).not.toBeDisplayed()
    await $('[aria-label="Settings"]').click()
    await expect($('#settings-model-maker-block-host input[value="xai"]')).toBeSelected()
  })
})
