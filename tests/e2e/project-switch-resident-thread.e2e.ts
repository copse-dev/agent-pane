import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '@shared/types'
import {
  resetUserData,
  seedStableWorkspace,
  seedE2eViewport,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

function savedThread(id: string, content: string): Thread {
  return {
    id,
    title: content,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [{ id: `${id}-message`, role: 'user', content, toolCalls: [], createdAt: 1 }],
  }
}

describe('resident conversation navigation across projects', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    resetUserData()
    const root = seedStableWorkspace()
    writeSeedConfig({
      projects: [
        { id: 'resident-a', path: root, name: 'Project A' },
        { id: 'resident-b', path: `${root}/src`, name: 'Project B' },
      ],
      activeProjectId: 'resident-a',
      activeThreadId: 'resident-thread-a',
      'threads:resident-a': [savedThread('resident-thread-a', 'Review the application navigation')],
      'threads:resident-b': [savedThread('resident-thread-b', 'Review the shared packages')],
    })
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
    await expect($('.msg-user .message-text')).toHaveText('Review the application navigation')
  })

  after(() => {
    resetUserData()
  })

  it('renders cached conversations within the click, before IPC can return', async () => {
    await $('[data-project-id="resident-b"] .project-row').click()
    await expect($('.msg-user .message-text')).toHaveText('Review the shared packages')

    // Read the DOM in the very same JS task as the click. An implementation
    // awaiting even one IPC round trip cannot satisfy this assertion.
    const visits: Array<[string, string]> = [
      ['resident-a', 'Review the application navigation'],
      ['resident-b', 'Review the shared packages'],
      ['resident-a', 'Review the application navigation'],
    ]
    for (const [id, content] of visits) {
      const rendered = await browser.execute((projectId) => {
        const row = document.querySelector<HTMLElement>(
          `[data-project-id="${projectId}"] .project-row`,
        )
        if (!row) throw new Error(`Missing project ${projectId}`)
        row.click()
        return document.querySelector('.msg-user .message-text')?.textContent
      }, id)
      assert.equal(rendered, content)
    }
    await saveAppScreenshot('project-switch-resident-thread.png')
  })
})
