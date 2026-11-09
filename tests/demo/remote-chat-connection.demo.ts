import { $, browser, expect } from '@wdio/globals'
import { PNG } from 'pngjs'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'
import { expectCaptureFitsWidth } from './helpers/capture-fit.ts'

/**
 * Mobile emulation paints a transient overlay scrollbar after the viewport
 * resizes or scrolls. Wait for its idle paint in the shell's empty right
 * margin, as mobile-companion.demo.ts does, so a capture never catches it
 * mid-fade.
 */
async function waitForIdleScrollbar(): Promise<void> {
  const viewport = await browser.execute(() => {
    const context = new OffscreenCanvas(1, 1).getContext('2d')
    if (!context) throw new Error('Missing canvas context for mobile background')
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const background = Array.from(context.getImageData(0, 0, 1, 1).data)
    if (background[3] !== 255) throw new Error('Expected an opaque mobile background')
    return {
      width: window.innerWidth,
      top: Math.ceil(document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0) + 1,
      background,
    }
  })
  const [red, green, blue] = viewport.background
  await browser.waitUntil(
    async () => {
      const image = PNG.sync.read(Buffer.from(await browser.takeScreenshot(), 'base64'))
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
      return true
    },
    {
      timeout: 6_000,
      interval: 100,
      timeoutMsg: 'Mobile overlay scrollbar did not reach idle paint',
    },
  )
}

/**
 * The /mobile/ CSP blocks the screenshot helper's injected steady-caret style,
 * so a focused composer's caret blinks into some captures and not others. Set
 * the same rule through CSSOM, as mobile-companion.demo.ts does, and restart
 * the caret's paint so every capture shows it.
 */
async function steadyFocusedCaret(): Promise<void> {
  await browser.execute(async () => {
    const field = document.activeElement
    if (!(field instanceof HTMLTextAreaElement)) return
    field.style.setProperty('caret-animation', 'manual', 'important')
    if (getComputedStyle(field).getPropertyValue('caret-animation') !== 'manual') {
      throw new Error('Mobile capture requires a steady focused caret')
    }
    field.blur()
    field.focus({ preventScroll: true })
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve()
        })
      })
    })
  })
}

describe('paired remote chat connection', () => {
  it('shows live output, edits a next prompt, and preserves a draft across disconnection', async () => {
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
    await browser.refresh()
    await expect($('.row-title=Review the release')).toBeDisplayed()
    // Inject only at the network boundary. The shipped client/schema/UI remain real.
    await browser.execute(() => {
      const original = window.fetch.bind(window)
      window.fetch = async (input, init): Promise<Response> => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (path.startsWith('/api/remote/')) {
          if (document.documentElement.dataset['offline'] === 'true')
            return new Response('{"error":"Disconnected"}', { status: 503 })
          const value =
            path === '/api/remote/state'
              ? {
                  version: 1,
                  sessionId: '11111111-1111-4111-8111-111111111111',
                  revision: 2,
                  views: [
                    {
                      projectId: 'proj-1',
                      threads: [
                        {
                          id: 'thread-1',
                          title: 'Review the release',
                          status: 'idle',
                          createdAt: 1,
                          updatedAt: 2,
                          usage: { inputTokens: 0, outputTokens: 0 },
                          todos: [
                            {
                              id: 'todo-1',
                              content: 'Test the paired phone connection',
                              status: 'in_progress',
                            },
                          ],
                          messages: [
                            {
                              id: 'u',
                              role: 'user',
                              content: 'Prepare a release build.',
                              createdAt: 1,
                              toolCalls: [],
                            },
                            {
                              id: 'a',
                              role: 'assistant',
                              content: 'The release build is ready for testing.',
                              createdAt: 2,
                              toolCalls: [],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                }
              : {
                  value:
                    typeof init?.body === 'string' && init.body.includes('settings:get')
                      ? true
                      : 'Test the release build on my phone.',
                }
          return new Response(JSON.stringify(value), { status: 200 })
        }
        if (path === '/api/action') {
          const root = document.documentElement
          root.dataset['submissions'] = String(Number(root.dataset['submissions'] ?? '0') + 1)
        }
        return original(input, init)
      }
    })
    await $('.row-title=Review the release').click()
    await $('#inline-decision .open-thread-link').click()
    await expect($('#messages')).toHaveText(
      expect.stringContaining('The release build is ready for testing.'),
    )
    await expect($('#next-prompt')).toBeDisplayed()
    await expect($('#remote-connection')).toHaveText('● Connected')
    await $('#plan-tab').click()
    await expect($('#remote-todos')).toHaveText(
      expect.stringContaining('Test the paired phone connection'),
    )
    await $('#mac-tab').click()
    await expect($('#remote-tools')).toHaveText('No tool activity in this chat yet.')
    await $('#chat-tab').click()
    await expect($('#composer')).toBeDisplayed()
    // Nothing may run off a phone from a small Android (350) to a large iPhone (390).
    for (const width of [350, 375, 390]) {
      await browser.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      })
      await expectCaptureFitsWidth('.shell')
    }
    // Frame the page column, not #thread: the shell holds the phone's side gutters.
    await saveElementScreenshot('.shell', 'remote-chat-connected-phone.png', {
      frame: 'document',
      beforeCapture: async () => {
        // The width sweep above resizes the viewport, which flashes the scrollbar.
        await waitForIdleScrollbar()
        await expectCaptureFitsWidth('.shell')
      },
    })
    await $('#next-prompt').click()
    await expect($('#message')).toHaveValue('Test the release build on my phone.')
    await $('#message').setValue('Test the release build on my phone, including reconnect.')
    await browser.execute(() => {
      document.documentElement.dataset['offline'] = 'true'
    })
    await expect($('#thread-status')).toHaveText(expect.stringContaining('Retrying'))
    await expect($('#message')).toHaveValue(
      'Test the release build on my phone, including reconnect.',
    )
    await browser.execute(() => {
      document.documentElement.dataset['offline'] = 'false'
    })
    await expect($('#thread-status')).toHaveText('Connected to your Mac.')
    await browser.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    })
    // Reconnecting repaints the live reply at the desktop's streaming pace.
    await expect($('#messages')).toHaveText(
      expect.stringContaining('The release build is ready for testing.'),
    )
    await saveElementScreenshot('.shell', 'remote-chat-reconnected-phone-dark.png', {
      frame: 'document',
      beforeCapture: async () => {
        await steadyFocusedCaret()
        await waitForIdleScrollbar()
        await expectCaptureFitsWidth('.shell')
      },
    })
    await $('#send').click()
    await expect($('#message')).toHaveValue('')
    await expect($('#next-prompt')).not.toBeDisplayed()
    await expect(browser).toHaveUrl(expect.stringContaining('/mobile/'))
    expect(await browser.execute(() => document.documentElement.dataset['submissions'])).toBe('1')
  })
})
