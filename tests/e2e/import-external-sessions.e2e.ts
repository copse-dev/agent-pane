import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-import-sessions'
const PROJECT_MENU = `.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`
/** Fixed so the list's dates read the same on every run. */
const CLAUDE_SESSION_TIME = new Date('2026-11-03T15:30:00.000Z')
const CODEX_SESSION_TIME = new Date('2026-11-02T09:10:00.000Z')

function writeJsonl(path: string, lines: unknown[], time: Date): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  utimesSync(path, time, time)
}

/** One saved Claude Code session and one Codex session that ran in `root`. */
function seedSessions(fixtures: string, root: string): void {
  const claudeLine = (extra: Record<string, unknown>): Record<string, unknown> => ({
    sessionId: 'e2e-claude-session',
    cwd: root,
    gitBranch: 'main',
    isSidechain: false,
    timestamp: '2026-11-03T15:00:00.000Z',
    ...extra,
  })
  writeJsonl(
    join(
      fixtures,
      'claude',
      'projects',
      root.replace(/[^a-zA-Z0-9]/g, '-'),
      'e2e-claude-session.jsonl',
    ),
    [
      claudeLine({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'Why does the README build badge show failing?' },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look at the README first.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: `${root}/README.md` },
            },
          ],
        },
      }),
      claudeLine({
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '# Workspace\n\nA small fixed project for Copse end-to-end specs.',
            },
          ],
        },
      }),
      claudeLine({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'r1',
        message: {
          id: 'msg_2',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The README has no build badge. The failing badge must come from another page.',
            },
          ],
        },
      }),
    ],
    CLAUDE_SESSION_TIME,
  )
  const codexLine = (type: string, payload: unknown): unknown => ({
    timestamp: '2026-11-02T09:00:00.000Z',
    type,
    payload,
  })
  writeJsonl(
    join(
      fixtures,
      'codex',
      'sessions',
      '2026',
      '11',
      '02',
      'rollout-2026-11-02T09-00-00-e2e.jsonl',
    ),
    [
      codexLine('session_meta', {
        id: 'e2e-codex-session',
        timestamp: '2026-11-02T09:00:00.000Z',
        cwd: root,
        git: { branch: 'add-changelog' },
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Add a CHANGELOG with an Unreleased section' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Added CHANGELOG.md.' }],
      }),
    ],
    CODEX_SESSION_TIME,
  )
}

describe('importing Claude Code and Codex sessions', function () {
  this.timeout(90_000)
  const originalClaude = process.env['CLAUDE_CONFIG_DIR']
  const originalCodex = process.env['CODEX_HOME']
  const fixtures = join(tmpdir(), 'copse-e2e-import-sessions')

  before(async () => {
    resetUserData()
    removeE2eTree(fixtures)
    const root = seedStableWorkspace()
    seedSessions(fixtures, root)
    writeE2eEnv({
      CLAUDE_CONFIG_DIR: join(fixtures, 'claude'),
      CODEX_HOME: join(fixtures, 'codex'),
    })
    seedEmptyProject(root, PROJECT_ID, { windowBounds: { width: 1280, height: 800 } })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ CLAUDE_CONFIG_DIR: originalClaude, CODEX_HOME: originalCodex })
    resetUserData()
    removeE2eTree(fixtures)
  })

  it('lists the sessions that ran in the project and opens an imported one as a thread', async () => {
    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Import sessions…').click()
    const dialog = $('#import-sessions-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('.import-sessions-list').waitForDisplayed({ timeout: 15_000 })
    await expect(dialog.$$('.import-session-row')).toBeElementsArrayOfSize(2)
    const first = dialog.$('.import-session-row:nth-child(1)')
    const second = dialog.$('.import-session-row:nth-child(2)')
    await expect(first.$('.import-session-title')).toHaveText(
      'Why does the README build badge show failing?',
    )
    await expect(first.$('.import-session-source')).toHaveText('Claude Code')
    await expect(second.$('.import-session-title')).toHaveText(
      'Add a CHANGELOG with an Unreleased section',
    )
    await expect(second.$('.import-session-meta')).toHaveText(
      expect.stringContaining('add-changelog'),
    )
    await expect(dialog.$('.import-sessions-confirm')).toBeDisabled()

    await first.$('.import-session-check').click()
    await second.$('.import-session-check').click()
    await expect(dialog.$('.import-sessions-confirm')).toHaveText('Import 2 sessions')
    await saveAppScreenshot('import-sessions-dialog.png')

    await dialog.$('.import-sessions-confirm').click()
    await expect(dialog).not.toBeDisplayed()
    const notice = $('.imported-session-notice')
    await expect(notice).toBeDisplayed()
    await expect(notice).toHaveText(expect.stringContaining('Imported from Claude Code.'))
    await expect($$('.msg-user')).toBeElementsArrayOfSize(1)
    await expect($('.conversation-scroll')).toHaveText(
      expect.stringContaining('The failing badge must come from another page.'),
    )
    await saveAppScreenshot('imported-session-thread.png')

    // Importing again offers to open the thread instead of making a copy.
    await $(PROJECT_MENU).click()
    await $('.context-menu-item=Import sessions…').click()
    await dialog.$('.import-sessions-list').waitForDisplayed({ timeout: 15_000 })
    await expect(dialog.$$('.import-session-row.is-imported')).toBeElementsArrayOfSize(2)
    await expect(dialog.$('.import-session-check')).not.toExist()
    await saveAppScreenshot('import-sessions-already-imported.png')
    await dialog.$('.import-session-row:nth-child(2) .import-session-open').click()
    await expect(dialog).not.toBeDisplayed()
    await expect($('.imported-session-notice')).toHaveText(
      expect.stringContaining('Imported from Codex.'),
    )
  })
})
