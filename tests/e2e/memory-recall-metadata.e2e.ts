import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { recallTool } from '../../src/main/tools/memory-tools.ts'
import {
  knowledgeDir,
  setKnowledgeRootForTest,
} from '../../src/main/services/storage/knowledge-store.ts'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

describe('memory recall metadata', () => {
  let result: string

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const root = mkdtempSync(join(tmpdir(), 'copse-memory-visual-'))
    setKnowledgeRootForTest(root)
    try {
      // Ordinary persisted OKF notes are the supported store-reader boundary.
      // Fixed ids/dates keep the actual tool result deterministic across hosts.
      const dir = join(knowledgeDir(), 'memory')
      mkdirSync(dir, { recursive: true })
      for (const [id, title, fields] of [
        [
          'memory-build',
          'Build verification',
          'revision: 3\nmemorySchema: 2\nsources: ["msg:review", "https://example.com/a,b"]\nappliesTo: ["src/{a,b}/**"]',
        ],
        ['memory-legacy', 'Legacy guidance', ''],
      ]) {
        writeFileSync(
          join(dir, `${id}.md`),
          [
            '---',
            'type: Memory',
            `id: ${id}`,
            `title: ${title}`,
            'tags: []',
            'createdAt: 2026-10-03T00:00:00.000Z',
            'updatedAt: 2026-10-03T00:00:00.000Z',
            fields,
            '---',
            '',
            'Run the focused tests before publishing.',
          ].join('\n'),
        )
      }
      const output = await recallTool.execute(
        recallTool.parameters.parse({ limit: 1 }),
        new AbortController().signal,
      )
      assert.equal(typeof output, 'string')
      if (typeof output !== 'string') throw new Error('Expected textual memory recall')
      result = output
      assert.match(result, /revision: 3/)
      assert.match(result, /sources \(supplied by the saving agent, not verified\)/)
      assert.match(result, /https:\/\/example.com\/a,b/)
      assert.match(result, /applies to: src\/\{a,b\}\/\*\*/)
      assert.match(result, /Next cursor: m:1/)
    } finally {
      setKnowledgeRootForTest(null)
      rmSync(root, { recursive: true, force: true })
    }
    resetUserData()
    const projectId = 'memory-visual-project'
    const now = Date.UTC(2026, 9, 3)
    writeSeedConfig({
      projects: [{ id: projectId, path: process.cwd(), name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: 'memory-visual-thread',
      [`threads:${projectId}`]: [
        {
          id: 'memory-visual-thread',
          title: 'Review saved guidance',
          status: 'idle',
          createdAt: now,
          updatedAt: now + 1,
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [
            {
              id: 'memory-request',
              role: 'user',
              content: 'Recall the saved build guidance.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'memory-response',
              role: 'assistant',
              content: '',
              createdAt: now + 1,
              toolCalls: [
                { id: 'memory-recall', name: 'recall', args: { limit: 1 }, status: 'done', result },
              ],
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => resetUserData())

  it('shows revision, unverified sources, applicability and paging in the native tool card', async () => {
    const card = $('.tool-card[data-tool-id="memory-recall"]')
    await card.waitForExist({ timeout: 30_000 })
    await card.$('summary.tool-card-header').click()
    await expect(card).toHaveAttribute('open')
    await expect(card.$('.tool-result')).toHaveText(result)
    await expect(card.$('.tool-result')).toBeDisplayed()
    await expect(card.$$('.tool-result img')).toBeElementsArrayOfSize(0)
    await card.scrollIntoView()
    await saveAppScreenshot('memory-recall-metadata.png')
  })
})
