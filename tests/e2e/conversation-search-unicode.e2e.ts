import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

async function highlightedText(name: string): Promise<string[]> {
  return browser.execute(
    (highlightName) =>
      [...(CSS.highlights.get(highlightName) ?? [])].map((range) =>
        range instanceof Range ? range.toString() : '',
      ),
    name,
  )
}

describe('conversation search Unicode offsets', () => {
  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace()
    const createdAt = Date.UTC(2026, 9, 1, 12)
    writeSeedConfig({
      projects: [{ id: 'p1', path: workspaceRoot, name: 'workspace' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      activeThreadId: 'unicode-search',
      'threads:p1': [
        {
          id: 'unicode-search',
          title: 'Unicode search',
          status: 'idle',
          messages: [
            {
              id: 'unicode-search-user',
              role: 'user',
              content: 'Check the release notes.',
              toolCalls: [],
              createdAt,
            },
            {
              id: 'unicode-search-assistant',
              role: 'assistant',
              content: 'İstanbul: **build** now.\n\nİzmir: **build** now.',
              toolCalls: [],
              createdAt: createdAt + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt,
          updatedAt: createdAt + 1,
        },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
    await $('[data-message-id="unicode-search-assistant"] .message-body').waitForDisplayed({
      timeout: 30_000,
    })
  })

  after(() => {
    resetUserData()
  })

  it('finds exact ranges across formatting and navigates repeated matches', async () => {
    await $('.prompt-input').click()
    await browser.keys([process.platform === 'darwin' ? 'Meta' : 'Control', 'f'])
    const input = $('.chat-search-input')
    await input.waitForDisplayed()
    await input.setValue('build now')
    await expect($('.chat-search-count')).toHaveText('1/2')
    expect(await highlightedText('chat-search')).toEqual(['build now', 'build now'])
    expect(await highlightedText('chat-search-current')).toEqual(['build now'])

    await browser.keys('Enter')
    await expect($('.chat-search-count')).toHaveText('2/2')
    const currentParagraph = await browser.execute(() => {
      const range = [...(CSS.highlights.get('chat-search-current') ?? [])][0]
      return range instanceof Range
        ? range.startContainer.parentElement?.closest('p')?.textContent
        : null
    })
    expect(currentParagraph).toBe('İzmir: build now.')
    await saveAppScreenshot('conversation-search-unicode.png')

    await browser.keys(['Shift', 'Enter'])
    await expect($('.chat-search-count')).toHaveText('1/2')
    await browser.keys('Escape')
    await expect(input).not.toBeDisplayed()
    expect(await highlightedText('chat-search')).toEqual([])
  })
})
