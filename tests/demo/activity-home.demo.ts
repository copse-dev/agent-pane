import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The new-thread screen is the Activity view above a docked composer
// (views/activity-home.ts). The scenario opens on an empty thread with one
// approval waiting, two runs working and one that finished while the user was
// elsewhere, so every group draws. The spec asserts the geometry that makes it
// usable — list above the composer, nothing sideways, composer keeps focus —
// and saves dark, light and narrow-pane captures for review.

interface HomeProbe {
  groups: Record<string, string[]>
  bodyBottom: number
  inputTop: number
  overflowsSideways: boolean
  conversationDisplay: string
  composerFocused: boolean
  twoColumns: boolean
  panePaddingBottom: string
}

async function probeHome(): Promise<HomeProbe | null> {
  return browser.execute(() => {
    const root = document.getElementById('activity-home')
    const body = root?.querySelector('.activity-panel-body')
    const input = document.getElementById('input-bar')
    const conversation = document.getElementById('conversation')
    if (!root || !body || !input || !conversation) return null
    const groups: Record<string, string[]> = {}
    for (const group of root.querySelectorAll<HTMLElement>('.activity-group')) {
      groups[group.dataset['group'] ?? ''] = [...group.querySelectorAll('.activity-thread')].map(
        (title) => title.textContent ?? '',
      )
    }
    const columns = getComputedStyle(body).gridTemplateColumns.split(' ').length
    return {
      groups,
      bodyBottom: body.getBoundingClientRect().bottom,
      inputTop: input.getBoundingClientRect().top,
      overflowsSideways: root.scrollWidth > root.clientWidth,
      conversationDisplay: getComputedStyle(conversation).display,
      composerFocused: document.activeElement?.classList.contains('prompt-input') === true,
      twoColumns: columns === 2,
      panePaddingBottom: getComputedStyle(document.getElementById('pane-chat') as Element)
        .paddingBottom,
    }
  })
}

describe('browser-hosted Activity home', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home')
    await $('.pane-chat.is-activity-home').waitForExist({ timeout: 30_000 })
    // The fixture's approval arrives a tick after the first draw, so wait for every
    // group rather than racing it.
    await $('#activity-home .activity-row[data-state="needs-approval"]').waitForExist({
      timeout: 30_000,
    })
  })

  it('lists every group above a docked composer that keeps focus', async () => {
    const probe = await probeHome()
    expect(probe).not.toBeNull()
    if (!probe) throw new Error('Missing Activity home elements')
    expect(probe.groups['needs-you']).toEqual(['Refactor auth'])
    expect([...(probe.groups['working'] ?? [])].sort()).toEqual([
      'Dependency audit',
      'Fix the flaky sandbox test',
    ])
    expect(probe.groups['recent']).toEqual(['Update onboarding copy'])
    // The list ends above the composer, never behind it, and fills the pane down
    // to it: a gap of more than one spacing step means something else is taking
    // the space (the pane once picked up the home's own padding by class name).
    expect(probe.bodyBottom).toBeLessThanOrEqual(probe.inputTop + 1)
    expect(probe.inputTop - probe.bodyBottom).toBeLessThanOrEqual(24)
    expect(probe.panePaddingBottom).toBe('0px')
    expect(probe.overflowsSideways).toBe(false)
    expect(probe.conversationDisplay).toBe('none')
    // Opening the screen must leave the caret in the composer, not in the list.
    expect(probe.composerFocused).toBe(true)
    expect(probe.twoColumns).toBe(true)
  })

  it('shows the approval in the detail pane when its row is chosen', async () => {
    // The fixture's approval arrives after the first draw, and a request landing
    // never moves the selection under the user, so choose its row explicitly.
    const row = $('#activity-home .activity-row[data-state="needs-approval"] .activity-row-open')
    await row.waitForClickable({ timeout: 10_000 })
    await row.click()
    await expect($('#activity-home .activity-detail-title')).toHaveText('Refactor auth')
    await expect($('#activity-home .activity-approve')).toBeExisting()
    await expect($('#activity-home .activity-reject')).toBeExisting()
    await saveAppScreenshot('activity-home-dark.png')
  })

  it('keeps ids unique beside the overlay', async () => {
    const duplicates = await browser.execute(() => {
      const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
      return ids.filter((id, index) => ids.indexOf(id) !== index)
    })
    expect(duplicates).toEqual([])
  })

  it('reads in the light theme', async () => {
    await browser.execute(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await saveAppScreenshot('activity-home-light.png')
    await browser.execute(() => {
      document.documentElement.dataset.theme = 'dark'
    })
  })

  it('stacks list over detail in a narrow pane without spilling sideways', async () => {
    // The right panel takes the chat pane's width, which is the real way it gets
    // narrow: resizing the window does not change the pane in this tier.
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
    await $('#pane-files').waitForDisplayed()
    await browser.waitUntil(async () => (await probeHome())?.twoColumns === false, {
      timeout: 10_000,
      timeoutMsg: 'the narrow pane must stack the list over the detail',
    })
    const probe = await probeHome()
    expect(probe).not.toBeNull()
    if (!probe) throw new Error('Missing Activity home elements')
    expect(probe.overflowsSideways).toBe(false)
    expect(probe.bodyBottom).toBeLessThanOrEqual(probe.inputTop + 1)
    await saveAppScreenshot('activity-home-narrow.png')
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
  })
})
