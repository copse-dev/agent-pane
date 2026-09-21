import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedProjectSwitchFixture, seedRoadmapNotes } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

describe('roadmap project switching', () => {
  let projectA: string
  let projectB: string
  const cleanup: string[] = []

  before(async () => {
    resetUserData()
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-roadmap-switch-'))
    cleanup.push(workspaceRoot)
    ;({ projectAId: projectA, projectBId: projectB } = seedProjectSwitchFixture(workspaceRoot, {
      roadmapPlansEnabled: true,
    }))
    cleanup.push(
      seedRoadmapNotes(projectA, [
        { id: 'item-a', title: 'Project A roadmap', body: 'Only belongs to project A.' },
      ]),
      seedRoadmapNotes(projectB, [
        { id: 'item-b', title: 'Project B roadmap', body: 'Only belongs to project B.' },
      ]),
    )
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    for (const path of cleanup) rmSync(path, { recursive: true, force: true })
  })

  it('clears the selected editor when switching to another project with roadmap open', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const openRoadmap = $('.titlebar-text-btn[aria-label="Open roadmap"]')
    await openRoadmap.click()
    await expect($('.roadmap-row-title')).toHaveText('Project A roadmap')

    // Prime both projects' saved panel state, so switching restores the roadmap
    // directly instead of hiding the old editor behind a closed pane.
    await $('.project-row*=Project B').click()
    await openRoadmap.click()
    await expect($('.roadmap-row-title')).toHaveText('Project B roadmap')
    await $('.project-row*=Project A').click()
    await expect($('.roadmap-row-title')).toHaveText('Project A roadmap')
    await $('.roadmap-row').click()
    await expect($('.roadmap-prompt-input')).toHaveValue('Only belongs to project A.')

    await $('.project-row*=Project B').click()
    await expect($('.roadmap-row-title')).toHaveText('Project B roadmap')
    await $('.roadmap-empty').waitForDisplayed()
    assert.equal(await $('.roadmap-form').isDisplayed(), false)
    assert.equal(await $('.roadmap-row.is-selected').isExisting(), false)
    await saveAppScreenshot('roadmap-project-switch-cleared.png')

    await $('.roadmap-row').click()
    await expect($('.roadmap-prompt-input')).toHaveValue('Only belongs to project B.')
    await $('.project-row*=Project A').click()
    await expect($('.roadmap-row-title')).toHaveText('Project A roadmap')
    await $('.roadmap-empty').waitForDisplayed()
    assert.equal(await $('.roadmap-form').isDisplayed(), false)
  })
})
