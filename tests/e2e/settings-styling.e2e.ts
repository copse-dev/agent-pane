import { $, $$, browser, expect } from '@wdio/globals'
import assert from 'node:assert/strict'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Visual eval for the Settings restyle: the display-face heading tier, the
// roomier rhythm and hit areas, the sidebar contents list under the open
// section, the see-through footer, and the Plugins / Appearance surfaces.
describe('settings styling', function () {
  this.timeout(120_000)
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-settings-styling')
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark', uiScale: 1 })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('gives sections a display-face heading tier over roomier controls', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })

    const type = await browser.execute(() => {
      const section = document.querySelector<HTMLElement>('.settings-section.active')
      const heading = section?.querySelector<HTMLElement>('h3')
      const legend = section?.querySelector<HTMLElement>(':scope > fieldset > legend')
      const desc = section?.querySelector<HTMLElement>('.settings-section-desc')
      const navBtn = document.querySelector<HTMLElement>('.settings-nav-btn.active')
      const search = document.querySelector<HTMLElement>('.settings-search-input')
      if (!heading || !legend || !desc || !navBtn || !search) return null
      const size = (el: HTMLElement): number => Number.parseFloat(getComputedStyle(el).fontSize)
      const display = getComputedStyle(document.documentElement)
        .getPropertyValue('--font-display')
        .trim()
      return {
        displayFamily: display.split(',')[0]?.replace(/['"]/g, '').trim() ?? '',
        headingFamily: getComputedStyle(heading).fontFamily,
        legendFamily: getComputedStyle(legend).fontFamily,
        bodyFamily: getComputedStyle(desc).fontFamily,
        headingSize: size(heading),
        legendSize: size(legend),
        descSize: size(desc),
        navHeight: navBtn.getBoundingClientRect().height,
        searchHeight: search.getBoundingClientRect().height,
      }
    })

    assert.ok(type, 'settings heading tier must be present')
    // The section title and its group headings carry the display serif; the
    // prose under them stays in the interface family.
    assert.ok(type.displayFamily.length > 0, 'a --font-display family must be defined')
    assert.ok(
      type.headingFamily.includes(type.displayFamily),
      `section title must use ${type.displayFamily}, got ${type.headingFamily}`,
    )
    assert.ok(
      type.legendFamily.includes(type.displayFamily),
      `group heading must use ${type.displayFamily}, got ${type.legendFamily}`,
    )
    assert.ok(
      !type.bodyFamily.includes(type.displayFamily),
      `section blurb must stay in the interface family, got ${type.bodyFamily}`,
    )
    // Three distinct tiers, largest first.
    assert.ok(
      type.headingSize > type.legendSize && type.legendSize > type.descSize,
      `heading ${String(type.headingSize)} > legend ${String(type.legendSize)} > desc ${String(type.descSize)}`,
    )
    // Nav rows and the search box are full targets, not lines of text.
    assert.ok(type.navHeight >= 34, `nav row height ${String(type.navHeight)} must be >= 34`)
    assert.ok(
      type.searchHeight >= 34,
      `search box height ${String(type.searchHeight)} must be >= 34`,
    )

    await saveElementScreenshot('#settings-dialog', 'settings-styling-general.png')
  })

  it('lists the open section’s groups in the sidebar and jumps to them', async () => {
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await $('.settings-nav-subheadings').waitForDisplayed({ timeout: 10_000 })

    const subheadings = await browser.execute(() => {
      const nav = document.querySelector<HTMLElement>('.settings-nav')
      const activeBtn = document.querySelector<HTMLElement>('.settings-nav-btn.active')
      const list = document.querySelector<HTMLElement>('.settings-nav-subheadings')
      const section = document.querySelector<HTMLElement>('.settings-section.active')
      if (!nav || !activeBtn || !list || !section) return null
      const legends = Array.from(
        section.querySelectorAll<HTMLElement>(':scope > fieldset > legend'),
      )
        .filter((legend) => !legend.closest('fieldset')?.hidden)
        .map((legend) => legend.textContent.trim())
      return {
        followsActiveRow: activeBtn.nextElementSibling === list,
        labels: Array.from(list.querySelectorAll<HTMLElement>('.settings-nav-subheading')).map(
          (btn) => btn.textContent.trim(),
        ),
        legends,
        minHeight: Math.min(
          ...Array.from(list.querySelectorAll<HTMLElement>('.settings-nav-subheading')).map(
            (btn) => btn.getBoundingClientRect().height,
          ),
        ),
      }
    })

    assert.ok(subheadings, 'the open section must list its groups in the sidebar')
    assert.equal(subheadings.followsActiveRow, true, 'contents list sits under the active row')
    assert.deepEqual(
      subheadings.labels,
      subheadings.legends,
      'sidebar subheadings mirror the section’s own group headings',
    )
    assert.ok(subheadings.labels.length >= 2, 'Appearance has several groups')
    assert.ok(subheadings.minHeight >= 26, 'subheadings are clickable rows, not bare text')

    // Clicking one scrolls that group into the scrollport.
    const subheadingEls = await $$('.settings-nav-subheading')
    const lastSubheading = subheadingEls.at(-1)
    assert.ok(lastSubheading, 'expected a last group to jump to')
    await lastSubheading.click()
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => (document.querySelector<HTMLElement>('.settings-content')?.scrollTop ?? 0) > 0,
        ),
      { timeout: 10_000, timeoutMsg: 'clicking a subheading must scroll to its group' },
    )

    await saveElementScreenshot('#settings-dialog', 'settings-styling-nav-subheadings.png')
  })

  it('keeps the footer see-through so content reads as still scrolling', async () => {
    const footer = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const bar = document.querySelector<HTMLElement>('.settings-buttons')
      if (!content || !bar) return null
      content.scrollTop = Math.round(content.scrollHeight / 2)
      const style = getComputedStyle(bar)
      const overlay = getComputedStyle(bar, '::before')
      const barRect = bar.getBoundingClientRect()
      // Something from the scrolled section must actually pass under the bar —
      // otherwise the transparency has nothing to reveal. Hit testing can't
      // answer this (the bar is topmost whatever its opacity), so overlap the
      // rectangles instead.
      const section = document.querySelector<HTMLElement>('.settings-section.active')
      const passesUnder = Array.from(section?.querySelectorAll<HTMLElement>('*') ?? []).some(
        (el) => {
          const rect = el.getBoundingClientRect()
          return rect.height > 0 && rect.top < barRect.bottom && rect.bottom > barRect.top
        },
      )
      return {
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderTopWidth: style.borderTopWidth,
        overlayBackdrop: overlay.backdropFilter,
        overlayMask: overlay.maskImage,
        overlayBackground: overlay.backgroundImage,
        stillOwnsBottomEdge:
          document.elementFromPoint(barRect.left + barRect.width / 2, barRect.bottom - 4) === bar,
        passesUnder,
      }
    })

    assert.ok(footer, 'the settings footer must exist')
    // No opaque slab: the bar itself paints nothing, and the wash + blur ride on
    // a masked ::before so both ramp in rather than starting at a hard line.
    assert.equal(footer.background, 'rgba(0, 0, 0, 0)')
    assert.equal(footer.backgroundImage, 'none')
    assert.equal(Number.parseFloat(footer.borderTopWidth), 0)
    assert.match(footer.overlayBackdrop, /blur/)
    assert.match(footer.overlayMask, /gradient/)
    assert.match(footer.overlayBackground, /gradient/)
    assert.equal(footer.passesUnder, true, 'scrolled content passes under the footer')
    assert.equal(footer.stillOwnsBottomEdge, true, 'the bar still covers the bottom edge')

    await saveElementScreenshot('#settings-dialog', 'settings-styling-footer.png')
  })

  it('renders plugins as cards with a publisher eyebrow and a labelled toggle', async () => {
    await $('.settings-nav-btn[data-section="customise"]').click()
    await $('.plugin-row').waitForDisplayed({ timeout: 30_000 })
    // The scrollport is shared between sections, so start this one at the top.
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      if (content) content.scrollTop = 0
    })

    const plugins = await browser.execute(() => {
      const list = document.querySelector<HTMLElement>('#plugins-list')
      const row = list?.querySelector<HTMLElement>('.plugin-row')
      const name = row?.querySelector<HTMLElement>('.plugin-name')
      const eyebrow = row?.querySelector<HTMLElement>(
        '.plugin-badge-first-party, .plugin-badge-user',
      )
      const toggleControl = row?.querySelector<HTMLElement>('.plugin-toggle-control')
      const desc = row?.querySelector<HTMLElement>('.plugin-row-desc')
      const onLabel = toggleControl?.querySelector<HTMLElement>(
        '.plugin-toggle-state[data-side="on"]',
      )
      const offLabel = toggleControl?.querySelector<HTMLElement>(
        '.plugin-toggle-state[data-side="off"]',
      )
      const mark = row?.querySelector<HTMLImageElement>('.plugin-icon-copse img')
      if (!list || !row || !name || !eyebrow || !toggleControl || !onLabel || !offLabel) return null
      const rowRect = row.getBoundingClientRect()
      const nameRect = name.getBoundingClientRect()
      const eyebrowRect = eyebrow.getBoundingClientRect()
      const toggleRect = toggleControl.getBoundingClientRect()
      const checked =
        toggleControl.querySelector<HTMLInputElement>('.plugin-toggle-input')?.checked ?? false
      const liveLabel = checked ? onLabel : offLabel
      const idleLabel = checked ? offLabel : onLabel
      return {
        groupHeadings: Array.from(list.querySelectorAll<HTMLElement>('.plugins-group-heading')).map(
          (el) => el.textContent.trim(),
        ),
        cardBackground: getComputedStyle(row).backgroundColor,
        cardRadius: Number.parseFloat(getComputedStyle(row).borderTopLeftRadius),
        eyebrowAboveName: eyebrowRect.bottom <= nameRect.top + 1,
        eyebrowTransform: getComputedStyle(eyebrow).textTransform,
        nameSize: Number.parseFloat(getComputedStyle(name).fontSize),
        descSize: desc ? Number.parseFloat(getComputedStyle(desc).fontSize) : 0,
        toggleOnTheRight: toggleRect.right > rowRect.left + rowRect.width / 2,
        liveLabelWeight: Number.parseInt(getComputedStyle(liveLabel).fontWeight, 10),
        idleLabelWeight: Number.parseInt(getComputedStyle(idleLabel).fontWeight, 10),
        // A first-party plugin wears the Copse mark itself; a user-installed one
        // must not, so it falls back to an unbranded initial tile.
        markSrc: mark?.getAttribute('src') ?? null,
        markRendered: (mark?.getBoundingClientRect().width ?? 0) > 0 && mark.naturalWidth > 0,
        brandedRows: list.querySelectorAll('.plugin-icon-copse').length,
        firstPartyRows: list.querySelectorAll('.plugin-badge-first-party').length,
        // The experimental marker takes the interaction accent, in a pill, in
        // sentence case — the mockup's treatment.
        experimental: (() => {
          const badge = list.querySelector<HTMLElement>('.plugin-badge-experimental')
          if (!badge) return null
          const style = getComputedStyle(badge)
          const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent')
            .trim()
          const probe = document.createElement('span')
          probe.style.color = accent
          document.body.append(probe)
          const accentRgb = getComputedStyle(probe).color
          probe.remove()
          return {
            color: style.color,
            accentRgb,
            transform: style.textTransform,
            radius: Number.parseFloat(style.borderTopLeftRadius),
          }
        })(),
      }
    })

    assert.ok(plugins, 'the plugins list must render rows')
    assert.ok(
      plugins.groupHeadings.includes('Active'),
      `plugins are grouped by state, got ${plugins.groupHeadings.join(', ')}`,
    )
    // A plugin reads as a card: it paints its own surface and rounds its corners,
    // rather than being a hairline box on the section background.
    assert.notEqual(plugins.cardBackground, 'rgba(0, 0, 0, 0)')
    assert.ok(plugins.cardRadius >= 8, `plugin card radius ${String(plugins.cardRadius)}`)
    assert.equal(plugins.eyebrowAboveName, true, 'the publisher sits above the plugin name')
    assert.equal(plugins.eyebrowTransform, 'uppercase')
    assert.ok(plugins.nameSize > plugins.descSize, 'the plugin name leads its description')
    assert.equal(plugins.toggleOnTheRight, true, 'the toggle sits opposite the title')
    // Off/On flank the switch and the live side is the emphasised one.
    assert.ok(
      plugins.liveLabelWeight > plugins.idleLabelWeight,
      `live toggle label (${String(plugins.liveLabelWeight)}) must outweigh the idle one (${String(plugins.idleLabelWeight)})`,
    )
    // The mark is the real asset and actually decodes — a broken <img> here
    // would still measure as a laid-out box.
    assert.equal(plugins.markSrc, './brand-mark.svg')
    assert.equal(plugins.markRendered, true, 'the Copse mark must load')
    assert.equal(
      plugins.brandedRows,
      plugins.firstPartyRows,
      'the Copse mark belongs to first-party plugins and only those',
    )
    assert.ok(plugins.experimental, 'the seeded plugins include an experimental one')
    assert.equal(
      plugins.experimental.color,
      plugins.experimental.accentRgb,
      'experimental takes the interaction accent',
    )
    assert.equal(plugins.experimental.transform, 'capitalize')
    assert.ok(plugins.experimental.radius >= 12, 'the stability badge is a pill')

    await saveElementScreenshot('#settings-dialog', 'settings-styling-plugins.png')
  })

  it('folds each plugin’s settings away until asked for', async () => {
    const fold = await $('.plugin-row .plugin-settings-fold')
    await fold.waitForExist({ timeout: 10_000 })

    const closed = await browser.execute(() => {
      const details = document.querySelector<HTMLDetailsElement>(
        '.plugin-row .plugin-settings-fold',
      )
      const field = details?.querySelector<HTMLElement>('.plugin-settings, .plugin-setting-field')
      if (!details || !field) return null
      return {
        open: details.open,
        summary: details.querySelector<HTMLElement>('.plugin-settings-summary')?.textContent.trim(),
        summaryHeight:
          details.querySelector<HTMLElement>('.plugin-settings-summary')?.getBoundingClientRect()
            .height ?? 0,
        // A closed <details> lays its content out at zero size.
        fieldVisible: field.getBoundingClientRect().height > 0,
        // Our own chevron, not the UA triangle.
        marker: getComputedStyle(details.querySelector('summary') ?? details).listStyleType,
        hasChevron: details.querySelector('.plugin-settings-chevron') !== null,
      }
    })

    assert.ok(closed, 'a plugin with settings must render the fold')
    assert.equal(closed.open, false, 'plugin settings start folded away')
    assert.equal(closed.fieldVisible, false, 'the fields are not laid out while closed')
    assert.equal(closed.summary, 'Plugin settings')
    assert.ok(closed.summaryHeight >= 26, 'the summary is a row-sized target')
    assert.equal(closed.hasChevron, true)
    assert.equal(closed.marker, 'none', 'the UA disclosure triangle is replaced by our chevron')

    // Opening it reveals the fields, and the chevron turns over.
    await $('.plugin-row .plugin-settings-summary').click()
    const opened = await browser.execute(() => {
      const details = document.querySelector<HTMLDetailsElement>(
        '.plugin-row .plugin-settings-fold',
      )
      const field = details?.querySelector<HTMLElement>('.plugin-settings, .plugin-setting-field')
      const chevron = details?.querySelector<HTMLElement>('.plugin-settings-chevron')
      if (!details || !field || !chevron) return null
      return {
        open: details.open,
        fieldVisible: field.getBoundingClientRect().height > 0,
        chevronTransform: getComputedStyle(chevron).transform,
      }
    })

    assert.ok(opened, 'the fold must still be there once open')
    assert.equal(opened.open, true)
    assert.equal(opened.fieldVisible, true, 'opening the fold reveals the plugin’s fields')
    assert.notEqual(opened.chevronTransform, 'none', 'the chevron turns over when open')

    await saveElementScreenshot('#settings-dialog', 'settings-styling-plugin-settings-open.png')
  })

  it('pairs the appearance colour wells and enlarges the app-icon tiles', async () => {
    await $('.settings-nav-btn[data-section="appearance"]').click()
    await $('.settings-swatch-row').waitForDisplayed({ timeout: 10_000 })

    const appearance = await browser.execute(() => {
      const accent = document.querySelector<HTMLElement>('input[name="uiAccentColor"]')
      const tint = document.querySelector<HTMLElement>('input[name="uiTintColor"]')
      const tile = document.querySelector<HTMLElement>('.app-icon-preview img')
      if (!accent || !tint || !tile) return null
      const accentRect = accent.getBoundingClientRect()
      const tintRect = tint.getBoundingClientRect()
      return {
        sideBySide:
          Math.abs(accentRect.top - tintRect.top) <= 1 && tintRect.left > accentRect.right,
        wellWidth: accentRect.width,
        wellHeight: accentRect.height,
        tileWidth: tile.getBoundingClientRect().width,
      }
    })

    assert.ok(appearance, 'the appearance colour wells must exist')
    assert.equal(appearance.sideBySide, true, 'accent and tint read as one pair of choices')
    assert.ok(appearance.wellWidth >= 80, `colour well width ${String(appearance.wellWidth)}`)
    assert.ok(appearance.wellHeight >= 34, `colour well height ${String(appearance.wellHeight)}`)
    assert.ok(appearance.tileWidth >= 88, `app icon tile ${String(appearance.tileWidth)}`)

    await expect($('.app-icon-picker')).toBeDisplayed()
    await saveElementScreenshot('#settings-dialog', 'settings-styling-appearance.png')
  })
})
