import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSettings } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

describe('Agent Skills conformance Sources and picker', () => {
  let workspace = ''
  let extra = ''
  function writeSkill(root: string, name: string, metadata: string): void {
    const folder = join(root, name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\n${metadata}\n---\n\n# Workflow\n`)
  }
  before(async () => {
    resetUserData()
    const fixture = join(tmpdir(), 'copse-e2e-skill-conformance', 'workspace')
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
    workspace = realpathSync(fixture)
    extra = join(workspace, 'extra-skills')
    const cursor = join(workspace, '.cursor', 'skills')
    const github = join(workspace, '.github', 'skills')
    writeSkill(
      cursor,
      'e2e-manual-only',
      'description: Review a change manually.\ndisable-model-invocation: true\nlicense: MIT\ncompatibility: Copse\nmetadata:\n  author: "<script>not executable</script>"\nallowed-tools: "Bash(python:*) Read"',
    )
    writeSkill(
      github,
      'e2e-model-only',
      'description: Workflow selected by the model.\nuser-invocable: false',
    )
    writeSkill(github, 'e2e-manual-only', 'description: A duplicate that should be shadowed.')
    writeSkill(github, 'e2e-invalid', `description: ${'x'.repeat(1025)}`)
    writeSkill(extra, 'e2e-extra', 'description: Extra folder workflow.')
    seedEmptyProject(workspace, 'e2e-skill-conformance')
    writeSettings({ bundledCursorSkillsEnabled: false })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('explains origins, invocation controls, metadata, invalid and duplicate entries', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const fieldset = $('#sources-skills-fieldset')
    await fieldset.waitForDisplayed()
    await browser.waitUntil(
      async () => (await $('#sources-skills-list').getText()).includes('e2e-model-only'),
      { timeout: 15_000 },
    )
    const names = await browser.execute(() =>
      Array.from(document.querySelectorAll('#sources-skills-list .sources-row')).map((row) => ({
        name: row.querySelector('.sources-row-title')?.textContent,
        controls: row.querySelector('.sources-skill-controls')?.textContent,
      })),
    )
    assert.equal(
      names.find((row) => row.name === 'e2e-model-only')?.controls,
      'Manual off · Model on',
    )
    assert.equal(
      names.find((row) => row.name === 'e2e-manual-only')?.controls,
      'Manual on · Model off',
    )
    await expect($('#sources-skills-diagnostics')).toHaveText('1024', { containing: true })
    await expect($('#sources-skills-diagnostics')).toHaveText('earlier root wins', {
      containing: true,
    })
    await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('#sources-skills-list .sources-row')).find(
        (element) => element.querySelector('.sources-row-title')?.textContent === 'e2e-manual-only',
      )
      const details = row?.querySelector('details')
      if (details) details.open = true
      row?.setAttribute('data-e2e-skill', 'manual')
      const invalid = Array.from(
        document.querySelectorAll('#sources-skills-diagnostics .sources-row'),
      ).find(
        (element) => element.querySelector('.sources-row-title')?.textContent === 'e2e-invalid',
      )
      invalid?.setAttribute('data-e2e-skill', 'invalid')
    })
    await expect($('#sources-skills-list')).toHaveText('Declared tools (descriptive only)', {
      containing: true,
    })
    assert.equal(
      await browser.execute(() => document.querySelector('#sources-skills-list script') === null),
      true,
    )
    await saveElementScreenshot('[data-e2e-skill="manual"]', 'skill-conformance-sources.png')
    await saveElementScreenshot('[data-e2e-skill="invalid"]', 'skill-conformance-diagnostics.png')
  })

  it('saves extra folders and explicitly reloads changed files', async () => {
    await $('.sources-skill-folders summary').click()
    await $('#sources-skill-roots').setValue(extra)
    await $('#sources-skill-roots-save').click()
    await expect($('#sources-skills-status')).toHaveText('Folders saved. Skills reloaded.')
    await expect($('#sources-skills-list')).toHaveText('e2e-extra', { containing: true })
    writeSkill(extra, 'e2e-extra', 'description: Updated extra folder workflow.')
    await expect($('#sources-skills-list')).not.toHaveText('Updated extra folder workflow.', {
      containing: true,
    })
    await $('#sources-skills-reload').click()
    await expect($('#sources-skills-status')).toHaveText('Skills reloaded.')
    await expect($('#sources-skills-list')).toHaveText('Updated extra folder workflow.', {
      containing: true,
    })
    await $('.sources-skill-folders').scrollIntoView()
    await saveElementScreenshot('.sources-skill-folders', 'skill-conformance-reload.png')
  })

  it('hides model-only skills from the slash picker while retaining manual-only skills', async () => {
    await $('#settings-close').click()
    await setComposerValue('/e2e')
    await $('.skill-picker .skill-item').waitForDisplayed({ timeout: 10_000 })
    const picker = $('.skill-picker')
    await expect(picker).toHaveText('/e2e-manual-only', { containing: true })
    await expect(picker).toHaveText('/e2e-extra', { containing: true })
    await expect(picker).not.toHaveText('/e2e-model-only', { containing: true })
    await expect(picker).not.toHaveText('/e2e-invalid', { containing: true })
    await saveAppScreenshot('skill-conformance-picker.png')
  })
})
