import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import {
  resetUserData,
  seedConversationVisualHierarchyFixture,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import {
  prepareE2eScreenshot,
  savePreparedAppScreenshot,
  withCaptureFrame,
} from './helpers/screenshot.ts'

async function geometry(): Promise<{
  actual: number
  reserve: number
  border: string
  contentWidth: number
}> {
  return browser.execute(() => {
    const input = document.getElementById('input-bar')
    const pane = document.getElementById('pane-chat')
    if (!input || !pane) throw new Error('Composer layout missing')
    return {
      actual: input.getBoundingClientRect().height,
      reserve: Number.parseFloat(getComputedStyle(pane).getPropertyValue('--chat-composer-height')),
      border: getComputedStyle(input).borderTopWidth,
      contentWidth: input.clientWidth,
    }
  })
}

async function expectSynchronized(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const value = await geometry()
      return value.reserve === Math.max(Math.ceil(value.actual), 72)
    },
    { timeout: 5_000, interval: 50, timeoutMsg: 'Composer reserve missed its border-box height' },
  )
}

describe('composer border-box reservation', () => {
  before(async () => {
    resetUserData()
    seedConversationVisualHierarchyFixture(seedStableWorkspace())
    await browser.reloadSession()
    await $('[data-message-id="msg-assistant-result"]').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('tracks border-only changes in both directions and ordinary content growth', async () => {
    await withCaptureFrame(async () => {
      await prepareE2eScreenshot()
      await expectSynchronized()
      const original = await geometry()
      assert.equal(original.border, '0px')
      const observations = [{ phase: 'original', ...original }]
      try {
        await browser.execute(() => {
          const input = document.getElementById('input-bar')
          if (!input) throw new Error('Composer missing')
          // Compensate outer width so content width stays fixed. Otherwise the
          // content-box observer gets a width notification and masks the defect.
          input.style.width = `${String(input.getBoundingClientRect().width + 2)}px`
          input.style.setProperty('border', '1px solid red', 'important')
        })
        observations.push({ phase: 'bordered-before-wait', ...(await geometry()) })
        await expectSynchronized()
        const bordered = await geometry()
        assert.equal(bordered.actual, original.actual + 2)
        assert.equal(bordered.contentWidth, original.contentWidth)
        observations.push({ phase: 'bordered', ...bordered })
        await savePreparedAppScreenshot('composer-observer-bordered.png')
        await expectSynchronized()

        await browser.execute(() => {
          document.getElementById('input-bar')?.style.removeProperty('border')
          document.getElementById('input-bar')?.style.removeProperty('width')
        })
        await expectSynchronized()
        const borderless = await geometry()
        assert.equal(borderless.actual, original.actual)
        assert.equal(borderless.contentWidth, original.contentWidth)
        observations.push({ phase: 'borderless', ...borderless })
        await savePreparedAppScreenshot('composer-observer-borderless.png')

        await browser.execute(() => {
          const strip = document.createElement('div')
          strip.id = 'composer-observer-content'
          strip.textContent = 'Composer content height control'
          strip.style.height = '24px'
          document.getElementById('input-bar')?.append(strip)
        })
        await expectSynchronized()
        const grown = await geometry()
        assert.equal(grown.actual, borderless.actual + 24)
        observations.push({ phase: 'content-grown', ...grown })
        await savePreparedAppScreenshot('composer-observer-content-grown.png')
      } finally {
        await browser.execute(() => {
          document.getElementById('input-bar')?.style.removeProperty('border')
          document.getElementById('input-bar')?.style.removeProperty('width')
          document.getElementById('composer-observer-content')?.remove()
        })
        await expectSynchronized()
        observations.push({ phase: 'restored', ...(await geometry()) })
        const directory = join(process.cwd(), '.tmp/composer-observer')
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, 'geometry.json'), JSON.stringify(observations, null, 2))
      }
    })
  })
})
