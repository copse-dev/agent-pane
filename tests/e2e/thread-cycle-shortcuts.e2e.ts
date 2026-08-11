import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-cycle-shortcuts'
const THREAD_TITLES = ['Alpha thread', 'Beta thread', 'Gamma thread']

function seedThreads(): void {
  const now = Date.now()
  const threads = THREAD_TITLES.map((title, index) => {
    const id = `thread-${String(index + 1).padStart(2, '0')}`
    return {
      id,
      title,
      status: 'idle',
      messages: [
        {
          id: `message-${id}`,
          role: 'user',
          content: title,
          toolCalls: [],
          createdAt: now - index * 1_000,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now - index * 1_000,
      updatedAt: now - index * 1_000,
    }
  })
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: process.cwd(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: 'thread-01',
    [`threads:${PROJECT_ID}`]: threads,
  })
}

async function selectedThreadTitle(): Promise<string> {
  return $('.chat-row.selected .chat-title').getText()
}

async function cycleThread(shiftKey = false): Promise<void> {
  await browser.execute((shift) => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        ctrlKey: true,
        shiftKey: shift,
        bubbles: true,
      }),
    )
  }, shiftKey)
}

async function expectSelected(title: string): Promise<void> {
  await browser.waitUntil(async () => (await selectedThreadTitle()) === title, {
    timeout: 10_000,
    timeoutMsg: `expected selected thread ${title}`,
  })
}

describe('thread-cycle shortcuts', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedThreads()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('cycles in both directions, wraps, and documents the exact chords', async () => {
    await expectSelected('Alpha thread')
    await cycleThread()
    await expectSelected('Beta thread')
    await cycleThread()
    await expectSelected('Gamma thread')
    await cycleThread()
    await expectSelected('Alpha thread')
    await cycleThread(true)
    await expectSelected('Gamma thread')

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', metaKey: true, ctrlKey: true, bubbles: true }),
      )
    })
    const dialog = await $('#keyboard-shortcuts-dialog')
    await dialog.waitForDisplayed({ timeout: 10_000 })

    const chords = await browser.execute(() => {
      const keysFor = (label: string): string[] => {
        const row = [...document.querySelectorAll('.keyboard-shortcuts-row')].find(
          (candidate) =>
            candidate.querySelector('.keyboard-shortcuts-label')?.textContent === label,
        )
        if (!row) throw new Error(`shortcut row not found: ${label}`)
        return [...row.querySelectorAll('kbd.keyboard-shortcuts-key')].map(
          (key) => key.textContent ?? '',
        )
      }
      return {
        next: keysFor('Next thread'),
        previous: keysFor('Previous thread'),
        isMac: /mac/i.test(navigator.platform || navigator.userAgent || ''),
      }
    })
    await expect(chords.next).toEqual(['Ctrl', 'Tab'])
    await expect(chords.previous).toEqual([
      'Ctrl',
      chords.isMac ? '⇧' : 'Shift',
      'Tab',
    ])
    await saveAppScreenshot('thread-cycle-shortcuts.png')
  })
})
