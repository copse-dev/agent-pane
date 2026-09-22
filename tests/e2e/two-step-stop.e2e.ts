import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'

describe('two-step stop shortcut', function () {
  this.timeout(90_000)

  afterEach(() => {
    resetUserData()
  })

  it('arms on Escape, then stops on a second Escape without submitting another prompt', async function () {
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-two-step-stop', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()

    const composer = $('.prompt-input')
    await composer.waitForExist({ timeout: 30_000 })
    const prompt = 'Continue reviewing the migration plan until I stop you.'
    const scenario = await installMockScenario({
      title: 'Review migration plan',
      turns: [
        {
          user: prompt,
          responses: [
            {
              waitFor: 'migration-review',
              text: 'I am reviewing the migration plan and will pause when you stop the run.',
            },
          ],
          allowAbort: true,
        },
      ],
    })
    await setComposerValue(prompt)
    await $('.submit-btn').click()
    await scenario.waitForHold('migration-review')

    await composer.click()
    await browser.keys('Escape')

    const stopButton = $('.stop-btn')
    await expect(stopButton).toHaveElementClass('stop-pending')

    const actionGeometry = await browser.execute(() => {
      const stop = document.querySelector<HTMLElement>('.stop-btn')
      const send = document.querySelector<HTMLElement>('.submit-btn')
      if (!stop || !send) return null
      const geometry = (button: HTMLElement) => {
        const rect = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          height: rect.height,
          borderRadius: style.borderRadius,
          paddingInline: style.paddingInline,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
        }
      }
      return {
        stop: geometry(stop),
        send: geometry(send),
      }
    })
    expect(actionGeometry).not.toBeNull()
    expect(actionGeometry?.stop).toEqual(actionGeometry?.send)

    await saveElementScreenshot('#input-bar', 'two-step-stop-armed.png')

    await browser.keys('Escape')
    await expect(stopButton).not.toHaveElementClass('stop-pending')
    await waitForAgentIdle(15_000)
    await scenario.assertComplete()
  })
})
