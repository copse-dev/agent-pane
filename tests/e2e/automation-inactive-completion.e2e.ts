import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue } from './helpers/composer.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'e2e-carried-headless-completion'
const OTHER = 'e2e-carried-headless-notes'
const SCHEDULE = 'inactive-release-check'
const NOTES = 'release-notes'
const PROMPT = 'Check the release while I continue writing notes.'
const ANSWER = 'The release check is complete. The saved release notes need no changes.'
const DRAFT = 'Ask about the next release when I return.'
const NOTES_DRAFT = 'Keep these release notes unsent.'
const EVENT_KEY = 'copse-e2e-carried-headless-settled'
const WHEN = Date.parse('2026-11-06T10:00:00Z')
const metaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  currentEpoch: z.string().optional(),
  draftPrompt: z.string().optional(),
  automation: z.object({ scheduleId: z.string(), triggeredAt: z.number() }),
  worktree: z.object({ path: z.string(), branch: z.string() }),
})
const eventSchema = z.object({
  projectId: z.string(),
  threadId: z.string(),
  scheduleId: z.string(),
  triggeredAt: z.number(),
  headlessSettled: z.literal(true),
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function meta(id: string): z.infer<typeof metaSchema> {
  const value = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8'),
    decodeWithSchema(metaSchema),
  )
  assert.ok(value, 'the actual headless thread must have valid persisted metadata')
  return value
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function selectRun(id: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((threadId) => {
        const row = document.querySelector<HTMLElement>(
          `.automation-thread-rows .chat-row[data-thread-id="${threadId}"]`,
        )
        if (!row) return false
        if (!row.classList.contains('selected')) row.click()
        return true
      }, id),
    { timeout: 10_000, timeoutMsg: 'the actual automation row did not appear' },
  )
  await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', id)
  await expect($('.chat-row.selected .chat-title')).toHaveText('Release check')
  await expect($('.chat-row.selected .chat-thread-owner')).toHaveText('· release project')
}

describe('a headless completion carried away from its project', function () {
  this.timeout(90_000)
  let root = ''

  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    root = join(dirname(worktrees), 'inactive-completion-project')
    const otherRoot = join(dirname(worktrees), 'inactive-completion-notes')
    removeE2eTree(root)
    mkdirSync(root, { recursive: true })
    mkdirSync(otherRoot, { recursive: true })
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.name', 'Copse E2E'])
    git(root, ['config', 'user.email', 'e2e@example.invalid'])
    writeFileSync(join(root, 'README.md'), 'Release verification.\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-qm', 'seed'])
    seedEmptyProject(otherRoot, OTHER, { model: 'claude-sonnet-4-6' })
    writeSettings({ autoArchiveAfterDays: 0 })
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: root, name: 'release project' },
        { id: OTHER, path: otherRoot, name: 'release notes' },
      ],
      activeProjectId: OTHER,
      expandedProjectId: OTHER,
      activeThreadId: NOTES,
      [`threads:${OTHER}`]: [
        {
          id: NOTES,
          title: 'Release notes',
          status: 'idle',
          draftPrompt: NOTES_DRAFT,
          messages: [
            {
              id: 'notes-prompt',
              role: 'user',
              content: 'Keep the release notes ready.',
              createdAt: WHEN,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: WHEN,
          updatedAt: WHEN,
        },
      ],
      [`threads:${PROJECT}`]: [],
      pluginDisabled: [],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: SCHEDULE,
                projectId: PROJECT,
                name: 'Release check',
                cron: '0 0 1 1 *',
                prompt: PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 1,
                createdAt: WHEN,
                updatedAt: WHEN,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', NOTES)
  })

  after(() => {
    resetUserData()
  })

  it('clears the offscreen running indicator and preserves final history and both unsent drafts', async () => {
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/automation-inactive-completion')
    mkdirSync(artifacts, { recursive: true })
    const scenario = await installMockScenario(
      {
        title: 'Release check',
        turns: [{ user: PROMPT, responses: [{ waitFor: 'finish-release-check', text: ANSWER }] }],
      },
      null,
    )
    // Observe the existing final main-process event without replacing delivery
    // or adding a test-only product surface. Unsubscribe after this occurrence.
    await browser.execute(
      ({ projectId, scheduleId, key }) => {
        sessionStorage.removeItem(key)
        let stop = (): void => {}
        stop = window.api.automations.onTriggered((event) => {
          if (
            event.projectId !== projectId ||
            event.scheduleId !== scheduleId ||
            !event.headlessSettled
          )
            return
          sessionStorage.setItem(key, JSON.stringify(event))
          stop()
        })
      },
      { projectId: PROJECT, scheduleId: SCHEDULE, key: EVENT_KEY },
    )
    const trigger = await browser.execute(
      ({ projectId, scheduleId }) => window.api.automations.runNow(projectId, scheduleId),
      { projectId: PROJECT, scheduleId: SCHEDULE },
    )
    assert.equal(trigger.disposition, 'started')
    const id = trigger.threadId
    assert.ok(id)
    await scenario.waitForHold('finish-release-check')
    const running = meta(id)
    assert.equal(running.status, 'running')
    assert.equal(running.currentEpoch, undefined, 'this must be a real main-owned headless turn')
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-row`).click()
    const row = $(`.automation-thread-rows .chat-row[data-thread-id="${id}"]`)
    if (!(await row.isExisting())) await $('.automation-threads-toggle').click()
    await selectRun(id)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(PROMPT))
    await expect($('.stop-btn')).toBeDisplayed()
    await setComposerValue(DRAFT)
    await $(`.project-entry[data-project-id="${OTHER}"] .project-row`).click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', NOTES)
    await expect($('.prompt-input')).toHaveText(NOTES_DRAFT)
    const projectRow = (): ReturnType<typeof $> =>
      $(`.project-entry[data-project-id="${PROJECT}"] .project-row`)
    await expect(projectRow()).toHaveElementClass('is-running')
    await expect($('.automation-threads-toggle .automation-threads-running')).toExist()
    const notesSpine = readFileSync(join(e2eWorkspaceDir(), OTHER, NOTES, 'events.jsonl'))
    writeFileSync(
      join(artifacts, 'running-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
    )
    await scenario.release('finish-release-check')
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await browser.waitUntil(
      async () => (await browser.execute((key) => sessionStorage.getItem(key), EVENT_KEY)) !== null,
      { timeout: 15_000, timeoutMsg: 'main did not deliver the final headlessSettled event' },
    )
    const eventText = await browser.execute((key) => sessionStorage.getItem(key), EVENT_KEY)
    assert.ok(eventText)
    // Retain the actual completed disk state before any UI assertions or reset.
    writeFileSync(join(artifacts, 'headless-settled-event.json'), eventText)
    writeFileSync(
      join(artifacts, 'settled-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
    )
    writeFileSync(
      join(artifacts, 'settled-events.jsonl'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl')),
    )
    const event = safeJsonParse(eventText, decodeWithSchema(eventSchema))
    assert.ok(event)
    const settled = meta(id)
    const mainOwnedEpochAbsent = settled.currentEpoch === undefined
    assert.equal(settled.status, 'idle')
    assert.equal(settled.currentEpoch, undefined)
    assert.equal(event.threadId, id)
    assert.equal(event.triggeredAt, running.automation.triggeredAt)
    assert.equal(event.scheduleId, SCHEDULE)
    assert.ok(settled.worktree.branch.startsWith('copse/release-check-'))
    assert.equal(git(settled.worktree.path, ['branch', '--show-current']), settled.worktree.branch)
    await expect(projectRow()).not.toHaveElementClass('is-running')
    await expect($('.automation-threads-toggle .automation-threads-running')).not.toExist()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', NOTES)
    await expect($('.prompt-input')).toHaveText(NOTES_DRAFT)
    assert.deepEqual(
      readFileSync(join(e2eWorkspaceDir(), OTHER, NOTES, 'events.jsonl')),
      notesSpine,
    )
    await parkPointer()
    await saveAppScreenshot('automation-inactive-project-completed.png')
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-row`).click()
    await selectRun(id)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(ANSWER))
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($(`.chat-row[data-thread-id="${id}"] .chat-running-status`)).not.toExist()
    const finalMessages = await browser.execute(
      ({ projectId, threadId }) => window.api.threads.loadMessages(projectId, threadId),
      { projectId: PROJECT, threadId: id },
    )
    assert.equal(finalMessages.filter((message) => message.role === 'user').length, 1)
    assert.equal(
      finalMessages.filter((message) => message.role === 'assistant' && message.content === ANSWER)
        .length,
      1,
    )
    const runs = readdirSync(join(e2eWorkspaceDir(), PROJECT)).filter((threadId) =>
      existsSync(join(e2eWorkspaceDir(), PROJECT, threadId, 'meta.json')),
    )
    assert.deepEqual(runs, [id])
    await expect($('.footer-branch-label')).toHaveText(settled.worktree.branch)
    const restoreBranch = await pinTextForCapture(
      '.footer-branch-label',
      /^copse\/release-check-.+$/,
      'copse/release-check-000001',
    )
    try {
      await parkPointer()
      await saveAppScreenshot('automation-carried-completed-history.png')
    } finally {
      await restoreBranch()
    }
    const finalSpine = readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'))
    writeFileSync(
      join(artifacts, 'settled-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
    )
    writeFileSync(join(artifacts, 'settled-events.jsonl'), finalSpine)
    writeFileSync(join(artifacts, 'settled-messages.json'), JSON.stringify(finalMessages, null, 2))
    writeFileSync(join(artifacts, 'headless-settled-event.json'), eventText)
    await browser.reloadSession()
    await selectRun(id)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(ANSWER))
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($(`.chat-row[data-thread-id="${id}"] .chat-running-status`)).not.toExist()
    assert.deepEqual(readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl')), finalSpine)
    assert.deepEqual(
      readFileSync(join(e2eWorkspaceDir(), OTHER, NOTES, 'events.jsonl')),
      notesSpine,
    )
    writeFileSync(
      join(artifacts, 'reloaded-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
    )
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          threadId: id,
          mainOwnedEpochAbsent,
          actualFinalEvent: event,
          physicalFriendlyBranch: settled.worktree.branch,
          exactRunCount: runs.length,
          userMessages: finalMessages.filter((message) => message.role === 'user').length,
          finalReplies: finalMessages.filter((message) => message.content === ANSWER).length,
          notesSpineSha256: digest(notesSpine),
          finalSpineSha256: digest(finalSpine),
          notesDraft: NOTES_DRAFT,
          carriedDraft: DRAFT,
          reloadHistoryUnchanged: true,
        },
        null,
        2,
      ),
    )
  })
})
