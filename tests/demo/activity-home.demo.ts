import { $, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from '../e2e/helpers/screenshot.ts'

// The new-thread screen is the Activity view above a docked composer
// (views/activity-home.ts), laid out after prototypes/new-thread-activity.html.
// The scenario opens on an empty thread with one approval waiting, two runs
// working and one that finished while the user was elsewhere, so every group
// draws. The spec asserts the geometry that makes it usable — a project strip,
// then the card above the composer, nothing sideways, composer keeps focus — and
// saves dark, light and narrow-pane captures for review.

interface GroupProbe {
  collapsed: boolean
  count: string
  rows: string[]
}

interface HomeProbe {
  groups: Record<string, GroupProbe>
  strip: string[]
  bodyBottom: number
  captionTop: number
  captionBottom: number
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
    const caption = root?.querySelector('.activity-home-caption')
    const conversation = document.getElementById('conversation')
    if (!root || !body || !input || !caption || !conversation) return null
    const groups: Record<string, GroupProbe> = {}
    for (const group of root.querySelectorAll<HTMLElement>('.activity-group')) {
      groups[group.dataset['group'] ?? ''] = {
        collapsed: group.dataset['collapsed'] === 'true',
        count: group.querySelector('.activity-group-count')?.textContent ?? '',
        rows: [...group.querySelectorAll('.activity-thread')].map(
          (title) => title.textContent ?? '',
        ),
      }
    }
    const strip = [...root.querySelectorAll('.activity-strip-card')].map(
      (card) => card.textContent ?? '',
    )
    const columns = getComputedStyle(body).gridTemplateColumns.split(' ').length
    return {
      groups,
      strip,
      bodyBottom: body.getBoundingClientRect().bottom,
      captionTop: caption.getBoundingClientRect().top,
      captionBottom: caption.getBoundingClientRect().bottom,
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
    expect(probe.groups['needs-you']?.rows).toEqual(['Refactor auth'])
    // Working starts folded and says how many it holds.
    expect(probe.groups['working']?.collapsed).toBe(true)
    expect(probe.groups['working']?.count).toBe('2')
    expect(probe.groups['working']?.rows).toEqual([])
    expect(probe.groups['recent']?.rows).toEqual(['Update onboarding copy'])
    // The strip: All projects first, then the one project that needs you.
    expect(probe.strip).toHaveLength(2)
    expect(probe.strip[0]).toContain('All projects')
    expect(probe.strip[0]).toContain('1 need you')
    expect(probe.strip[1]).toContain('copse-demo')
    // The card ends above the caption, which sits just over the composer, so
    // nothing is behind the composer and the card fills the pane down to them. A
    // gap of more than the caption means something else is taking the space (the
    // pane once picked up the home's own padding by class name).
    expect(probe.bodyBottom).toBeLessThanOrEqual(probe.captionTop + 1)
    expect(probe.captionBottom).toBeLessThanOrEqual(probe.inputTop + 1)
    expect(probe.inputTop - probe.bodyBottom).toBeLessThanOrEqual(56)
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
    await expect($('#activity-home .activity-approve')).toHaveText('Approve')
    await expect($('#activity-home .activity-reject')).toBeExisting()
    const look = await browser.execute(() => {
      const approve = document.querySelector('#activity-home .activity-approve')
      const reject = document.querySelector('#activity-home .activity-reject')
      const open = document.querySelector('#activity-home .activity-open-thread')
      const bell = document.querySelector('.projects-activity-btn')
      const glyph = document.querySelector(
        '#activity-home .activity-row[data-state="needs-approval"] .activity-glyph',
      )
      // What --text-primary resolves to, to compare colours without parsing them.
      const probe = document.createElement('span')
      probe.style.color = 'var(--text-primary)'
      document.body.append(probe)
      const neutral = getComputedStyle(probe).color
      probe.remove()
      return {
        approveHeight: approve?.getBoundingClientRect().height ?? 0,
        rejectHeight: reject?.getBoundingClientRect().height ?? 0,
        arrow: open?.querySelector('svg.activity-open-arrow') !== null,
        bellColor: bell ? getComputedStyle(bell).color : null,
        glyphColor: glyph ? getComputedStyle(glyph).color : null,
        neutral,
      }
    })
    // The prototype's pills are about 29px tall; the kit's cap-trimmed default is 22px.
    expect(look.approveHeight).toBeGreaterThanOrEqual(27)
    expect(look.approveHeight).toBeLessThanOrEqual(31)
    expect(look.rejectHeight).toBeGreaterThanOrEqual(27)
    expect(look.rejectHeight).toBeLessThanOrEqual(31)
    // "Open thread" ends in an arrow icon, not a text glyph.
    expect(look.arrow).toBe(true)
    // Attention is neutral: the bell and the waiting row's glyph are not yellow.
    expect(look.bellColor).toBe(look.neutral)
    expect(look.glyphColor).toBe(look.neutral)
    await saveAppScreenshot('activity-home-dark.png')
  })

  it('unfolds Working from its header and lists both runs', async () => {
    const header = $('#activity-home [data-group-toggle="working"]')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    const titles = await $$('#activity-home .activity-group[data-group="working"] .activity-thread')
    expect(titles).toHaveLength(2)
    await saveAppScreenshot('activity-home-working-open.png')
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
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
    // The stacked card scrolls as a whole, so the action bar must still be inside
    // its visible area: Approve and Reject are the point of the detail pane.
    const actionsVisible = await browser.execute(() => {
      const body = document.querySelector('#activity-home .activity-panel-body')
      const approve = document.querySelector('#activity-home .activity-approve')
      if (!body || !approve) return false
      const frame = body.getBoundingClientRect()
      const button = approve.getBoundingClientRect()
      return button.top >= frame.top && button.bottom <= frame.bottom + 1
    })
    expect(actionsVisible).toBe(true)
    // The stacked list must keep room for its rows, not be squeezed to its padding.
    const listVisible = await browser.execute(() => {
      const body = document.querySelector('#activity-home .activity-panel-body')
      const row = document.querySelector('#activity-home .activity-row')
      const list = document.querySelector('#activity-home .activity-list')
      if (!body || !row || !list) return false
      const frame = body.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      return (
        list.getBoundingClientRect().height >= 100 &&
        box.top >= frame.top &&
        box.bottom <= frame.bottom
      )
    })
    expect(listVisible).toBe(true)
    await saveAppScreenshot('activity-home-narrow.png')
    await $('.titlebar-btn[aria-label="Toggle right panel"]').click()
  })

  it('shrinks the project tiles and keeps Approve above the composer in a short window', async () => {
    const before = await browser.getWindowSize()
    await browser.setWindowSize(1280, 560)
    try {
      await browser.waitUntil(
        async () =>
          browser.execute(
            () =>
              (document.querySelector('#activity-home .activity-strip')?.getBoundingClientRect()
                .height ?? 99) < 50,
          ),
        {
          timeout: 10_000,
          timeoutMsg: 'the tiles must shrink to one-line pills in a short window',
        },
      )
      const probe = await browser.execute(() => {
        const approve = document.querySelector('#activity-home .activity-approve')
        const input = document.getElementById('input-bar')
        return {
          approveBottom: approve?.getBoundingClientRect().bottom ?? 0,
          inputTop: input?.getBoundingClientRect().top ?? 0,
        }
      })
      expect(probe.approveBottom).toBeLessThanOrEqual(probe.inputTop + 1)
    } finally {
      await browser.setWindowSize(before.width, before.height)
    }
  })
})

