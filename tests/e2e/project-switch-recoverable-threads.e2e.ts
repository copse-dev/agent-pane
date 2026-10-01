import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { openProjectManager } from './helpers/project-manager.ts'
import type { Thread } from '@shared/types'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'

describe('project switch with recoverable threads', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    const now = Date.now()
    const savedThread = (id: string, title: string): Thread => ({
      id,
      title,
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      updatedAt: now,
    })
    writeSeedConfig({
      projects: [
        { id: 'workspace', path: process.cwd(), name: 'Workspace' },
        { id: 'skills', path: `${process.cwd()}/packages`, name: 'Skills' },
      ],
      activeProjectId: 'workspace',
      expandedProjectId: 'workspace',
      'threads:workspace': [savedThread('workspace-thread', 'Workspace notes')],
      'threads:skills': [savedThread('skills-thread', 'Skills notes')],
      'threads:orphan-store': [savedThread('orphan-thread', 'Recoverable notes')],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows each project thread and keeps recoverable stores visible through switches', async () => {
    await openProjectManager()
    await expect($('.thread-project-manager [data-project-id="workspace"] .chat-title')).toHaveText(
      'Workspace notes',
    )
    await expect($('.orphan-name')).toHaveText('Recoverable notes')

    await $('.thread-project-manager [data-project-id="skills"] .project-row').click()
    await expect($('.thread-project-manager [data-project-id="skills"] .chat-title')).toHaveText(
      'Skills notes',
    )
    await expect($('.orphan-name')).toHaveText('Recoverable notes')
    assert.match(
      (await $('.thread-project-manager [data-project-id="skills"] .project-row').getAttribute(
        'class',
      )) ?? '',
      /\bactive\b/,
    )
    await saveElementScreenshot('#pane-projects', 'project-switch-recoverable-threads.png')

    await $('.thread-project-manager [data-project-id="workspace"] .project-row').click()
    await expect($('.thread-project-manager [data-project-id="workspace"] .chat-title')).toHaveText(
      'Workspace notes',
    )
    await expect($('.orphan-name')).toHaveText('Recoverable notes')
  })
})
