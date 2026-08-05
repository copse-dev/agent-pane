import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { composerText } from './helpers/composer.ts'

// Creating a project runs `git init` + writes AGENT.md/README.md, so it needs a
// writable parent outside the repo working tree. A throwaway temp dir keeps the
// fixture from polluting the checkout and is removed after the run.
const PARENT_DIR = mkdtempSync(join(tmpdir(), 'copse-new-project-'))

function makeParent(name: string): string {
  const dir = join(PARENT_DIR, name)
  rmSync(dir, { recursive: true, force: true })
  return dir
}

describe('new project flow', () => {
  after(() => {
    resetUserData()
    rmSync(PARENT_DIR, { recursive: true, force: true })
  })

  it('welcome screen shows a New Project button that opens the dialog', async () => {
    resetUserData()
    writeSeedConfig({ projects: [], activeProjectId: null })
    await browser.reloadSession()

    await $('.welcome-card').waitForDisplayed({ timeout: 30_000 })
    await expect($('.welcome-new-btn')).toHaveText('New Project')

    await $('.welcome-new-btn').click()
    const dialog = await $('#new-project-dialog')
    await dialog.waitForDisplayed({ timeout: 5_000 })
    await expect($('.new-project-name')).toBeDisplayed()
    await expect($('.new-project-parent')).toBeDisplayed()
    await saveAppScreenshot('new-project-dialog.png')

    // Cancel returns to the welcome screen.
    await $('.new-project-actions .ui-btn:not(.primary)').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 5_000 })
  })

  it('creating a project scaffolds the folder, activates it, and seeds a starter prompt', async () => {
    resetUserData()
    writeSeedConfig({ projects: [], activeProjectId: null })
    await browser.reloadSession()

    await $('.welcome-card').waitForDisplayed({ timeout: 30_000 })
    await $('.welcome-new-btn').click()
    await $('#new-project-dialog').waitForDisplayed({ timeout: 5_000 })

    const projectName = 'hello-copse'
    const parent = makeParent(projectName)
    await $('.new-project-name').setValue(projectName)
    await $('.new-project-parent').setValue(parent)

    // Path preview reflects the chosen name + parent.
    await expect($('.new-project-path-preview')).toHaveText(`${parent}/${projectName}`)

    // Missing name shows an inline error.
    await $('.new-project-name').clearValue()
    await $('.new-project-actions .ui-btn.primary').click()
    await expect($('.new-project-error')).toBeDisplayed()

    // Fill it back in and create.
    await $('.new-project-name').setValue(projectName)
    await $('.new-project-actions .ui-btn.primary').click()

    // The workspace activates and the composer appears with the starter prompt.
    // The composer is a contenteditable, not an input: WDIO's value matchers read
    // `undefined` off it (see helpers/composer.ts), so read its text the way the
    // editor itself does, and poll — the prompt is seeded after activation.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await composerText()).includes('Introduce this project'), {
      timeout: 15_000,
      timeoutMsg: 'composer never received the starter prompt',
    })
    await saveAppScreenshot('new-project-active.png')

    // The folder was scaffolded under `<parent>/<name>` with AGENT.md + README.md
    // and initialised as a git repo.
    const projectDir = join(parent, projectName)
    expect(existsSync(join(projectDir, 'AGENT.md'))).toBe(true)
    expect(existsSync(join(projectDir, 'README.md'))).toBe(true)
    expect(existsSync(join(projectDir, '.git'))).toBe(true)
  })

  it('sidebar + menu offers New project / Open folder once a project already exists', async () => {
    resetUserData()
    seedEmptyProject(process.cwd(), 'existing-proj', { packDisabled: [] })
    await browser.reloadSession()

    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const addBtn = await $('.projects-add-btn')
    await addBtn.waitForDisplayed({ timeout: 10_000 })
    await addBtn.click()

    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    // `.map` on the chainable array resolves the getText() calls itself; awaiting
    // `$$` first and mapping by hand hands Promise.all a non-iterable.
    const labels = (await $$('.context-menu-item').map((item) => item.getText())).join('|')
    expect(labels).toContain('New project')
    expect(labels).toContain('Open folder')
  })
})
