import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import { E2E_SCREENSHOT_DIR } from '../e2e/helpers/screenshot.ts'
import { withFrozenAnimations } from '../e2e/helpers/frozen-animations.ts'

async function screenshot(name: string): Promise<void> {
  expect(
    await browser.execute(() => document.documentElement.scrollWidth > window.innerWidth),
  ).toBe(false)
  await browser.execute(async () => {
    await document.fonts.ready
  })
  const caret = await browser.execute(() => {
    const field = document.activeElement
    if (!(field instanceof HTMLTextAreaElement)) return null
    const previous = {
      id: field.id,
      value: field.style.getPropertyValue('caret-animation'),
      priority: field.style.getPropertyPriority('caret-animation'),
    }
    // Mobile CSP blocks injected style elements. CSSOM applies the same visible
    // steady-caret rule without weakening that policy or hiding the caret.
    field.style.setProperty('caret-animation', 'manual', 'important')
    return previous
  })
  try {
    await withFrozenAnimations(async () => {
      await browser.execute(async () => {
        const focused = document.activeElement
        if (focused instanceof HTMLTextAreaElement) {
          if (getComputedStyle(focused).getPropertyValue('caret-animation') !== 'manual') {
            throw new Error('Mobile capture requires a steady focused caret')
          }
          // Restart native caret paint after the steady-caret rule takes effect,
          // rather than freezing whichever blink phase preceded capture.
          focused.blur()
          focused.focus({ preventScroll: true })
        }
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
      })
      // Mobile emulation paints a transient native scrollbar after taps and
      // focus-driven scrolling. It is not a DOM animation. Wait for its real
      // idle paint in the shell's empty right margin, rather than hiding it or
      // accepting whichever fade opacity a worker happened to capture.
      const viewport = await browser.execute(() => {
        const context = new OffscreenCanvas(1, 1).getContext('2d')
        if (!context) throw new Error('Missing canvas context for mobile background')
        context.fillStyle = getComputedStyle(document.body).backgroundColor
        context.fillRect(0, 0, 1, 1)
        const background = Array.from(context.getImageData(0, 0, 1, 1).data)
        if (background[3] !== 255) throw new Error('Expected an opaque mobile background')
        return {
          width: window.innerWidth,
          top:
            Math.ceil(document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 1,
          background,
        }
      })
      const [red, green, blue] = viewport.background
      let idleCapture: Buffer | undefined
      await browser.waitUntil(
        async () => {
          const capture = Buffer.from(await browser.takeScreenshot(), 'base64')
          const image = PNG.sync.read(capture)
          const scale = image.width / viewport.width
          for (let y = Math.ceil(viewport.top * scale); y < image.height; y++) {
            for (let x = Math.floor((viewport.width - 4) * scale); x < image.width; x++) {
              const offset = (y * image.width + x) * 4
              if (
                image.data[offset] !== red ||
                image.data[offset + 1] !== green ||
                image.data[offset + 2] !== blue
              )
                return false
            }
          }
          idleCapture = capture
          return true
        },
        {
          timeout: 6_000,
          interval: 100,
          timeoutMsg: 'Mobile overlay scrollbar did not reach idle paint',
        },
      )
      // Save the frame whose native paint passed the check. A second capture can
      // repaint the overlay between the readiness probe and the saved evidence.
      assert.ok(idleCapture, 'Expected a verified idle mobile screenshot')
      await writeFile(join(E2E_SCREENSHOT_DIR, name), idleCapture)
    })
  } finally {
    await browser.execute((previous) => {
      if (!previous) return
      const field = document.getElementById(previous.id)
      if (!field) throw new Error('Captured mobile composer disappeared')
      if (previous.value) {
        field.style.setProperty('caret-animation', previous.value, previous.priority)
      } else {
        field.style.removeProperty('caret-animation')
      }
    }, caret)
  }
}

async function expectComposerVisible(id: 'message' | 'new-message'): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((inputId) => {
        const input = document.getElementById(inputId)
        const button = input?.closest('form')?.querySelector('button[type="submit"]')
        const header = document.querySelector('.topbar')
        if (!input || !button || !header || document.activeElement !== input) return false
        const top = window.visualViewport?.offsetTop ?? 0
        const bottom = top + (window.visualViewport?.height ?? window.innerHeight)
        const headerRect = header.getBoundingClientRect()
        return (
          headerRect.top >= top - 1 &&
          headerRect.bottom <= bottom &&
          input.getBoundingClientRect().top >= headerRect.bottom &&
          button.getBoundingClientRect().bottom <= bottom
        )
      }, id),
    { timeoutMsg: 'Focused composer, submission button, and header must fit in the viewport' },
  )
}

