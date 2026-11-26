import { $, browser, expect } from '@wdio/globals'
import { mkdirSync } from 'node:fs'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import type { AgentProfile } from '../../src/shared/agent-profiles.ts'

/**
 * Named agent profiles (#1573): save one in Settings > Agent, then switch a
 * chat to it from the composer's model menu. The profile sets the chat's
 * effort and names itself on the trigger; its instructions join each turn in
 * the main process (covered by unit tests, since no mock model echoes its
 * system prompt).
 */
const PROFILES_PROJECT_ID = 'e2e-agent-profiles'

/** The picker's nth selector row (1-based), counting only those rows. */
function groupRow(picker: WebdriverIO.Element, n: number): ReturnType<WebdriverIO.Element['$']> {
  return picker.$(`.model-picker-group-row:nth-child(${String(n)} of .model-picker-group-row)`)
}

/** A fresh window on an empty project, optionally with saved profiles. */
async function openSeededProject(agentProfiles?: AgentProfile[]): Promise<void> {
  mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  resetUserData()
  seedEmptyProject(seedStableWorkspace(), PROFILES_PROJECT_ID, {
    windowBounds: { width: 1280, height: 800 },
    model: 'claude-opus-5',
    ...(agentProfiles ? { agentProfiles } : {}),
  })
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
}

describe('named agent profiles in Settings', () => {
  before(async function () {
    this.timeout(90_000)
    await openSeededProject()
  })

  after(() => {
    resetUserData()
  })

  it('saves a profile in Settings', async function () {
    this.timeout(60_000)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="agent"]').click()
    const section = $('.agent-profiles')
    await section.waitForDisplayed({ timeout: 15_000 })
    await expect(section.$('.agent-profile-list')).toHaveText('No profiles yet.')

    await section.$('.agent-profile-add').click()
    await section.$('.agent-profile-name').setValue('Reviewer')
    await section.$('.agent-profile-effort').selectByAttribute('value', 'high')
    await section
      .$('.agent-profile-instructions')
      .setValue('Review the diff for correctness first. Do not edit files unless asked.')
    await section.$('.agent-profile-save').click()

    const row = section.$('.agent-profile-row[data-profile-id="reviewer"]')
    await row.waitForDisplayed({ timeout: 10_000 })
    await expect(row.$('strong')).toHaveText('Reviewer')
    await expect(row.$('.field-hint')).toHaveText(
      'Keep the chat’s model · High effort · with instructions',
    )
    await expect(section.$('.agent-profile-form')).not.toBeDisplayed()
    await section.scrollIntoView({ block: 'center' })
    await saveElementScreenshot('.agent-profiles', 'settings-agent-profiles.png')
    await $('#settings-close').click()
    await $('#settings-dialog[open]').waitForExist({ reverse: true, timeout: 10_000 })
  })
})

describe('named agent profiles in the model menu', () => {
  // Seeded rather than created through Settings, so this case also runs alone.
  before(async function () {
    this.timeout(90_000)
    await openSeededProject([
      {
        id: 'reviewer',
        name: 'Reviewer',
        reasoning: 'high',
        instructions: 'Review the diff for correctness first. Do not edit files unless asked.',
      },
    ])
  })

  after(() => {
    resetUserData()
  })

  it('switches the chat to the profile from the model menu', async function () {
    this.timeout(60_000)
    const picker = await $('.footer-model-host .model-picker').getElement()
    await picker.$('.model-picker-trigger').click()
    await browser.waitUntil(async () => (await picker.$$('.model-picker-group-row').length) >= 2, {
      timeout: 15_000,
      timeoutMsg: 'the profile and effort rows never loaded',
    })
    const profileRow = groupRow(picker, 1)
    await expect(profileRow.$('.model-picker-group-row-label')).toHaveText('Profile')
    await expect(profileRow.$('.model-picker-group-row-value')).toHaveText('None')
    await profileRow.click()
    const reviewer = picker.$('.model-picker-menu').$('.model-picker-option*=Reviewer')
    await reviewer.waitForDisplayed({ timeout: 10_000 })
    await reviewer.click()
    await expect(picker.$('.model-picker-menu')).not.toBeDisplayed()
    await expect(picker.$('.model-picker-trigger')).toHaveText(
      expect.stringContaining('Reviewer ·'),
      { wait: 10_000 },
    )

    // The pick lands on the thread: the profile and its effort survive a reopen.
    await picker.$('.model-picker-trigger').click()
    await expect(groupRow(picker, 1).$('.model-picker-group-row-value')).toHaveText('Reviewer', {
      wait: 10_000,
    })
    await expect(groupRow(picker, 2).$('.model-picker-group-row-label')).toHaveText('Effort')
    await expect(groupRow(picker, 2).$('.model-picker-group-row-value')).toHaveText('High')
    await saveElementScreenshot(
      '.footer-model-host .model-picker-menu',
      'footer-model-menu-agent-profile.png',
    )
  })
})
