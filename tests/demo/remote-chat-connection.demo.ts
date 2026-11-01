import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

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
    await saveElementScreenshot('#thread', 'remote-chat-connected-phone.png', { frame: 'document' })
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
    await saveElementScreenshot('#thread', 'remote-chat-reconnected-phone-dark.png', {
      frame: 'document',
    })
    await $('#send').click()
    await expect($('#message')).toHaveValue('')
    await expect($('#next-prompt')).not.toBeDisplayed()
    await expect(browser).toHaveUrl(expect.stringContaining('/mobile/'))
    expect(await browser.execute(() => document.documentElement.dataset['submissions'])).toBe('1')
  })
})
