import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedToolDisplayFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('nested tool activity colors', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedToolDisplayFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('mutes rollup-body spirals while the outer activity uses the action accent', async () => {
    const rollupElement = $('.tool-card-rollup')
    await rollupElement.waitForExist({ timeout: 15_000 })

    const colors = await browser.execute(() => {
      const nestedReasoning = document.querySelector('.tool-rollup-body > .message-reasoning')
      const rollup = nestedReasoning?.closest<HTMLDetailsElement>('.tool-card-rollup')
      const nestedReasoningHost = nestedReasoning?.querySelector('.message-reasoning-icon')
      const sourceIcon = nestedReasoningHost?.querySelector<SVGElement>(
        '[data-icon="reasoning-activity"]',
      )
      const outerSlot = rollup?.querySelector(
        ':scope > .tool-card-header > .tool-activity-icon-slot',
      )
      const nestedToolSlot = rollup?.querySelector('.tool-rollup-body .tool-activity-icon-slot')
      const missing = [
        ['rollup', rollup],
        ['sourceIcon', sourceIcon],
        ['outerSlot', outerSlot],
        ['nestedToolSlot', nestedToolSlot],
        ['nestedReasoning', nestedReasoning],
        ['nestedReasoningHost', nestedReasoningHost],
      ]
        .filter((entry) => !entry[1])
        .map((entry) => entry[0])

      if (
        !rollup ||
        !sourceIcon ||
        !outerSlot ||
        !nestedToolSlot ||
        !nestedReasoning ||
        !nestedReasoningHost
      ) {
        return {
          missing,
          outerColor: null,
          nestedToolColor: null,
          nestedReasoningColor: null,
          accentColor: null,
          secondaryColor: null,
        }
      }

      rollup.open = true
      outerSlot.replaceChildren(sourceIcon.cloneNode(true))
      nestedToolSlot.replaceChildren(sourceIcon.cloneNode(true))
      nestedReasoning.classList.add('message-reasoning-live')

      const outerIcon = outerSlot.querySelector('.reasoning-activity-icon')
      const nestedToolIcon = nestedToolSlot.querySelector('.reasoning-activity-icon')
      const nestedReasoningIcon = nestedReasoningHost.querySelector('.reasoning-activity-icon')
      const accentProbe = document.createElement('span')
      const secondaryProbe = document.createElement('span')
      accentProbe.style.color = 'var(--accent)'
      secondaryProbe.style.color = 'var(--text-secondary)'
      document.body.append(accentProbe, secondaryProbe)
      const accentColor = getComputedStyle(accentProbe).color
      const secondaryColor = getComputedStyle(secondaryProbe).color
      accentProbe.remove()
      secondaryProbe.remove()

      return {
        missing,
        outerColor: outerIcon ? getComputedStyle(outerIcon).color : null,
        nestedToolColor: nestedToolIcon ? getComputedStyle(nestedToolIcon).color : null,
        nestedReasoningColor: nestedReasoningIcon
          ? getComputedStyle(nestedReasoningIcon).color
          : null,
        accentColor,
        secondaryColor,
      }
    })
    expect(colors.missing).toEqual([])
    expect(colors.outerColor).toBe(colors.accentColor)
    expect(colors.nestedToolColor).toBe(colors.secondaryColor)
    expect(colors.nestedReasoningColor).toBe(colors.secondaryColor)
    expect(colors.nestedToolColor).not.toBe(colors.outerColor)

    await rollupElement.scrollIntoView()
    await browser.pause(900)
    await saveAppScreenshot('nested-tool-activity-colors.png')
  })
})
