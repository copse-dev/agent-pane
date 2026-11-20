import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'

describe('skills', () => {
  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace({
      files: {
        'review-plugin/.cursor-plugin/plugin.json': JSON.stringify({
          name: 'acme.tools',
          skills: './skills/',
        }),
        'review-plugin/skills/qualified-review/SKILL.md':
          '---\nname: qualified-review\ndescription: Review changes using the plugin workflow\ndisable-model-invocation: true\n---\n\nReview the change and summarize the findings.',
        '.cursor/skills/demo-skill/SKILL.md': readFileSync(
          new URL('../../.cursor/skills/demo-skill/SKILL.md', import.meta.url),
          'utf8',
        ),
      },
    })
    const projectSettings = { model: 'claude-sonnet-4-6', subagentsEnabled: false }
    seedEmptyProject(workspaceRoot, 'skills-demo-project', projectSettings)
    // writeSettings replaces the whole settings file, so restate the project's
    // model and subagent settings alongside the plugin path.
    writeSettings({
      ...projectSettings,
      skillPluginPaths: [join(workspaceRoot, 'review-plugin')],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('invokes a workspace skill through the live agent path', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // Deliberately type as soon as the composer mounts. Workspace discovery
    // finishes in the background; an already-open query must update without
    // requiring another keystroke (#2948).
    await setComposerValue('/demo-skill')
    const skill = $('.skill-picker').$('.skill-item*=/demo-skill')
    await skill.waitForDisplayed({ timeout: 10_000 })
    await expect(skill.$('.skill-item-name')).toHaveText('/demo-skill')
    // Candidate confirmation belongs to the input method, not autocomplete.
    // Inject the browser's composition flag; this tests renderer routing, not
    // the macOS input method's own candidate UI.
    const composition = await browser.execute(() => {
      const input = document.querySelector('.prompt-input')
      if (!(input instanceof HTMLElement)) throw new Error('Composer missing')
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })
      input.dispatchEvent(enter)
      return { prevented: enter.defaultPrevented, text: input.textContent }
    })
    expect(composition.prevented).toBe(false)
    expect(composition.text).toBe('/demo-skill')
    await expect(skill).toBeDisplayed()
    await expect($('.msg-user')).not.toExist()
    await saveAppScreenshot('skills-discovery-picker.png')

    // Refocus without a click: a mousedown outside the picker dismisses it.
    await browser.execute(() => document.querySelector<HTMLElement>('.prompt-input')?.focus())
    await browser.keys('Enter')
    await expect($('.skill-picker')).not.toBeDisplayed()
    expect(await browser.execute(() => document.querySelector('.prompt-input')?.textContent)).toBe(
      '/demo-skill ',
    )
    await expect($('.msg-user')).not.toExist()

    const scenario = await installMockScenario({
      title: 'Validate skills support',
      turns: [
        {
          user: 'validate skills support',
          responses: [
            {
              text: 'The workspace skill is active, and its instructions are available for this request.',
            },
          ],
        },
      ],
    })
    await setComposerValue('/demo-skill validate skills support')
    await $('.submit-btn').click()
    await $('.msg-user').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.msg-assistant').length)) >= 1,
      { timeout: 20_000 },
    )

    const assistantText = await $('.msg-assistant .message-text').getElement()
    await expect(assistantText).toHaveText(
      'The workspace skill is active, and its instructions are available for this request.',
      {
        containing: true,
        wait: 20_000,
      },
    )
    await waitForAgentIdle()
    await scenario.assertComplete()
    await waitForActiveThreadTitle()
    await assertNoErrorToasts('after /demo-skill')
    await saveAppScreenshot('skills-demo-invoked.png')
  })

  it('completes and invokes a plugin-qualified skill through the live agent path', async () => {
    await setComposerValue('/acme.tools:qual')
    const skill = $('.skill-picker').$('.skill-item*=/acme.tools:qualified-review')
    await skill.waitForDisplayed({ timeout: 10_000 })
    await expect(skill.$('.skill-item-name')).toHaveText('/acme.tools:qualified-review')
    await saveAppScreenshot('skills-qualified-picker.png')
    await browser.execute(() => document.querySelector<HTMLElement>('.prompt-input')?.focus())
    await browser.keys('Tab')
    expect(await browser.execute(() => document.querySelector('.prompt-input')?.textContent)).toBe(
      '/acme.tools:qualified-review ',
    )

    const scenario = await installMockScenario({
      title: 'Review with plugin skill',
      turns: [
        {
          user: 'review the parser change',
          responses: [
            { toolCalls: [{ name: 'read_skill', args: { name: 'qualified-review' } }] },
            {
              expectToolResults: [
                { name: 'read_skill', includes: 'was explicitly invoked by the user' },
              ],
              text: 'The plugin review workflow is active for the parser change.',
            },
          ],
        },
      ],
    })
    await setComposerValue('/acme.tools:qualified-review review the parser change')
    await $('.submit-btn').click()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await expectAssistantReply('The plugin review workflow is active for the parser change.')
    await assertNoErrorToasts('after /acme.tools:qualified-review')
  })
})
