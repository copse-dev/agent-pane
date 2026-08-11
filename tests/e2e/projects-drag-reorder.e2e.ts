import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedProjectGroupsFixture } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  dragSidebarRow,
  hoverSidebarDrag,
  readSidebarShape,
  waitForSidebarShape,
} from './helpers/sidebar-drag.ts'

/**
 * Dragging projects around the sidebar (issue #1685), in real Electron.
 *
 * The component tests already assert the DOM this produces. What only the real
 * app can show is that the reorder survives the round trip through config: the
 * relaunch below is the reason this spec exists at the e2e tier at all.
 */
describe('projects sidebar drag-to-reorder', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('drags a project to a new position and keeps it across a relaunch', async () => {
    resetUserData()
    const { projectIds } = seedProjectGroupsFixture(process.cwd())
    const [alpha, , gamma] = projectIds
    if (!alpha || !gamma) throw new Error('fixture did not seed three projects')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.project-row').waitForExist({ timeout: 10_000 })

    await expect(readSidebarShape()).resolves.toEqual(['Alpha', 'Beta', 'Gamma'])
    await saveElementScreenshot('#pane-projects', 'projects-drag-before.png')

    // Hold Gamma over Alpha's upper half: the insertion line shows where it
    // would land, which is the feedback a user reorders by.
    await hoverSidebarDrag({ project: gamma }, { project: alpha }, 'top')
    await expect($('.project-entry.drop-before')).toBeExisting()
    await saveElementScreenshot('#pane-projects', 'projects-drag-indicator.png')

    await dragSidebarRow({ project: gamma }, { project: alpha }, 'top')
    await waitForSidebarShape(['Gamma', 'Alpha', 'Beta'])
    await expect($('.project-entry.drop-before')).not.toBeExisting()
    await saveElementScreenshot('#pane-projects', 'projects-drag-after.png')

    // Relaunch against the same profile: the order has to come back from
    // config.json, not from the store that just rendered it.
    await browser.reloadSession()
    await $('.project-row').waitForExist({ timeout: 30_000 })
    await waitForSidebarShape(['Gamma', 'Alpha', 'Beta'])
    await saveElementScreenshot('#pane-projects', 'projects-drag-persisted.png')
  })
})
