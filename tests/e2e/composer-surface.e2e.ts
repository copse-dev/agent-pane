import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedFooterBranchFixture, writeSettings } from './helpers/seed-config.ts'
import { seedBranchWorkspace } from './helpers/branch-workspace.ts'
import { setComposerValue } from './helpers/composer.ts'
import {
  E2E_SCREENSHOT_DIR,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

describe('composer surface', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  afterEach(() => {
    resetUserData()
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`keeps the follow-up composer aligned in ${theme} theme`, async () => {
      resetUserData()
      seedFooterBranchFixture(seedBranchWorkspace())
      writeSettings({ theme })
      await browser.reloadSession()

      await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
      await $('.footer-branch-status').waitForDisplayed({ timeout: 10_000 })
      await setComposerValue('This is a prompt')
      await expect($('.submit-btn')).toHaveText('Send')
      await expect($('.footer-model-host .model-picker-trigger')).toBeDisplayed()
      await expect($('.footer-overflow-trigger')).toBeDisplayed()
      await expect($('.context-wheel')).toBeDisplayed()

      const metrics = await browser.execute(() => {
        const card = document.getElementById('input-bar')
        const prompt = document.querySelector('.prompt-input')
        const attach = document.querySelector('.attach-btn')
        const send = document.querySelector('.submit-btn')
        const modelLabel = document.querySelector('.footer-model-host .model-picker-label')
        const modelChevron = document.querySelector('.footer-model-host .model-picker-chevron')
        if (
          !card ||
          !(prompt instanceof HTMLElement) ||
          !(attach instanceof HTMLElement) ||
          !(send instanceof HTMLElement) ||
          !(modelLabel instanceof HTMLElement) ||
          !(modelChevron instanceof HTMLElement) ||
          !(prompt.firstChild instanceof Text)
        ) {
          throw new Error('Follow-up composer controls are missing')
        }
        const firstCharacter = document.createRange()
        firstCharacter.setStart(prompt.firstChild, 0)
        firstCharacter.setEnd(prompt.firstChild, 1)
        const firstLine = firstCharacter.getBoundingClientRect()
        const attachRect = attach.getBoundingClientRect()
        const sendRect = send.getBoundingClientRect()
        const modelRect = modelLabel.getBoundingClientRect()
        const chevronRect = modelChevron.getBoundingClientRect()
        const cardStyle = getComputedStyle(card)
        return {
          theme: document.documentElement.dataset.theme,
          cardBackground: cardStyle.backgroundColor,
          borderWidth: cardStyle.borderTopWidth,
          shadow: cardStyle.boxShadow,
          promptFontSize: parseFloat(getComputedStyle(prompt).fontSize),
          promptOutline: getComputedStyle(prompt).outlineStyle,
          iconGap: firstLine.left - attachRect.right,
          lineOffset:
            firstLine.top + firstLine.height / 2 - (attachRect.top + attachRect.height / 2),
          sendRadius: parseFloat(getComputedStyle(send).borderTopLeftRadius),
          sendHeight: sendRect.height,
          chevronOffset:
            modelRect.top + modelRect.height / 2 - (chevronRect.top + chevronRect.height / 2),
        }
      })

      expect(metrics.theme).toBe(theme)
      expect(metrics.cardBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(metrics.borderWidth).toBe('0px')
      expect(metrics.shadow).not.toBe('none')
      expect(metrics.promptFontSize).toBeLessThanOrEqual(16)
      expect(metrics.promptOutline).toBe('none')
      expect(metrics.iconGap).toBeGreaterThanOrEqual(8)
      expect(metrics.iconGap).toBeLessThanOrEqual(20)
      expect(Math.abs(metrics.lineOffset)).toBeLessThanOrEqual(5)
      expect(metrics.sendRadius).toBeGreaterThanOrEqual(metrics.sendHeight / 2)
      expect(Math.abs(metrics.chevronOffset)).toBeLessThanOrEqual(3)

      await saveElementScreenshot('#input-bar', `composer-surface-card-${theme}.png`)
      await saveAppScreenshot(`composer-surface-${theme}.png`)
    })
  }
})
