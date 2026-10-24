import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

const HOST = '.footer-model-host'
const MENU = HOST + ' .model-picker-menu'
const TRIGGER = HOST + ' .model-picker-trigger'

describe('retention mark in the model picker', () => {
  before(async () => {
    await browser.url('/?scenario=chat-reading-layout&autoplay=0')
    await $(TRIGGER).waitForDisplayed()
    await browser.execute(() => {
      const getSetting = window.api.settings.get
      window.api.settings.get = async (key): Promise<unknown> =>
        key === 'registeredAcpAgents'
          ? [
              {
                id: 'claude-acp',
                title: 'Claude Code',
                command: 'claude-agent-acp',
                enabled: true,
                availableModels: [
                  { value: 'opus', label: 'Claude Opus 5.5' },
                  { value: 'sonnet', label: 'Claude Sonnet 5.5' },
                ],
              },
            ]
          : getSetting(key)
    })
  })

  it('keeps the bottom bar clean and marks ACP rows with a archive mark', async () => {
    await $(TRIGGER).click()
    await $(MENU + ' .model-picker-browse').click()
    const row = $(MENU + ' .model-picker-option .model-picker-retention')
    await row.waitForDisplayed()
    await expect(row).toHaveAttribute('aria-label', 'ZDR not verified')
    await saveElementScreenshot(MENU, 'model-picker-retention-menu.png')
    await $(MENU + ' .model-picker-option .model-picker-retention')
      .parentElement()
      .click()
    await expect($(MENU)).not.toBeDisplayed()
    await expect($(TRIGGER + ' .model-picker-retention')).not.toExist()
    await saveElementScreenshot(HOST, 'model-picker-retention-bar.png')
  })
})
