import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

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
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // `.prompt-input` is the composer's contenteditable root (see
    // composer-editor.ts), not an <input>/<textarea> — it has no `value`
    // property, so `toHaveValue` reads undefined and can never match.
    await expect($('.prompt-input')).toHaveText(expect.stringContaining('Introduce this project'))
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

    // `$$(…).map` is WebdriverIO's own async map over the chainable array — it
    // already awaits each element, so the result is a plain string[]. Wrapping the
    // chainable's `.map` in `Promise.all` hands it a non-iterable and throws.
    const labels = (await $$('.context-menu-item').map((item) => item.getText())).join('|')
    expect(labels).toContain('New project')
    expect(labels).toContain('Open folder')
  })
})
