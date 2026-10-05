import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The sort menu beside the sidebar's thread filter: it lists the sorts, marks the
// current one, and re-orders a project's threads. The same menu's Group by choice
// swaps the project tree for status sections or one flat list.

async function titles(): Promise<string[]> {
  const rows = await $$('.chats-list .chat-title')
  return rows.map((row) => row.getText())
}

async function openMenu(): Promise<void> {
  await $('.projects-sort-btn').click()
  await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
}

async function choose(label: string): Promise<void> {
  const items = await $$('.context-menu-item')
  for (const item of items) {
    if ((await item.getText()) === label) {
      await item.click()
      return
    }
  }
  throw new Error(`The sort menu has no "${label}"`)
}

// The project label must stay readable at the default sidebar width: the title
// ellipsizes before the label does.
async function expectOwnerLabelsFit(): Promise<void> {
  const fits = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.chats-list .chat-thread-owner')).map(
      (owner) => ({
        text: owner.textContent,
        scrollWidth: owner.scrollWidth,
        clientWidth: owner.clientWidth,
      }),
    ),
  )
  expect(fits.length).toBeGreaterThan(0)
  for (const fit of fits) {
    expect(fit.text).toBe('· copse-demo')
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth)
  }
}

describe('sidebar thread sort', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=sidebar-thread-sort')
    await $('.projects-sort-btn').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(async () => (await titles()).includes('Refactor auth'), {
      timeout: 30_000,
      timeoutMsg: 'the scenario threads must be listed',
    })
  })

  it('shows the search field and the project and sort buttons under it', async () => {
    await expect($('.pane-projects-header .projects-search-input')).toBeDisplayed()
    await expect($('.projects-filters .projects-filter-btn')).toHaveText('All projects')
    await saveAppScreenshot('sidebar-search-and-filters.png')
  })

  it('opens the header plus with New thread first, and closes it on a second click', async () => {
    await $('.projects-add-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    const labels = await (await $$('.context-menu-item')).map((i) => i.getText())
    expect(labels.slice(0, 2)).toEqual(['New thread', 'New project'])
    await saveAppScreenshot('sidebar-add-menu.png')
    await $('.projects-add-btn').click()
    await $('.context-menu').waitForExist({ timeout: 5_000, reverse: true })
  })

  it('counts each projects threads in the project menu', async () => {
    await $('.projects-filters .projects-filter-btn').click()
    await $('.context-menu').waitForDisplayed({ timeout: 5_000 })
    const rows = await (await $$('.context-menu-item')).map((i) => i.getText())
    expect(rows[0]).toMatch(/^All projects\s+\d+$/)
    await saveAppScreenshot('sidebar-project-menu.png')
    await $('.projects-filters .projects-filter-btn').click()
    await $('.context-menu').waitForExist({ timeout: 5_000, reverse: true })
  })

  it('offers the sorts and marks the current one', async () => {
    await openMenu()
    const labels = await (await $$('.context-menu-item')).map((i) => i.getText())
    expect(labels).toEqual([
      'Status',
      'Project',
      'None',
      'Activity order',
      'Created',
      'Thread name',
      'Reverse order',
      'Compact rows',
    ])
    const checked = await (await $$('.context-menu-item.is-checked')).map((i) => i.getText())
    expect(checked).toEqual(['Project', 'Activity order'])
    await saveAppScreenshot('sidebar-thread-sort-menu.png')
    await browser.keys('Escape')
  })

  it('sorts by thread name, then reverses', async () => {
    const before = await titles()
    expect(before.length).toBeGreaterThan(2)
    await openMenu()
    await choose('Thread name')
    const byName = await titles()
    expect(byName).toEqual(
      [...before].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    )
    await saveAppScreenshot('sidebar-thread-sort-by-name.png')

    await openMenu()
    await choose('Reverse order')
    expect(await titles()).toEqual([...byName].reverse())
  })

  it('groups by status, then flat, then back to the project tree', async () => {
    await openMenu()
    await choose('Status')
    await $('.thread-section-heading').waitForExist({ timeout: 5_000 })
    const headings = await (await $$('.thread-section-heading')).map((h) => h.getText())
    expect(headings).toEqual(['Working', 'Recent'])
    await expect($('.project-row')).not.toExist()
    await expect($('.chat-thread-owner')).toExist()
    await expectOwnerLabelsFit()
    await saveAppScreenshot('sidebar-thread-group-status.png')

    await openMenu()
    await choose('None')
    await browser.waitUntil(async () => (await $$('.thread-section-heading')).length === 0)
    expect((await titles()).length).toBe(5)
    await expectOwnerLabelsFit()
    await saveAppScreenshot('sidebar-thread-group-none.png')

    await openMenu()
    await choose('Project')
    await $('.project-row').waitForExist({ timeout: 5_000 })
  })
})
