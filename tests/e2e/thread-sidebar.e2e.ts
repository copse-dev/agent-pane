import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { switchTheme } from './helpers/theme.ts'

async function assertTextAlignment(): Promise<void> {
  const geometry = await browser.execute(() => {
    const pane = document.querySelector('.thread-browser')
    if (!pane) throw new Error('Thread sidebar is missing')
    const bounds = pane.getBoundingClientRect()
    const measure = (selector: string) =>
      Array.from(pane.querySelectorAll(selector), (node) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
    return {
      left: bounds.left,
      right: bounds.right,
      text: measure(
        '.thread-browser-group-label, .chat-title, .thread-browser-meta, .thread-browser-section-empty',
      ),
      trailing: measure(
        '.thread-browser-age, .thread-browser-project, .thread-browser-group-context:not(:empty), .thread-work-filter',
      ),
      gutters: measure('.thread-browser-search, .thread-browser-heading h2'),
      titles: measure('.chat-title'),
      ages: measure('.thread-browser-age'),
      metadata: measure('.thread-browser-meta'),
      subtitleBaselines: Array.from(pane.querySelectorAll('.thread-browser-subtitle'), (subtitle) =>
        Array.from(subtitle.children)
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => {
            const text = Array.from(node.childNodes).find(
              (child) => child.nodeType === Node.TEXT_NODE,
            )
            if (!text) throw new Error('Subtitle item has no text')
            const range = document.createRange()
            range.selectNodeContents(text)
            return range.getBoundingClientRect().bottom
          }),
      ),
    }
  })
  assert.ok(geometry.titles.length > 0, 'alignment is measured against populated rows')
  for (const text of geometry.text)
    assert.ok(Math.abs(text.left - geometry.left - 44) <= 1, 'section and row text share a column')
  for (const trailing of geometry.trailing)
    assert.ok(
      Math.abs(geometry.right - trailing.right - 16) <= 1,
      'trailing text shares a right edge',
    )
  for (const gutter of geometry.gutters)
    assert.ok(Math.abs(gutter.left - geometry.left - 16) <= 1, 'chrome shares the outer gutter')
  for (const baselines of geometry.subtitleBaselines)
    assert.ok(
      Math.max(...baselines) - Math.min(...baselines) <= 1,
      'metadata, file count and project text share a baseline',
    )
  for (const [index, title] of geometry.titles.entries()) {
    const age = geometry.ages[index]
    const metadata = geometry.metadata[index]
    assert.ok(age && metadata)
    assert.ok(title.right <= age.left - 9, 'title leaves space for its age')
    assert.ok(title.bottom <= metadata.top, 'title and metadata do not overlap')
  }
}

