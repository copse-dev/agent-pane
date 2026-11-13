import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT = 'e2e-completed-automation-draft'
const OTHER = 'e2e-completed-automation-notes'
const THREAD = 'completed-release-check'
const SCHEDULE = 'manual-follow-up-schedule'
const DRAFT = 'Ask about the next release when I return.'
const ANSWER = 'The release check finished. No changes were needed.'
const NEXT_ANSWER = 'A fresh release check finished while the saved follow-up stays manual.'
const EPOCH = 'completed-original-human-tree'
const WHEN = Date.parse('2026-11-06T10:00:00Z')
const EVENTS = 'copse-e2e-completed-draft-chunks'
const metaSchema = z.object({
  id: z.string(),
  title: z.literal('Release check'),
  status: z.literal('idle'),
  currentEpoch: z.literal(EPOCH),
  continuationUsed: z.literal(3),
  draftPrompt: z.literal(DRAFT),
  lastPromptAt: z.number().optional(),
  worktree: z.unknown().optional(),
  worktreeChoice: z.unknown().optional(),
})
const freshMetaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  currentEpoch: z.string().optional(),
  draftPrompt: z.string().optional(),
  automation: z.object({ scheduleId: z.literal(SCHEDULE) }),
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
})

function readMeta(): z.infer<typeof metaSchema> {
  const meta = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), PROJECT, THREAD, 'meta.json'), 'utf8'),
    decodeWithSchema(metaSchema),
  )
  assert.ok(meta, 'the original completed turn and unsent draft must remain unchanged')
  assert.equal(meta.worktree, undefined, 'opening a completed draft must not allocate a checkout')
  assert.equal(
    meta.worktreeChoice,
    undefined,
    'opening a completed draft must not prepare a checkout',
  )
  return meta
}

