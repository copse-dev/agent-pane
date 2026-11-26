import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSettings,
} from './helpers/seed-config.ts'

const PROJECT_ROOT = '/Users/dev/code/agent-pane'
const SIBLING = '/Users/dev/code/agent-pane-risk'
const OTHER = '/Users/dev/code/streaming-markdown'

describe('Sandbox read access settings', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-settings-sandbox-read-access')
    // Two folders this project approved through the read prompt.
    writeSettings({
      ...readSeededSettings(),
      sandboxReadProjectFolders: { [PROJECT_ROOT]: [SIBLING, OTHER] },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('lists the groups on by default, the approved folders, and the fixed denials', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    const fieldset = $('#sandbox-read-access-fieldset')
    await expect(fieldset).toBeDisplayed()

    for (const name of [
      'sandboxReadToolchains',
      'sandboxReadCaches',
      'sandboxReadApprovedFolders',
    ]) {
      const input = await fieldset.$(`input[name="${name}"]`).getElement()
      assert.equal(await input.isSelected(), true, `${name} is on by default`)
    }
    const lockdown = await fieldset.$('input[name="sandboxReadWorkspaceOnly"]').getElement()
    assert.equal(await lockdown.isSelected(), false)

    const folders = await browser.execute(() =>
      Array.from(
        document.querySelectorAll('#sandbox-read-folders-host .sandbox-read-folder-row'),
        (row) => row.getAttribute('data-folder'),
      ),
    )
    assert.deepEqual(folders, [SIBLING, OTHER])
    assert.equal(
      await $('#sandbox-read-folders-host .sandbox-read-project-name').getText(),
      'agent-pane',
    )
    const denials = await browser.execute(
      () =>
        document.querySelectorAll('#sandbox-read-access-fieldset .sandbox-read-fixed-list li')
          .length,
    )
    assert.ok(denials >= 4)

    await browser.execute(() => {
      document.querySelector('#sandbox-read-access-fieldset')?.scrollIntoView({ block: 'start' })
    })
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const top = document
            .querySelector('#sandbox-read-access-fieldset')
            ?.getBoundingClientRect().top
          const body = document.querySelector('.settings-body')?.getBoundingClientRect().top
          return top !== undefined && body !== undefined && Math.abs(top - body) < 80
        }),
      { timeout: 5_000, timeoutMsg: 'the fieldset should scroll to the top' },
    )
    await saveElementScreenshot('#settings-dialog', 'settings-sandbox-read-access.png')
  })

  it('greys out the groups under workspace only, and removes a folder', async () => {
    const fieldset = $('#sandbox-read-access-fieldset')
    await fieldset.$('input[name="sandboxReadWorkspaceOnly"]').click()
    const toolchains = await fieldset.$('input[name="sandboxReadToolchains"]').getElement()
    assert.equal(await toolchains.isEnabled(), false)

    await $(`#sandbox-read-folders-host [data-folder="${OTHER}"] button`).click()
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelectorAll('#sandbox-read-folders-host .sandbox-read-folder-row').length,
        )) === 1,
      { timeout: 5_000, timeoutMsg: 'the removed folder should leave the list' },
    )
    const stored = readSeededSettings()['sandboxReadProjectFolders']
    assert.deepEqual(stored, { [PROJECT_ROOT]: [SIBLING] })

    await saveElementScreenshot(
      '#sandbox-read-access-fieldset',
      'settings-sandbox-read-lockdown.png',
    )
  })
})