describe('Mobile Companion at phone width', () => {
  beforeEach(async () => {
    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
  })

  it('shows Activity before dirty checks complete and regroups on the next poll', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.url('/mobile/')
    await browser.execute(async () => {
      await fetch('/mobile-fixture/reset')
      localStorage.setItem('copse-mobile-token', 'visual-test-token')
      history.replaceState({ mobileView: 'activity' }, '')
    })
    // Model cold and completed cache responses at the API boundary. Unit tests
    // hold the actual background inspector to prove that reads never await it.
    const { identifier } = await browser.sendCommandAndGetResult(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          const originalFetch = window.fetch.bind(window)
          window.fetch = async (...args) => {
            const response = await originalFetch(...args)
            if (args[0] !== '/api/activity') return response
            const data = await response.json()
            data.rows = data.rows.filter(row => ['thread-1', 'thread-4'].includes(row.threadId))
            const ready = document.documentElement.dataset.dirtyCheckComplete === 'true'
            for (const row of data.rows) {
              if (row.threadId === 'thread-4') row.group = ready ? 'has-changes' : 'recent'
            }
            return new Response(JSON.stringify(data), {
              status: response.status, headers: response.headers,
            })
          }
        `,
      },
    )
    try {
      await browser.refresh()
      await expect($('.row-title=Polish the onboarding copy')).toBeDisplayed()
      const row = await $('.row-title=Polish the onboarding copy').parentElement()
      await expect(row.parentElement().$('.group-heading span')).toHaveText('RECENT')
      await expect($('.state.needs-approval')).toBeDisplayed()
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await screenshot('mobile-companion-activity-cold-cache.png')
      await browser.execute(() => {
        document.documentElement.dataset.dirtyCheckComplete = 'true'
      })
      await browser.waitUntil(
        async () => {
          const updatedRow = await $('.row-title=Polish the onboarding copy').parentElement()
          return (
            (await updatedRow.parentElement().$('.group-heading span').getText()) === 'HAS CHANGES'
          )
        },
        { timeoutMsg: 'The next Activity poll should show completed dirty status' },
      )
      await expect($('.state.needs-approval')).toBeDisplayed()
      await screenshot('mobile-companion-activity-dirty-refreshed.png')
    } finally {
      await browser.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
      await browser.refresh()
    }
  })

  it('previews, removes and sends an image from the phone composer', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.url('/mobile/')
    await browser.execute(async () => {
      await fetch('/mobile-fixture/reset')
      localStorage.setItem('copse-mobile-token', 'visual-test-token')
    })
    await browser.refresh()
    await expect($('.group .row')).toBeDisplayed()
    await browser.execute(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        if (
          input === '/api/action' &&
          typeof init?.body === 'string' &&
          init.body.includes('"image":"data:image/png;base64,')
        ) {
          const root = document.documentElement
          root.dataset.mobileImageActions = String(Number(root.dataset.mobileImageActions || 0) + 1)
        }
        return originalFetch(input, init)
      }
    })
    const directory = await mkdtemp(join(tmpdir(), 'copse-mobile-image-'))
    const file = join(directory, 'photo.png')
    const png = new PNG({ width: 16, height: 16 })
    png.data.fill(180)
    await writeFile(file, PNG.sync.write(png))
    try {
      await $('#new-chat').click()
      assert.equal(await $('#new-chat-form .image-picker').getAttribute('aria-label'), 'Add image')
      assert.equal(await $('#new-chat-form .image-picker').getText(), '')
      await $('#new-image').setValue(file)
      await expect($('#new-image-preview')).toBeDisplayed()
      assert.equal(
        await $('#new-image-preview .image-remove').getAttribute('aria-label'),
        'Remove image',
      )
      await $('#new-message').click()
      await expectComposerVisible('new-message')
      await screenshot('mobile-companion-new-chat-image-preview.png')
      await $('#new-image-preview button').click()
      await expect($('#new-image-preview')).not.toBeDisplayed()
      await $('#new-chat-form').$('button[type="submit"]').click()
      await expect($('#new-chat-form')).toBeDisplayed()
      await $('#new-image').setValue(file)
      await $('#new-chat-form').$('button[type="submit"]').click()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#action-status')).toHaveText(expect.stringContaining('Chat started'))
      await expect($('#composer')).toBeDisplayed()
      await $('#message-image').setValue(file)
      await expect($('#message-image-preview img')).toBeDisplayed()
      assert.equal(
        await browser.execute(() => {
          const image = document
            .querySelector('#message-image-preview img')
            ?.getBoundingClientRect()
          const remove = document
            .querySelector('#message-image-preview .image-remove')
            ?.getBoundingClientRect()
          const glyph = document
            .querySelector('#message-image-preview .image-remove-glyph')
            ?.getBoundingClientRect()
          const card = document.querySelector('#composer .message-compose')?.getBoundingClientRect()
          const picker = document.querySelector('#composer .image-picker')?.getBoundingClientRect()
          const send = document.querySelector('#send')?.getBoundingClientRect()
          return (
            !!image &&
            !!remove &&
            !!glyph &&
            !!card &&
            !!picker &&
            !!send &&
            image.left >= card.left &&
            image.right <= card.right &&
            picker.left >= card.left &&
            send.right <= card.right &&
            remove.width >= 44 &&
            remove.height >= 44 &&
            glyph.width <= 20 &&
            glyph.height <= 20 &&
            glyph.left >= image.left &&
            glyph.top >= image.top + 4 &&
            glyph.right >= image.right + 9 &&
            glyph.right <= image.right + 11 &&
            glyph.bottom <= image.bottom &&
            remove.left < image.right &&
            remove.top < image.bottom &&
            remove.right > image.left &&
            remove.bottom > image.top
          )
        }),
        true,
      )
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await screenshot('mobile-companion-image-preview.png')
      await $('#message').setValue('What is in this image?')
      await $('#send').click()
      await expect($('#message-image-preview')).not.toBeDisplayed()
      await expect($('#action-status')).toHaveText(expect.stringContaining('Message queued'))
      assert.equal(await $('html').getAttribute('data-mobile-image-actions'), '2')
      await $('#messages .message:last-child').scrollIntoView()
      await expect($('#messages .message:last-child .message-image')).toBeDisplayed()
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const image = document.querySelector('#messages .message:last-child .message-image')
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          }),
        { timeoutMsg: 'Assistant image response should load on the phone' },
      )
      await $('#message').click()
      await expectComposerVisible('message')
      await screenshot('mobile-companion-image-response.png')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps desktop-only prompts readable inline with a route to the full thread', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    })
    await browser.url('/mobile/')
    await browser.execute(async () => {
      await fetch('/mobile-fixture/reset')
      localStorage.setItem('copse-mobile-token', 'visual-test-token')
      history.replaceState({ mobileView: 'activity' }, '')
    })
    await browser.refresh()
    await expect($('.state.needs-approval')).toBeDisplayed()
    // External agents can expose attention without a mobile decision transport.
    // Model that API response at the browser boundary, using the real app bundle.
    await browser.execute(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await originalFetch(...args)
        if (args[0] !== '/api/thread/proj-1/thread-1') return response
        const data: unknown = await response.json()
        if (!data || typeof data !== 'object') throw new Error('Missing thread fixture')
        return new Response(
          JSON.stringify({
            ...data,
            decisions: [],
            attention: [
              {
                title: 'Confirm on the desktop',
                body: 'This coding agent needs a desktop confirmation before continuing.',
              },
            ],
          }),
          { status: response.status, headers: response.headers },
        )
      }
    })
    try {
      await $('.group .row').click()
      await expect($('#inline-decision .attention-title')).toHaveText('Confirm on the desktop')
      await expect($('#inline-decision .hint')).toHaveText('Answer this prompt on the desktop.')
      await expect($('#inline-decision .decision-actions')).not.toExist()
      await expect($('#inline-decision .open-thread-link')).toBeDisplayed()
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await screenshot('mobile-companion-desktop-prompt.png')
      await $('#inline-decision .open-thread-link').click()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#attention .attention-title')).toHaveText('Confirm on the desktop')
    } finally {
      await browser.refresh()
    }
  })

  it('refreshes a settled inline decision row without waiting for polling', async () => {
    await browser.url('/mobile/')
    await browser.execute(async () => {
      await fetch('/mobile-fixture/reset')
      localStorage.setItem('copse-mobile-token', 'visual-test-token')
      history.replaceState({ mobileView: 'activity' }, '')
    })
    // Freeze recurring timers at the browser boundary: settlement must update
    // Activity through its own refresh, rather than the periodic poll.
    const { identifier } = await browser.sendCommandAndGetResult(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: 'window.setInterval = () => 0',
      },
    )
    try {
      await browser.setWindowSize(390, 844)
      await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      })
      await browser.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      })
      await browser.refresh()
      await expect($('.state.needs-approval')).toBeDisplayed()
      await $('.group .row').click()
      await $('#inline-decision .decision-actions .ui-btn-primary').click()
      await expect($('#inline-decision label')).toHaveText('Which tests should I run?')
      await $('#inline-decision .answer').setValue('Focused tests')
      await $('#inline-decision .attention > .ui-btn-primary').click()
      await expect($('#inline-decision')).not.toBeDisplayed()
      await expect($('.state.needs-approval')).not.toExist()
      await expect($('.state.needs-answer')).not.toExist()
      await expect($('#activity')).toBeDisplayed()
      const releaseRow = await $('.row-title=Review the release').parentElement()
      await expect(releaseRow.$('.state')).toHaveText('working')
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await screenshot('mobile-companion-activity-settled.png')
    } finally {
      await browser.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
      await browser.refresh()
    }
  })

  it('uses desktop foundations for readable pairing, activity, and output in both themes', async () => {
    await browser.setWindowSize(390, 844)
    await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await browser.url('/mobile/')
    expect(await browser.execute(() => window.innerWidth)).toBe(390)

    for (const theme of ['dark', 'light']) {
      // Exercise a live OS-theme change as well as the fresh page's startup.
      await browser.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      })
      await expect($('html')).toHaveAttribute('data-theme', theme)
      await browser.execute(async () => {
        await fetch('/mobile-fixture/reset')
        localStorage.removeItem('copse-mobile-token')
        history.replaceState({ mobileView: 'activity' }, '')
      })
      await browser.refresh()
      await expect($('html')).toHaveAttribute('data-theme', theme)
      await expect($('#pair h1')).toHaveText('See what needs you.')

      const appearance = await browser.execute(async () => {
        await document.fonts.ready
        const button = document.querySelector('#pair-button')
        const heading = document.querySelector('#pair h1')
        const mark = document.querySelector('.brand-mark')
        if (!button || !heading || !mark) throw new Error('Missing mobile pairing content')
        const style = getComputedStyle(button)
        const channels = (value: string): number[] => value.match(/[\d.]+/g)?.map(Number) ?? []
        const luminance = (value: string): number => {
          const rgb = channels(value)
            .slice(0, 3)
            .map((channel) => {
              const scaled = value.startsWith('color(') ? channel : channel / 255
              return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
            })
          return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
        }
        const background = luminance(style.backgroundColor)
        const foreground = luminance(style.color)
        return {
          font: getComputedStyle(document.body).fontFamily,
          headingFont: getComputedStyle(heading).fontFamily,
          headingWeight: getComputedStyle(heading).fontWeight,
          loadedFonts: [...document.fonts]
            .filter((face) => face.status === 'loaded')
            .map((face) => face.family.replaceAll('"', '')),
          fill: style.backgroundColor,
          label: style.color,
          height: button.getBoundingClientRect().height,
          contrast:
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
          surfaceLuminance: luminance(getComputedStyle(document.body).backgroundColor),
          brand: getComputedStyle(mark).backgroundImage.startsWith('url("data:image/svg+xml'),
          chromeMatches:
            document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ===
            getComputedStyle(document.body).backgroundColor,
        }
      })
      expect(appearance.font).toContain('Pliant')
      expect(appearance.headingFont).toContain('Averia Serif Libre')
      expect(appearance.headingWeight).toBe('400')
      expect(appearance.loadedFonts).toContain('Pliant')
      expect(appearance.loadedFonts).toContain('Averia Serif Libre')
      expect(appearance.fill).toBe('rgb(255, 147, 208)')
      expect(appearance.label).toBe('rgb(68, 68, 68)')
      assert.ok(
        appearance.contrast >= 4.5,
        `${theme} primary label contrast: ${appearance.contrast}`,
      )
      assert.ok(appearance.height >= 44, 'Pairing must remain a phone-sized touch target')
      expect(appearance.surfaceLuminance > 0.5).toBe(theme === 'light')
      expect(appearance.brand).toBe(true)
      expect(appearance.chromeMatches).toBe(true)
      await screenshot(`mobile-companion-pair-${theme}.png`)

      await browser.execute(() => localStorage.setItem('copse-mobile-token', 'visual-test-token'))
      await browser.refresh()
      await expect($('.group .row')).toBeDisplayed()
      await browser.execute(async () => {
        await document.fonts.ready
      })
      await expect($('#groups')).toHaveText(expect.stringContaining('NEEDS YOU'))
      await expect($('#groups')).toHaveText(expect.stringContaining('WORKING'))
      await expect($('#groups')).toHaveText(expect.stringContaining('HAS CHANGES'))
      await expect($('#groups')).toHaveText(expect.stringContaining('RECENT'))
      await expect($('.state.needs-approval')).toHaveText('needs approval')
      await expect($('.state.finished')).toHaveText('finished')
      await expect($('#groups')).toHaveText(expect.stringContaining('Polish the onboarding copy'))
      await screenshot(`mobile-companion-activity-${theme}.png`)

      // A needs-you row answers in place: tapping it selects the row and
      // renders the decision inline, without navigating to the thread.
      await $('.group .row').click()
      await expect($('.group .row.selected')).toBeDisplayed()
      await expect($('#inline-decision .attention-body')).toHaveText('pnpm run check')
      await expect($('#activity')).toBeDisplayed()
      await screenshot(`mobile-companion-activity-decision-${theme}.png`)
      await $('#inline-decision .decision-actions .ui-btn-primary').click()
      await expect($('#inline-decision label')).toHaveText('Which tests should I run?')
      await expect($('#activity')).toBeDisplayed()

      // The full thread stays one tap away for anyone who wants more context.
      await $('#inline-decision .open-thread-link').click()
      await expect($('#thread-title')).toHaveText('Review the release')
      await expect($('#messages')).toHaveText(
        expect.stringContaining('</p><img src=x onerror=alert(1)>'),
      )
      expect(await browser.execute(() => document.querySelectorAll('#messages img').length)).toBe(0)
      await expect($('#messages .message:nth-child(2) .message-summary')).toHaveText(
        'Read RELEASE_NOTES.md',
      )
      await expect($('#messages .message:nth-child(2) .message-content')).not.toExist()
      await expect($('#messages')).not.toHaveText(expect.stringContaining('Tool activity'))
      await expect($('#messages')).not.toHaveText(expect.stringContaining('No saved text'))
      await expect($('.topbar #back svg')).toExist()
      await browser.waitUntil(
        () =>
          browser.execute(() => {
            const messages = document.getElementById('messages')
            const attention = document.getElementById('attention')
            const action = attention?.querySelector('.ui-btn-primary')
            if (!messages || !attention || !action) return false
            const bounds = action.getBoundingClientRect()
            return (
              attention.getBoundingClientRect().top >= messages.getBoundingClientRect().bottom &&
              bounds.top >= 0 &&
              bounds.bottom <= window.innerHeight
            )
          }),
        { timeoutMsg: 'New approval must appear below rendered messages with its action in view' },
      )
      await screenshot(`mobile-companion-approval-${theme}.png`)
      // The new approval receives the viewport first; explicitly return to composing.
      await $('#message').click()
      await expectComposerVisible('message')
      await screenshot(`mobile-companion-thread-${theme}.png`)
      await expect($('#composer')).toBeDisplayed()
      await expect($('#stop')).toBeDisplayed()
      await expect($('.attention label')).toHaveText('Which tests should I run?')
      await $('.answer').setValue('Keep this draft during polling')
      await browser.waitUntil(async () => {
        const count = await browser.execute(
          () =>
            performance
              .getEntriesByType('resource')
              .filter((entry) => entry.name.includes('/api/thread/')).length,
        )
        return count >= 3
      })
      await expect($('.answer')).toHaveValue('Keep this draft during polling')
      await screenshot(`mobile-companion-question-${theme}.png`)
      await $('.answer-options .ui-btn').click()
      await expect($('.answer')).toHaveValue('Focused tests')
      await $('.attention > .ui-btn-primary').click()
      await expect($('.attention')).not.toExist()
      await $('#message').setValue('Please run those **tests** and report back.')
      await expectComposerVisible('message')
      await screenshot(`mobile-companion-compose-${theme}.png`)
      await $('#send').click()
      await expect($('#message')).toHaveValue('')
      await expectComposerVisible('message')
      await expect($('#messages')).toHaveText(
        expect.stringContaining('Please run those tests and report back.'),
      )
      await expect($('#messages .message-content strong')).toHaveText('tests')
      await $('#stop').click()
      await expect($('#stop')).not.toBeDisplayed()
      await expect($('#send')).toHaveText('Send')
      await $('#message').setValue('Keep this draft through history')
      const historyLength = await browser.execute(() => history.length)
      await browser.back()
      await expect($('#activity')).toBeDisplayed()
      await expect($('#back')).not.toBeDisplayed()
      await browser.forward()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#message')).toHaveValue('Keep this draft through history')
      await expectComposerVisible('message')
      expect(await browser.execute(() => history.length)).toBe(historyLength)
      await $('#back').click()
      await expect($('#activity')).toBeDisplayed()
      await $('#new-chat').click()
      await expectComposerVisible('new-message')
      await $('#new-message').setValue('Start a fresh release review.')
      await screenshot(`mobile-companion-new-chat-${theme}.png`)
      await $('#new-chat-form button[type="submit"]').click()
      await expect($('#thread')).toBeDisplayed()
      await expect($('#messages')).toHaveText(
        expect.stringContaining('Start a fresh release review.'),
      )
    }
  })
})
