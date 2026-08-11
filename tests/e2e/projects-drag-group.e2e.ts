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
    // the sidebar is still being rebuilt, and a click into that window lands on a
    // row the next render replaces.
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const groupRow = await $('.project-group-row')
    await groupRow.waitForExist({ timeout: 10_000 })

    // Assert the fold against the group's own members rather than the sidebar's
    // whole contents. The seed above cannot be relied on to decide those
    // contents: `resetUserData()` runs while the previous test's app is still
    // live, and that app's own config writes land back on top of the fresh seed
    // — which is exactly what this spec caught, reporting the previous test's
    // post-drag sidebar. Collapsing is a statement about one group either way,
    // so scoping the assertion there makes it true of any starting state.
    await expect(groupRow).toHaveAttribute('aria-expanded', 'true')
    await expect($('.project-group-children .project-row')).toBeExisting()

    await groupRow.click()
    await browser.waitUntil(
      async () => (await groupRow.getAttribute('aria-expanded')) === 'false',
      { timeout: 10_000, timeoutMsg: 'group header never reported itself collapsed' },
    )
    await expect($('.project-group-children .project-row')).not.toBeExisting()
    await saveElementScreenshot('#pane-projects', 'projects-group-collapsed.png')
  })
})