function savedThread(id: string, title: string, updatedAt: number) {
  return {
    id,
    title,
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    messages: [
      {
        id: `${id}-message`,
        role: 'user',
        content: `Conversation for ${title}`,
        toolCalls: [],
        createdAt: updatedAt,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

describe('default thread sidebar with real Git status', function () {
  this.timeout(120_000)
  let fixtureRoot = ''
  let dirtyRoot = ''
  let cleanRoot = ''
  const git = (root: string, ...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }

  before(async () => {
    resetUserData()
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'copse-thread-sidebar-')))
    for (const kind of ['dirty', 'clean']) {
      // Keep the titlebar's folder name stable while isolating each run's Git repositories.
      const root = join(fixtureRoot, `${kind}-project`)
      mkdirSync(root)
      git(root, 'init', '-q', '-b', 'main')
      git(root, 'config', 'user.name', 'Copse Test')
      git(root, 'config', 'user.email', 'copse@example.invalid')
      git(root, 'config', 'commit.gpgSign', 'false')
      git(root, 'config', 'core.fsmonitor', 'false')
      writeFileSync(join(root, 'tracked.txt'), 'Original\n')
      git(root, 'add', 'tracked.txt')
      git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial')
      if (kind === 'dirty') dirtyRoot = root
      else cleanRoot = root
    }
    writeFileSync(join(dirtyRoot, 'tracked.txt'), 'Staged\n')
    git(dirtyRoot, 'add', 'tracked.txt')
    writeFileSync(join(dirtyRoot, 'tracked.txt'), 'Staged and unstaged\n')
    writeFileSync(join(dirtyRoot, 'new.txt'), 'Untracked\n')
    const now = Date.now()
    // Hour-scale ages stay stable throughout this bounded run and preserve relative ordering.
    const hour = 60 * 60 * 1_000
    writeSeedConfig({
      projects: [
        { id: 'sidebar-dirty', name: 'Uncommitted project', path: dirtyRoot },
        { id: 'sidebar-clean', name: 'Clean project', path: cleanRoot },
      ],
      activeProjectId: 'sidebar-clean',
      activeThreadId: 'sidebar-clean-thread',
      'threads:sidebar-dirty': [
        savedThread('sidebar-dirty-thread', 'Finished work to commit', now - 2 * hour),
      ],
      'threads:sidebar-clean': [
        savedThread('sidebar-clean-thread', 'Clean conversation', now - hour),
        savedThread('sidebar-earlier-thread', 'Earlier conversation', now - 4 * hour),
      ],
    })
    seedE2eViewport()
    await browser.reloadSession()
    await $('.thread-browser').waitForDisplayed({ timeout: 60_000 })
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  after(() => {
    resetUserData()
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('starts in Activity and finds staged, unstaged and untracked work in an unopened project', async () => {
    await expect($('[aria-label="Sort threads"]')).toHaveValue('activity')
    await expect($('.thread-browser-sort-direction svg')).toBeDisplayed()
    await expect($('.thread-browser-sort-direction')).toHaveText('')
    await expect($('.thread-browser-sort-direction')).toHaveAttribute(
      'data-direction',
      'descending',
    )
    await $('[data-thread-id="sidebar-dirty-thread"] .thread-browser-work').waitForExist()
    await expect($('[data-thread-id="sidebar-dirty-thread"] .thread-browser-work')).toHaveText(
      '2 files',
    )
    await expect($('[data-thread-id="sidebar-dirty-thread"] .thread-browser-work')).toHaveAttribute(
      'title',
      '1 staged · 1 unstaged · 1 untracked',
    )
    await expect(
      $('[data-group="changes"] [data-thread-id="sidebar-dirty-thread"]'),
    ).toBeDisplayed()
    await expect(
      $('[data-group="threads"] [data-thread-id="sidebar-clean-thread"]'),
    ).toBeDisplayed()
    await expect($('.thread-browser-columns')).not.toBeExisting()
    const paneWidth = await $('.thread-browser').getSize('width')
    assert.equal(paneWidth, 300)
    await assertTextAlignment()
    await saveAppScreenshot('thread-sidebar-activity-dark.png')
    await $('.thread-work-filter').click()
    await expect($$('.thread-browser-row')).toBeElementsArrayOfSize(1)
    await expect($('.thread-browser-row')).toHaveAttribute('data-thread-id', 'sidebar-dirty-thread')
    await saveAppScreenshot('thread-sidebar-uncommitted-dark.png')
    await $('.thread-browser-row').click()
    await expect($('.thread-browser-row')).toHaveElementClass('selected')
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Conversation for Finished work to commit'),
    )
  })

  it('combines section filtering, project scope, search and reversible sorting', async () => {
    await expect($('.thread-work-filter')).toHaveAttribute('aria-pressed', 'true')
    await $('[aria-label="Filter by project"]').selectByAttribute('value', 'sidebar-clean')
    await expect($$('.thread-browser-row')).toBeElementsArrayOfSize(0)
    await $('.thread-browser-reset').click()
    await $('[aria-label="Filter by project"]').selectByAttribute('value', 'sidebar-clean')
    await $('[aria-label="Sort threads"]').selectByAttribute('value', 'updated')
    await expect($('.thread-browser-row')).toHaveAttribute('data-thread-id', 'sidebar-clean-thread')
    await $('.thread-browser-sort-direction').click()
    await expect($('.thread-browser-sort-direction')).toHaveAttribute('data-direction', 'ascending')
    await expect($('.thread-browser-row')).toHaveAttribute(
      'data-thread-id',
      'sidebar-earlier-thread',
    )
    await $('.thread-browser-sort-direction').click()
    await expect($('.thread-browser-row')).toHaveAttribute('data-thread-id', 'sidebar-clean-thread')
    await switchTheme('light')
    await assertTextAlignment()
    await saveAppScreenshot('thread-sidebar-inbox-light.png')
    await $('[aria-label="Filter by project"]').selectByAttribute('value', '')
    await $('[aria-label="Find threads"]').setValue('Finished')
    await expect($$('.thread-browser-row')).toBeElementsArrayOfSize(1)
    const geometry = await browser.execute(() => {
      const pane = document.querySelector('.thread-browser')
      const row = document.querySelector('.thread-browser-row')
      if (!pane || !row) return null
      return {
        paneWidth: pane.clientWidth,
        rowWidth: row.getBoundingClientRect().width,
        scrollWidth: pane.scrollWidth,
      }
    })
    assert.ok(geometry)
    assert.ok(geometry.rowWidth <= geometry.paneWidth + 1)
    assert.ok(geometry.scrollWidth <= geometry.paneWidth + 1)
  })

  it('updates the filter after a real commit and preserves project management', async () => {
    await $('.thread-work-filter').click()
    git(dirtyRoot, 'add', '.')
    git(dirtyRoot, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Finish work')
    await $('[aria-label="Refresh threads and Git status"]').click()
    await expect($$('.thread-browser-row')).toBeElementsArrayOfSize(0)
    await $('.thread-browser-manage').click()
    await expect($('.thread-project-manager')).toBeDisplayed()
    await expect($('.thread-project-manager .projects-add-btn')).toBeDisplayed()
    await $('.thread-browser-back').click()
    await expect($('.thread-browser')).toBeDisplayed()
    await $('.thread-browser [aria-label="New thread"]').click()
    await expect($('.thread-work-filter')).toHaveAttribute('aria-pressed', 'false')
    await expect($('[aria-label="Find threads"]')).toHaveValue('')
    await expect($('.thread-browser-row.selected')).not.toHaveAttribute(
      'data-thread-id',
      'sidebar-dirty-thread',
    )
  })

  it('manages threads, projects and automations without opening Projects', async () => {
    const menuLabels = async (): Promise<string[]> =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('.context-menu-item'), (item) => item.textContent),
      )
    await $('[aria-label="Find threads"]').setValue('')
    await $('[aria-label="Filter by project"]').selectByAttribute('value', '')

    const dirtyRow = $('.thread-browser [data-thread-id="sidebar-dirty-thread"]')
    await dirtyRow.click({ button: 'right' })
    await $('.context-menu').waitForDisplayed()
    assert.deepEqual(await menuLabels(), ['Rename', 'Fork', 'Archive', 'Delete'])
    await saveAppScreenshot('thread-sidebar-row-menu.png')
    await $('.context-menu-item=Rename').click()
    const rename = $('.thread-browser .chat-title-rename')
    await expect(rename).toBeFocused()
    await rename.setValue('Renamed from the sidebar')
    await browser.keys('Enter')
    await expect(dirtyRow.$('.chat-title')).toHaveText('Renamed from the sidebar')

    await $('.thread-browser [data-thread-id="sidebar-earlier-thread"]').click({ button: 'right' })
    await $('.context-menu').waitForDisplayed()
    assert.deepEqual(await menuLabels(), ['Open thread'])
    await browser.keys('Escape')

    await $('.thread-browser-more').click()
    await $('.context-menu').waitForDisplayed()
    const moreLabels = await menuLabels()
    for (const label of ['New project', 'Open folder', 'New automation…', 'Activity'])
      assert.ok(moreLabels.includes(label), `More menu offers ${label}`)
    await browser.keys('Escape')

    await expect($('.thread-browser-project-menu')).not.toBeDisplayed()
    await $('[aria-label="Filter by project"]').selectByAttribute('value', 'sidebar-dirty')
    await expect($('.thread-browser-project-menu')).toHaveAttribute(
      'aria-label',
      'Project menu for Uncommitted project',
    )
    await $('.thread-browser-project-menu').click()
    await $('.context-menu').waitForDisplayed()
    assert.ok((await menuLabels()).includes('Remove from sidebar'))
    await saveAppScreenshot('thread-sidebar-project-menu.png')
    await browser.keys('Escape')

    await dirtyRow.click({ button: 'right' })
    await $('.context-menu-item=Archive').click()
    await expect(dirtyRow).not.toBeExisting()
  })
})