describe('manual follow-up on a completed automation', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    const root = join(dirname(worktrees), 'completed-automation-draft-project')
    const otherRoot = join(dirname(worktrees), 'completed-automation-draft-notes')
    removeE2eTree(root)
    mkdirSync(root, { recursive: true })
    mkdirSync(otherRoot, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse E2E')
    git('config', 'user.email', 'e2e@example.invalid')
    writeFileSync(join(root, 'README.md'), 'Completed release check.\n')
    git('add', 'README.md')
    git('commit', '-qm', 'seed')
    seedEmptyProject(otherRoot, OTHER, { model: 'claude-sonnet-4-6' })
    writeSettings({ autoArchiveAfterDays: 0 })
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: root, name: 'release project' },
        { id: OTHER, path: otherRoot, name: 'notes' },
      ],
      activeProjectId: OTHER,
      activeThreadId: 'notes-thread',
      [`threads:${OTHER}`]: [
        {
          id: 'notes-thread',
          title: 'Release notes',
          status: 'idle',
          draftPrompt: 'Keep these notes unsent.',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: WHEN,
          updatedAt: WHEN,
        },
      ],
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Release check',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          currentEpoch: EPOCH,
          continuationUsed: 3,
          draftPrompt: DRAFT,
          gitBranch: 'main',
          messages: [
            {
              id: 'original-request',
              role: 'user',
              content: 'Check the release.',
              createdAt: WHEN,
            },
            { id: 'original-answer', role: 'assistant', content: ANSWER, createdAt: WHEN + 1_000 },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          automation: { scheduleId: SCHEDULE, scheduleName: 'Release check', triggeredAt: WHEN },
          createdAt: WHEN,
          updatedAt: WHEN + 1_000,
        },
      ],
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
                prompt: 'Check the release.',
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 1,
                lastCreatedThreadId: THREAD,
                lastRunAt: WHEN,
                createdAt: WHEN,
                updatedAt: WHEN,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'notes-thread')
  })

  after(() => {
    resetUserData()
  })

  it('admits a legacy completed draft before its project has ever been opened', async () => {
    const before = readMeta()
    assert.equal(before.lastPromptAt, undefined)
    const threadRoot = join(e2eWorkspaceDir(), PROJECT, THREAD)
    const spine = readFileSync(join(threadRoot, 'events.jsonl'))
    const scenario = await installMockScenario(
      {
        title: 'Closed legacy project release check',
        turns: [{ user: 'Check the release.', responses: [{ text: NEXT_ANSWER }] }],
      },
      null,
    )
    const event = await browser.execute(
      ({ project, schedule }) => window.api.automations.runNow(project, schedule),
      { project: PROJECT, schedule: SCHEDULE },
    )
    assert.equal(event.disposition, 'started')
    assert.notEqual(event.threadId, THREAD)
    await scenario.waitForComplete()
    await scenario.assertComplete()
    await browser.waitUntil(
      () => {
        const raw = readFileSync(
          join(e2eWorkspaceDir(), PROJECT, event.threadId, 'meta.json'),
          'utf8',
        )
        return safeJsonParse(raw, decodeWithSchema(freshMetaSchema))?.status === 'idle'
      },
      { timeout: 10_000, timeoutMsg: 'the new closed-project legacy run did not settle' },
    )
    assert.deepEqual(readMeta(), before)
    assert.deepEqual(readFileSync(join(threadRoot, 'events.jsonl')), spine)
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', 'notes-thread')
    await expect($('.prompt-input')).toHaveText('Keep these notes unsent.')
  })

  it('keeps the completed draft manual across project entry and reload', async () => {
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/automation-completed-draft')
    mkdirSync(artifacts, { recursive: true })
    const threadRoot = join(e2eWorkspaceDir(), PROJECT, THREAD)
    const beforeMeta = readFileSync(join(threadRoot, 'meta.json'))
    const beforeSpine = readFileSync(join(threadRoot, 'events.jsonl'))
    assert.equal(
      readMeta().lastPromptAt,
      undefined,
      'main admission leaves legacy metadata untouched',
    )
    writeFileSync(join(artifacts, 'before-meta.json'), beforeMeta)
    writeFileSync(join(artifacts, 'before-events.jsonl'), beforeSpine)
    await browser.execute(
      ({ threadId, key }) => {
        const chunks: unknown[] = []
        sessionStorage.setItem(key, '[]')
        window.api.agent.onChunk((id, chunk) => {
          if (id !== threadId) return
          chunks.push(chunk)
          sessionStorage.setItem(key, JSON.stringify(chunks))
        })
      },
      { threadId: THREAD, key: EVENTS },
    )
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-row`).click()
    const rowSelector = `.automation-thread-rows .chat-row[data-thread-id="${THREAD}"]`
    if (!(await $(rowSelector).isExisting())) await $('.automation-threads-toggle').click()
    await browser.waitUntil(
      () =>
        browser.execute((selector) => {
          const row = document.querySelector<HTMLElement>(selector)
          if (!row) return false
          if (!row.classList.contains('selected')) row.click()
          return true
        }, rowSelector),
      { timeout: 10_000, timeoutMsg: 'the completed automation row did not appear' },
    )
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD)
    const scheduleHeading = $(
      `.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-toggle`,
    )
    await expect(scheduleHeading.$('.automation-schedule-title')).toHaveText('Release check')
    // The owner label yields its width before the schedule title in a compact sidebar.
    assert.equal(
      await scheduleHeading.$('.chat-thread-owner').getProperty('textContent'),
      '· release project',
    )
    await expect($('.messages-list')).toHaveText(expect.stringContaining(ANSWER))
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.submit-btn')).toHaveText('Send')
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($(`${rowSelector} .chat-running-status`)).not.toExist()
    const chunkText = await browser.execute((key) => sessionStorage.getItem(key), EVENTS)
    assert.ok(chunkText)
    const chunks = safeJsonParse(chunkText, decodeWithSchema(z.array(z.unknown())))
    assert.deepEqual(chunks, [])
    await browser.waitUntil(() => readMeta().lastPromptAt === WHEN, {
      timeout: 10_000,
      timeoutMsg: 'ordinary hydration did not persist the actual prior prompt timestamp',
    })
    assert.deepEqual(readFileSync(join(threadRoot, 'events.jsonl')), beforeSpine)
    writeFileSync(join(artifacts, 'agent-chunks.json'), chunkText)
    writeFileSync(join(artifacts, 'opened-meta.json'), readFileSync(join(threadRoot, 'meta.json')))
    const restoreTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Nov 6, 2026, 10:01 AM',
    )
    try {
      await parkPointer()
      await saveAppScreenshot('automation-completed-draft-manual.png')
    } finally {
      await restoreTime()
    }
    await browser.reloadSession()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(ANSWER))
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.stop-btn')).not.toBeDisplayed()
    await expect($(`${rowSelector} .chat-running-status`)).not.toExist()
    readMeta()
    assert.equal(readMeta().lastPromptAt, WHEN)
    const afterSpine = readFileSync(join(threadRoot, 'events.jsonl'))
    assert.deepEqual(afterSpine, beforeSpine)
    writeFileSync(
      join(artifacts, 'reloaded-meta.json'),
      readFileSync(join(threadRoot, 'meta.json')),
    )
    writeFileSync(join(artifacts, 'reloaded-events.jsonl'), afterSpine)
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          threadId: THREAD,
          unchangedEpoch: EPOCH,
          unchangedContinuationUsed: 3,
          draft: DRAFT,
          agentChunks: chunks,
          beforeSpineSha256: createHash('sha256').update(beforeSpine).digest('hex'),
          afterSpineSha256: createHash('sha256').update(afterSpine).digest('hex'),
          noSubmissionAcrossEntryAndReload: true,
        },
        null,
        2,
      ),
    )
  })

  it('starts a distinct run while preserving the completed human draft', async () => {
    const projectRoot = join(e2eWorkspaceDir(), PROJECT)
    const threadRoot = join(projectRoot, THREAD)
    const previous = readMeta()
    assert.equal(previous.lastPromptAt, WHEN)
    const beforeSpine = readFileSync(join(threadRoot, 'events.jsonl'))
    const previousRuns = new Set(readdirSync(projectRoot))
    const scenario = await installMockScenario(
      {
        title: 'Fresh release check',
        turns: [{ user: 'Check the release.', responses: [{ text: NEXT_ANSWER }] }],
      },
      null,
    )
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await dialog.$('.automation-run-btn').click()
    await expect(dialog.$('.automation-status')).toHaveText('Started “Release check”.')
    await scenario.waitForComplete()
    await scenario.assertComplete()
    const newRuns = (): string[] =>
      readdirSync(projectRoot).filter(
        (id) => !previousRuns.has(id) && existsSync(join(projectRoot, id, 'meta.json')),
      )
    const freshMeta = (id: string): z.infer<typeof freshMetaSchema> => {
      const meta = safeJsonParse(
        readFileSync(join(projectRoot, id, 'meta.json'), 'utf8'),
        decodeWithSchema(freshMetaSchema),
      )
      assert.ok(meta, 'the distinct scheduled run must have valid persisted metadata')
      return meta
    }
    await browser.waitUntil(() => newRuns().some((id) => freshMeta(id).status === 'idle'), {
      timeout: 10_000,
      timeoutMsg: 'the distinct scheduled run did not settle',
    })
    assert.equal(newRuns().length, 1, 'one click must create exactly one fresh run')
    const [newId] = newRuns()
    assert.ok(newId)
    const fresh = freshMeta(newId)
    // Preserve the raw main/store state even if a later assertion or capture fails.
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/automation-completed-draft')
    mkdirSync(artifacts, { recursive: true })
    for (const id of [THREAD, newId]) {
      cpSync(join(projectRoot, id), join(artifacts, 'after-next-run', id), {
        recursive: true,
        dereference: false,
      })
    }
    assert.equal(fresh.id, newId)
    assert.notEqual(fresh.id, THREAD)
    assert.ok(fresh.currentEpoch)
    assert.notEqual(fresh.currentEpoch, EPOCH)
    assert.equal(fresh.draftPrompt, undefined, 'sending removes the fresh scheduled draft')
    assert.ok(fresh.worktree)
    assert.ok(existsSync(fresh.worktree.path), 'the new run must own an actual checkout')
    assert.notEqual(fresh.worktree.branch, 'main')
    assert.deepEqual(readMeta(), previous, 'a later run must preserve the human draft and turn')
    assert.deepEqual(readFileSync(join(threadRoot, 'events.jsonl')), beforeSpine)

    writeFileSync(
      join(artifacts, 'next-run-receipt.json'),
      JSON.stringify(
        {
          oldThreadId: THREAD,
          newThreadId: newId,
          previous,
          afterNextRun: readMeta(),
          fresh,
          beforeSpineSha256: createHash('sha256').update(beforeSpine).digest('hex'),
          afterSpineSha256: createHash('sha256')
            .update(readFileSync(join(threadRoot, 'events.jsonl')))
            .digest('hex'),
        },
        null,
        2,
      ),
    )
    await dialog.$('[aria-label="Close automations"]').click()
    for (const selector of [
      '.automation-threads-toggle',
      `.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-toggle`,
    ]) {
      const toggle = $(selector)
      await toggle.waitForExist({ timeout: 10_000 })
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    }
    await $(`.chat-row[data-thread-id="${newId}"]`).click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', newId)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(NEXT_ANSWER))
    await expect($('.submit-btn')).toHaveText('Send')
    await expect($('.stop-btn')).not.toBeDisplayed()
    await $(`.chat-row[data-thread-id="${THREAD}"]`).click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD)
    await expect($('.messages-list')).toHaveText(expect.stringContaining(ANSWER))
    await expect($('.messages-list')).not.toHaveText(expect.stringContaining(NEXT_ANSWER))
    await expect($('.prompt-input')).toHaveText(DRAFT)
    await expect($('.submit-btn')).toHaveText('Send')
    await expect($('.stop-btn')).not.toBeDisplayed()
    assert.deepEqual(readMeta(), previous)
    assert.deepEqual(readFileSync(join(threadRoot, 'events.jsonl')), beforeSpine)
    const restoreTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Nov 6, 2026, 10:02 AM',
    )
    try {
      const restoreEarlierTime = await pinTextForCapture(
        '.automation-schedule-runs .chat-row:not(.selected) .chat-title',
        /^(?!Latest · ).+$/,
        'Nov 6, 2026, 10:01 AM',
      )
      try {
        await parkPointer()
        await saveAppScreenshot('automation-completed-draft-next-run.png')
      } finally {
        await restoreEarlierTime()
      }
    } finally {
      await restoreTime()
    }
  })
})