describe('browser-hosted Activity home with nothing to list', () => {
  before(async () => {
    await browser.url('about:blank')
    await browser.url('/?scenario=activity-home-empty')
    await $('.pane-chat.is-activity-idle').waitForExist({ timeout: 30_000 })
  })

  it('leaves just the composer, centred in the pane', async () => {
    const probe = await browser.execute(() => {
      const home = document.getElementById('activity-home')
      const input = document.getElementById('input-bar')
      const pane = document.getElementById('pane-chat')
      if (!home || !input || !pane) return null
      const bar = input.getBoundingClientRect()
      const frame = pane.getBoundingClientRect()
      return {
        homeDisplay: getComputedStyle(home).display,
        barMid: (bar.top + bar.bottom) / 2,
        paneMid: (frame.top + frame.bottom) / 2,
        barLeftGap: bar.left - frame.left,
        barRightGap: frame.right - bar.right,
        composerFocused: input.contains(document.activeElement),
      }
    })
    await saveAppScreenshot('activity-home-empty.png')
    expect(probe).not.toBeNull()
    if (!probe) return
    // No strip, card or caption: the screen steps aside until there is something to list.
    expect(probe.homeDisplay).toBe('none')
    expect(Math.abs(probe.barMid - probe.paneMid)).toBeLessThanOrEqual(2)
    expect(Math.abs(probe.barLeftGap - probe.barRightGap)).toBeLessThanOrEqual(2)
    expect(probe.composerFocused).toBe(true)
  })
})
