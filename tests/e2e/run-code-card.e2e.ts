import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedStableWorkspace, writeSeedConfig } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

/**
 * A finished `run_code` call (experimental code mode) as the transcript shows
 * it: the cell that counted TODOs through read-only tools, and what it printed
 * and returned. Seeded, so no container engine is needed to render it.
 */
const PROJECT_ID = 'e2e-run-code-project'
const THREAD_ID = 'e2e-run-code-thread'
const CALL_ID = 'tc-run-code'

const CELL = [
  "const paths = (await tools.find_files({ pattern: 'src/**/*.ts' })).split('\\n')",
  'const todos: Record<string, number> = {}',
  'for (const path of paths) {',
  '  const text = await tools.read_file({ path })',
  "  const count = text.split('\\n').filter((line) => line.includes('TODO')).length",
  '  if (count > 0) todos[path] = count',
  '}',
  'console.log(`checked ${paths.length} files`)',
  'state.todos = todos',
  'return todos',
].join('\n')

const RESULT = [
  'Console:',
  'checked 3 files',
  '',
  'Returned:',
  '{',
  '  "src/a.ts": 1,',
  '  "src/c.ts": 2',
  '}',
  '',
  '(4 tool calls)',
].join('\n')

function seedRunCodeFixture(): void {
  const now = Date.now()
  writeSeedConfig({
    projects: [{ id: PROJECT_ID, path: seedStableWorkspace(), name: 'workspace' }],
    activeProjectId: PROJECT_ID,
    expandedProjectId: PROJECT_ID,
    activeThreadId: THREAD_ID,
    [`threads:${PROJECT_ID}`]: [
      {
        id: THREAD_ID,
        title: 'Count TODOs with a code cell',
        status: 'idle',
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [
          {
            id: 'msg-user-run-code',
            role: 'user',
            content: 'How many TODOs are left under src, per file?',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-run-code',
            role: 'assistant',
            content: 'Three TODOs remain: one in `src/a.ts` and two in `src/c.ts`.',
            toolCalls: [
              {
                id: CALL_ID,
                name: 'run_code',
                args: { code: CELL, timeout_seconds: 30 },
                status: 'done',
                result: RESULT,
              },
            ],
            createdAt: now + 1,
          },
        ],
        createdAt: now,
        updatedAt: now + 1,
      },
    ],
  })
}

describe('run_code tool card', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    seedRunCodeFixture()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it("shows the cell's code and what it printed and returned", async () => {
    const selector = `.tool-card[data-tool-id="${CALL_ID}"]`
    const card = $(selector)
    await card.waitForExist({ timeout: 30_000 })
    await expect(card.$('.tool-name')).toHaveText('Ran code')
    await card.scrollIntoView()
    if ((await card.getAttribute('open')) === null) await card.$('summary.tool-card-header').click()
    const args = card.$('details.tool-args')
    await args.waitForExist({ timeout: 10_000 })
    if ((await args.getAttribute('open')) === null) await args.$('summary').click()
    await expect(args).toHaveText(expect.stringContaining('await tools.read_file({ path })'))
    const result = card.$('.tool-result')
    await expect(result).toBeDisplayed()
    await expect(result).toHaveText(expect.stringContaining('checked 3 files'))
    await expect(result).toHaveText(expect.stringContaining('"src/c.ts": 2'))
    await expect(result).toHaveText(expect.stringContaining('(4 tool calls)'))
    await saveElementScreenshot(selector, 'run-code-card.png')
  })
})
