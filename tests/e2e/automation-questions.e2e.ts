import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '../../src/shared/types/index.ts'
import { loadProjectThreads } from '../../src/main/services/thread-store.ts'
import {
  readSeededSettings,
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import {
  pinTextForCapture,
  saveAppScreenshot,
  saveElementScreenshot,
} from './helpers/screenshot.ts'

const PROJECT = 'automation-questions-project'
const SCHEDULE = 'release-notes-review'
const PROMPT = 'Review the release notes. Save any decisions for me and finish independent checks.'
const REPLY =
  'I checked the release notes. The release channel and sign-off decisions still need your input.'
const ANSWER_PROMPT = 'Answer to your review question “Which release channel?”: Preview'
const HOOK_NOTE = 'Retain the saved review question.'
const SAVED_QUESTIONS = [
  {
    question: 'Which release channel?',
    options: ['Stable', 'Preview'],
    recommendedOption: 'Preview',
    recommendationReason: 'The change needs a short trial.',
  },
  { question: 'Who signs off?', options: ['Editor', 'Maintainer'] },
]

describe('unattended automation questions', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    const root = join(dirname(worktreesRoot), 'automation-questions-project')
    mkdirSync(root, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'e2e@example.invalid')
    git('config', 'user.name', 'Copse E2E')
    writeFileSync(join(root, 'README.md'), 'Release notes: corrected the calendar dates.\n')
    mkdirSync(join(root, '.copse'), { recursive: true })
    writeFileSync(
      join(root, '.copse', 'question-note.cjs'),
      [
        "const payload = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))",
        `const response = { injectContext: ${JSON.stringify(HOOK_NOTE)} }`,
        "if (payload.input?.questions?.[0]?.question === 'Which channel?') {",
        `  response.updatedInput = { questions: ${JSON.stringify(SAVED_QUESTIONS)} }`,
        '}',
        'process.stdout.write(JSON.stringify(response))',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(root, '.copse', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { toolGate: [{ command: 'node .copse/question-note.cjs', matcher: '^ask_user$' }] },
      }),
    )
    git('add', 'README.md', '.copse')
    git('commit', '-qm', 'seed')
    seedEmptyProject(root, PROJECT, { model: 'claude-sonnet-4-6' })
    writeSettings({ ...readSeededSettings(), cursorHooksEnabled: true })
    assert.equal(readSeededSettings()['cursorHooksEnabled'], true)
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'Release notes' }],
      activeProjectId: PROJECT,
      activeThreadId: 'notes-thread',
      trustedWorkspaceRoots: [realpathSync(root)],
      [`threads:${PROJECT}`]: [
        {
          id: 'notes-thread',
          title: 'Notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      // Every other plugin on, but not PII redaction: its contextual classifier
      // downloads an ONNX model from huggingface.co (the e2e network guard refuses it).
      pluginDisabled: ['copse.pii-redaction'],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE,
                projectId: PROJECT,
                name: 'Release notes review',
                cron: '0 9 * * *',
                prompt: PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: false,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  afterEach(async () => {
    const directory = join(process.cwd(), 'e2e-failure-artifacts', 'automation-questions')
    mkdirSync(directory, { recursive: true })
    const threads = await loadProjectThreads(PROJECT)
    writeFileSync(join(directory, 'history.json'), JSON.stringify(threads, null, 2) + '\n')
    for (const thread of threads) {
      writeFileSync(
        join(directory, `${thread.id}-events.jsonl`),
        readFileSync(join(e2eWorkspaceDir(), PROJECT, thread.id, 'events.jsonl')),
      )
    }
  })

  it('finishes independent work, saves both questions and accepts a later interactive answer', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const scenario = await installMockScenario(
      {
        title: 'Release notes review',
        turns: [
          {
            user: PROMPT,
            responses: [
              {
                toolCalls: [
                  {
                    name: 'ask_user',
                    args: {
                      questions: [{ question: 'Which channel?', options: ['Stable'] }],
                    },
                  },
                ],
              },
              {
                waitFor: 'independent-read',
                // One expectation per actual result. The saved-question UI
                // below also requires the exact deferred output and lengths.
                expectToolResults: [{ name: 'ask_user', includes: HOOK_NOTE }],
                toolCalls: [{ name: 'read_file', args: { path: 'README.md' } }],
              },
              {
                text: REPLY,
                expectToolResults: [
                  { name: 'read_file', includes: 'corrected the calendar dates' },
                ],
              },
            ],
          },
        ],
      },
      null,
    )
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
    await $('.context-menu-item=Automations').click()
    const manager = $('#automation-dialog')
    await manager.$('.automation-run-btn').click()
    await expect(manager.$('.automation-status')).toHaveText('Started “Release notes review”.')
    await browser.keys('Escape')
    await scenario.waitForHold('independent-read', 30_000)
    await expect($('#ask-user-dialog')).not.toBeDisplayed()
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await scenario.release('independent-read')
    await scenario.waitForComplete()
    await scenario.assertComplete()

    let run: Thread | undefined
    await browser.waitUntil(
      async () => {
        run = (await loadProjectThreads(PROJECT)).find((thread) =>
          thread.messages.some((message) => message.content === REPLY),
        )
        return run?.status === 'idle'
      },
      { timeout: 30_000, timeoutMsg: 'The unattended review has not finished saving' },
    )
    assert.ok(run)
    const runId = run.id

    const automations = $('.automation-threads-toggle')
    await automations.waitForExist()
    if ((await automations.getAttribute('aria-expanded')) !== 'true') await automations.click()
    // One run is shown directly; schedule history folds appear only once there
    // is enough history to group. Select the actual fresh run in either layout.
    // Read the row at the click boundary: background metadata replaces sidebar
    // nodes between separate WebDriver find/click requests.
    await browser.waitUntil(
      async () =>
        await browser.execute((id) => {
          const row = [
            ...document.querySelectorAll<HTMLElement>('.automation-thread-rows .chat-row'),
          ].find((candidate) => candidate.dataset['threadId'] === id)
          if (!row) return false
          row.click()
          return true
        }, runId),
      { timeout: 10_000, timeoutMsg: 'The fresh automation run is missing from the sidebar' },
    )
    await expect($('.automation-thread-rows .chat-row.selected')).toHaveAttribute(
      'data-thread-id',
      runId,
    )
    await expectAssistantReply(REPLY)
    // Settling the turn also renames its checkout and repaints the transcript.
    // Wait for that real final state before opening a question disclosure.
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($('.footer-branch-label')).toHaveText(/^copse\/release-notes-review-[a-f0-9]+$/)
    const savedAsk = run.messages
      .flatMap((message) => message.toolCalls)
      .find((call) => call.name === 'ask_user')
    assert.ok(savedAsk)
    assert.deepEqual(savedAsk.args, {
      questions: [{ question: 'Which channel?', options: ['Stable'] }],
    })
    assert.match(savedAsk.result ?? '', /Which release channel\?/)
    assert.match(savedAsk.result ?? '', /Who signs off\?/)
    assert.deepEqual(savedAsk.appendedReminderLengths, [70])
    const card = $('.reviewer-input-card')
    await expect(card.$('summary')).toHaveText('Needs your input · 2 questions')
    await card.$('summary').click()
    await expect(card.$$('.reviewer-input-origin')).toBeElementsArrayOfSize(2)
    if (!(await $('#pane-files').isDisplayed()))
      await $('[aria-label="Toggle right panel"]').click()
    await $('[aria-label="Open thread context"]').click()
    const panel = $('.reviewer-input-panel')
    await panel.waitForDisplayed()
    await expect($('.reviewer-input-toggle')).toHaveText('2 questions')
    await expect(panel).toHaveText(expect.stringContaining('Which release channel?'))
    await expect(panel).toHaveText(expect.stringContaining('Who signs off?'))
    const restoreBranch = await pinTextForCapture(
      '#app',
      /copse\/release-notes-review-[a-f0-9]+/g,
      'copse/release-notes-review-000001',
    )
    try {
      await saveAppScreenshot('automation-questions-saved.png')
    } finally {
      await restoreBranch()
    }

    const followUp = await installMockScenario({
      title: 'Release notes review',
      turns: [
        {
          user: ANSWER_PROMPT,
          responses: [
            {
              toolCalls: [
                {
                  name: 'ask_user',
                  args: {
                    questions: [
                      {
                        question: 'Which team owns the preview?',
                        options: ['Maintainers', 'Editors'],
                      },
                    ],
                  },
                },
              ],
            },
            {
              text: 'Preview belongs to the maintainers. The saved sign-off decision is still pending.',
              expectToolResults: [{ name: 'ask_user', includes: 'The user answered: Maintainers' }],
            },
          ],
        },
      ],
    })
    await panel.$('.reviewer-input-item .reviewer-input-question').click()
    // Opening the disclosure redraws its row. Find that new row for the
    // remaining actions instead of retaining the detached collapsed row.
    await expect(panel.$('.reviewer-input-item').$('.reviewer-input-option=Preview')).toExist()
    await panel.$('.reviewer-input-item').$('.reviewer-input-option=Preview').click()
    await panel.$('.reviewer-input-item').$('.ui-btn-primary').click()
    const question = $('#ask-user-dialog')
    await question.waitForDisplayed()
    await expect(question).toHaveText(expect.stringContaining('Which team owns the preview?'))
    await saveElementScreenshot('#ask-user-dialog', 'automation-question-interactive-follow-up.png')
    await question.$('.ask-user-option=Maintainers').click()
    await followUp.waitForComplete()
    await followUp.assertComplete()
    await expectAssistantReply(
      'Preview belongs to the maintainers. The saved sign-off decision is still pending.',
    )
    await expect($('.reviewer-input-toggle')).toHaveText('1 question')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    if (!(await $('.reviewer-input-panel').isDisplayed()))
      await $('[aria-label="Open thread context"]').click()
    await expect($('.reviewer-input-toggle')).toHaveText('1 question')
    await expect($('.reviewer-input-panel')).toHaveText(expect.stringContaining('Who signs off?'))
    await expect($('[data-context-section="resolved-questions"]')).toHaveText(
      expect.stringContaining('Which release channel?'),
    )
    await expect($('#ask-user-dialog')).not.toBeDisplayed()
  })
})
