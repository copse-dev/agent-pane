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
import { writeE2eEnv } from './helpers/e2e-env.ts'

function savedThread(id: string, content: string): Thread {
  return {
    id,
    title: content,
    status: 'idle',
    draftPrompt: 'Continue the review when ready',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [{ id: `${id}-message`, role: 'user', content, toolCalls: [], createdAt: 1 }],
  }
}

describe('resident conversation navigation across projects', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    writeE2eEnv({ COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    const root = seedStableWorkspace()
    writeSeedConfig({
      projects: [
        { id: 'resident-a', path: root, name: 'Project A' },
        { id: 'resident-b', path: `${root}/src`, name: 'Project B' },
      ],
      activeProjectId: 'resident-a',
      activeThreadId: 'resident-thread-a',
      'threads:resident-a': [
        {
          ...savedThread('resident-thread-a', 'Review the application navigation'),
          prRefs: [{ owner: 'copse-dev', repo: 'copse-panel', number: 42 }],
        },
      ],
      'threads:resident-b': [
        {
          ...savedThread('resident-thread-b', 'Review the shared packages'),
          prRefs: [{ owner: 'copse-dev', repo: 'copse-panel', number: 99 }],
        },
      ],
    })
    seedE2eViewport({ width: 1280, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
    await expect($('.msg-user .message-text')).toHaveText('Review the application navigation')
    await expect($('.chat-row.selected .chat-pr-status')).toHaveElementClass('is-open')
    await expect($('.chat-row.selected .chat-running-status')).not.toExist()
  })

  after(() => {
    resetUserData()
  })

  it('renders cached conversations within the click, before IPC can return', async () => {
    await $('[data-project-id="resident-b"] .project-row').click()
    await expect($('.msg-user .message-text')).toHaveText('Review the shared packages')
    await expect($('.chat-row.selected .chat-pr-status')).toHaveElementClass('is-merged')
    await expect($('.chat-row.selected .chat-running-status')).not.toExist()

    // Read the DOM in the very same JS task as the click. An implementation
    // awaiting even one IPC round trip cannot satisfy this assertion.
    const visits: Array<[string, string, string]> = [
      ['resident-a', 'Review the application navigation', 'is-open'],
      ['resident-b', 'Review the shared packages', 'is-merged'],
      ['resident-a', 'Review the application navigation', 'is-open'],
    ]
    for (const [id, content, lifecycle] of visits) {
      const rendered = await browser.execute((projectId) => {
        const row = document.querySelector<HTMLElement>(
          `[data-project-id="${projectId}"] .project-row`,
        )
        if (!row) throw new Error(`Missing project ${projectId}`)
        row.click()
        const icon = document.querySelector('.chat-row.selected .chat-pr-status')
        return {
          content: document.querySelector('.msg-user .message-text')?.textContent,
          lifecycle: icon?.classList.contains('is-merged')
            ? 'is-merged'
            : icon?.classList.contains('is-open')
              ? 'is-open'
              : null,
          working: document.querySelector('.chat-row.selected .chat-running-status') !== null,
        }
      }, id)
      assert.deepEqual(rendered, { content, lifecycle, working: false })
    }
    await saveAppScreenshot('project-switch-resident-thread.png')
  })
})
