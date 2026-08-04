import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * The composer model picker's ACP selectors: reasoning level (ACP
 * `category: "thought_level"`) and session mode, listed under the models and
 * also reachable from the trigger's right-click menu. Seeded from the agent's
 * probe cache, so no agent process is spawned here.
 */
describe('ACP config options in the model picker', () => {
  before(async function () {
    this.timeout(90_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-acp-config-options', {
      windowBounds: { width: 1280, height: 800 },
      model: 'acp:fixture-agent',
      registeredAcpAgents: [
        {
          id: 'fixture-agent',
          title: 'Fixture ACP Agent',
          command: 'fixture-acp',
          enabled: true,
          modelsProbedAt: Date.now(),
          availableModels: [
            { value: 'fixture-opus', label: 'Fixture Opus' },
            { value: 'fixture-sonnet', label: 'Fixture Sonnet' },
          ],
          availableConfigOptions: [
            {
              configId: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'fixture-sonnet',
              choices: [
                { value: 'fixture-opus', label: 'Fixture Opus' },
                { value: 'fixture-sonnet', label: 'Fixture Sonnet' },
              ],
            },
            {
              configId: 'thinking',
              name: 'Thinking effort',
              category: 'thought_level',
              currentValue: 'medium',
              choices: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
              ],
            },
          ],
          availablePermissionModes: [
            { value: 'default', label: 'Default', description: 'Ask before protected actions.' },
            { value: 'plan', label: 'Plan', description: 'Plan without changing files.' },
          ],
          permissionMode: 'default',
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('lists the agent’s selectors under the models and drills into one', async function () {
    this.timeout(60_000)
    await $('.model-picker-trigger').click()
    const rows = await $$('.model-picker-group-row')
    await expect(rows.length).toBe(2)
    await expect(rows[0].$('.model-picker-group-row-label')).toHaveText('Thinking effort')
    await expect(rows[0].$('.model-picker-group-row-value')).toHaveText('Medium')
    await expect(rows[1].$('.model-picker-group-row-label')).toHaveText('Mode')

    await saveElementScreenshot('.model-picker-menu', 'acp-config-options-menu.png')

    await rows[0].click()
    const choices = await $$('.model-picker-menu .model-picker-option')
    await expect(choices.length).toBe(3)
    await expect(choices[1]).toHaveAttribute('aria-current', 'true')
    await saveElementScreenshot('.model-picker-menu', 'acp-config-options-thinking-effort.png')

    await choices[2].click()
    await expect($('.model-picker-menu')).not.toBeDisplayed()

    // The pick persists to the agent config, so it survives a reopen.
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-group-row .model-picker-group-row-value')).toHaveText('High', {
      wait: 10_000,
    })
    await $('.model-picker-trigger').click()
    await expect($('.model-picker-menu')).not.toBeDisplayed()
  })

  it('offers the same selectors on right-click', async function () {
    this.timeout(60_000)
    const opened = await browser.execute(() => {
      document
        .querySelector('.model-picker-trigger')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const menu = document.querySelector('.context-menu')
      return {
        // The model list stays shut: right-click is the shortcut past it.
        pickerMenuOpen:
          document.querySelector('.model-picker-menu')?.hasAttribute('hidden') !== true,
        headings: [...(menu?.querySelectorAll('.context-menu-heading') ?? [])].map(
          (el) => el.textContent,
        ),
        items: [...(menu?.querySelectorAll('.context-menu-item') ?? [])].map((el) => ({
          label: el.querySelector('.context-menu-item-label')?.textContent,
          checked: el.getAttribute('aria-checked'),
        })),
      }
    })

    await expect(opened.pickerMenuOpen).toBe(false)
    await expect(opened.headings).toEqual(['Thinking effort', 'Mode'])
    await expect(opened.items).toEqual([
      { label: 'Low', checked: 'false' },
      { label: 'Medium', checked: 'false' },
      // The reasoning level picked in the previous test is the checked one.
      { label: 'High', checked: 'true' },
      { label: 'Default', checked: 'true' },
      { label: 'Plan', checked: 'false' },
    ])
    await saveElementScreenshot('.context-menu', 'acp-config-options-context-menu.png')
  })
})
