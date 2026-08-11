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
 * Giving a project a parent group by dragging it onto the group header (issue
 * #1685), in real Electron — including the relaunch that proves membership is
 * config, not just a rendered state.
 */
describe('projects sidebar groups', () => {
  before(() => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
  })

  after(() => {
    resetUserData()
  })

  it('drags a project into a group and keeps it parented across a relaunch', async () => {
    resetUserData()
    const { projectIds, groupId } = seedProjectGroupsFixture(process.cwd(), { withGroup: true })
    const [alpha] = projectIds
    if (!alpha) throw new Error('fixture did not seed three projects')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.project-group-row').waitForExist({ timeout: 10_000 })

    // Gamma is seeded inside the group, so the header starts with a member.
    await expect(readSidebarShape()).resolves.toEqual(['Alpha', 'Beta', 'Client work > Gamma'])
    await expect($('.project-group-count')).toHaveText('1')
    await saveElementScreenshot('#pane-projects', 'projects-group-before.png')

    // Held over the header's middle band, the group highlights as a container
    // rather than showing an insertion line — the two drops look different
    // because they mean different things.
    await hoverSidebarDrag({ project: alpha }, { group: groupId }, 'middle')
    await expect($('.project-group.drop-into')).toBeExisting()
    await saveElementScreenshot('#pane-projects', 'projects-group-drop-into.png')

    await dragSidebarRow({ project: alpha }, { group: groupId }, 'middle')
    await waitForSidebarShape(['Beta', 'Client work > Gamma', 'Client work > Alpha'])
    await expect($('.project-group-count')).toHaveText('2')
    await saveElementScreenshot('#pane-projects', 'projects-group-after.png')

    await browser.reloadSession()
    await $('.project-group-row').waitForExist({ timeout: 30_000 })
    await waitForSidebarShape(['Beta', 'Client work > Gamma', 'Client work > Alpha'])
    await saveElementScreenshot('#pane-projects', 'projects-group-persisted.png')
  })

  it('collapses a group to fold its projects away', async () => {
    resetUserData()
    seedProjectGroupsFixture(process.cwd(), { withGroup: true })
    await browser.reloadSession()
    // Wait for the composer, not just for a group row to exist. `main.ts` mounts
    // the panes and only then restores the project, so a group row appears while
    // the sidebar is still being rebuilt — clicking into that window collapses a
    // row that the next render replaces, and the assertion below then reports the
    // half-built sidebar rather than the fold.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('.project-group-row').waitForExist({ timeout: 10_000 })
    // Settle on the expanded shape first: a transition test has to know it
    // started from the state it claims to be changing.
    await waitForSidebarShape(['Alpha', 'Beta', 'Client work > Gamma'])

    await $('.project-group-row').click()
    await waitForSidebarShape(['Alpha', 'Beta', 'Client work > (empty)'])
    await expect($('.project-group-row')).toHaveAttribute('aria-expanded', 'false')
    await saveElementScreenshot('#pane-projects', 'projects-group-collapsed.png')
  })
})
