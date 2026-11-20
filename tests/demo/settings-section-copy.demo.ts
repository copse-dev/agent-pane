import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// Settings descriptions say what a section is in one line; the detail lives in
// the rows themselves. Re-scan keeps its key-import disclosure, because clicking
// it is the opt-in for that import (models-agents-list.ts, rescanAll).
describe('Settings section copy', () => {
  before(async () => {
    await browser.url('/?scenario=settings-footer')
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
  })

  it('keeps General to one line per section', async () => {
    await $('#settings-dialog button[data-section="general"]').click()
    const fieldset = $('[data-testid="models-agents-fieldset"]')
    await fieldset.waitForDisplayed({ timeout: 15_000 })
    await expect(fieldset.$('.settings-fieldset-desc')).toHaveText(
      'Plans, agents and API keys Copse can use. Agents and model servers on this machine appear on their own. Re-scan also imports new API keys from your environment and shell startup files, without overwriting saved ones.',
    )
    await expect($('#settings-models-section > .settings-fieldset-desc')).toHaveText(
      'The chat model, and the models used for background tasks.',
    )
    await expect($('#settings-models-section select[name="model"] ~ .field-hint')).toHaveText(
      "Best value picks the model that gives the most for what it costs on your plans, and sends each turn to that model's provider. Pin one here or from the chat picker.",
    )
    await saveAppScreenshot('settings-general-copy.png')
  })

  it('keeps Customise to one line per section', async () => {
    await $('#settings-dialog button[data-section="customise"]').click()
    const section = $('.settings-section[data-section="customise"]')
    await section.waitForDisplayed({ timeout: 15_000 })
    await expect(section.$('.settings-section-desc')).toHaveText(
      'What Copse loads for this project. Edit the files to change it.',
    )
    await expect($('#sources-instructions-list')).toHaveText(
      'No instruction files yet. Add AGENTS.md to the project root.',
      { wait: 15_000 },
    )
    await expect(
      $('#sources-instructions-list').parentElement().$('.settings-fieldset-desc'),
    ).toHaveText('Added to the system prompt, in the order they load.')
    await expect($('#sources-agents-list').parentElement().$('.settings-fieldset-desc')).toHaveText(
      'Subagents from agents/ folders in .copse, .cursor and .claude. Project agents load once you trust the project.',
    )
    await expect($('#sources-skills-fieldset > .settings-fieldset-desc')).toHaveText(
      'Skills the agent can use. They refresh when Sources opens or you reload, and apply from the next turn.',
    )
    await saveAppScreenshot('settings-customise-copy.png')
  })
})
