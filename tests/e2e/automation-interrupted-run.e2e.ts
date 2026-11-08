import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-interrupted-automation'
const OTHER_PROJECT = 'e2e-interrupted-automation-other'
const OLD = 'interrupted-health-run'
const SCHEDULE = 'health-schedule'
const PROMPT = 'Run a fresh health check and preserve earlier work.'
const SEEDED_AT = Date.parse('2026-11-06T10:00:00Z')
const metaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  interruptedTurnAt: z.number().optional(),
  currentEpoch: z.string().optional(),
  continuationUsed: z.number().optional(),
  worktree: z.looseObject({ path: z.string(), branch: z.string() }).optional(),
})

function meta(id: string): z.infer<typeof metaSchema> {
  const path = join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')
  const parsed = safeJsonParse(readFileSync(path, 'utf8'), decodeWithSchema(metaSchema))
  assert.ok(parsed, `invalid persisted fixture metadata for ${id}`)
  return parsed
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('inactive automation after an interrupted app session', function () {
  this.timeout(90_000)
  let projectRoot = ''
  let retainedCheckout = ''
  let baseHead = ''

  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    projectRoot = join(dirname(worktrees), 'interrupted-automation-project')
    const other = join(dirname(worktrees), 'interrupted-automation-notes')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(other, { recursive: true })
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Copse E2E')
    git('config', 'user.email', 'e2e@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(projectRoot, 'README.md'), 'Health-check project.\n')
    git('add', 'README.md')
    git('commit', '-qm', 'seed')
    baseHead = git('rev-parse', 'HEAD')
    retainedCheckout = join(worktrees, PROJECT, OLD)
    mkdirSync(dirname(retainedCheckout), { recursive: true })
    git('worktree', 'add', '-q', '-b', 'copse/interrupted-health', retainedCheckout, 'main')
    writeFileSync(join(retainedCheckout, 'checkpoint.txt'), 'saved before Copse closed\n')
    seedEmptyProject(other, OTHER_PROJECT, { model: 'claude-sonnet-4-6' })
    writeSettings({ autoArchiveAfterDays: 0 })
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: projectRoot, name: 'health project' },
        { id: OTHER_PROJECT, path: other, name: 'notes' },
      ],
      activeProjectId: OTHER_PROJECT,
      activeThreadId: 'notes-thread',
      [`threads:${OTHER_PROJECT}`]: [
        {
          id: 'notes-thread',
          title: 'Meeting notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        },
      ],
      [`threads:${PROJECT}`]: [
        {
          id: OLD,
          title: 'Interrupted health check',
          status: 'running',
          currentEpoch: 'original-human-tree',
          continuationUsed: 5,
          model: 'claude-sonnet-4-6',
          automation: {
            scheduleId: SCHEDULE,
            scheduleName: 'Health check',
            triggeredAt: SEEDED_AT,
          },
          worktree: {
            path: retainedCheckout,
            branch: 'copse/interrupted-health',
            baseBranch: 'main',
            baseCommit: baseHead,
            createdAt: SEEDED_AT,
            seededFromDirtyProject: false,
          },
          messages: [
            {
              id: 'earlier-checkpoint',
              role: 'assistant',
              content: 'The first checkpoint is saved. Release verification still needs attention.',
              toolCalls: [],
              createdAt: SEEDED_AT,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
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
                name: 'Health check',
                cron: '* * * * *',
                prompt: PROMPT,
                model: 'claude-sonnet-4-6',
                enabled: false,
                maxLiveWorktrees: 1,
                lastCreatedThreadId: OLD,
                lastRunAt: SEEDED_AT,
                createdAt: SEEDED_AT,
                updatedAt: SEEDED_AT,
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

  it('starts a fresh closed-project run and retains the interrupted checkpoint for explicit recovery', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const previous = meta(OLD)
    const previousMetaBytes = readFileSync(join(e2eWorkspaceDir(), PROJECT, OLD, 'meta.json'))
    assert.equal(
      previous.status,
      'running',
      'the closed project must remain unrecovered by the renderer',
    )
    const evidencePaths = [
      join(e2eWorkspaceDir(), PROJECT, OLD, 'events.jsonl'),
      join(e2eWorkspaceDir(), PROJECT, OLD, 'messages', 'earlier-checkpoint.md'),
      join(retainedCheckout, 'checkpoint.txt'),
    ]
    const before = evidencePaths.map((path) => readFileSync(path))
    const scenario = await installMockScenario(
      {
        title: 'Fresh health check',
        turns: [
          {
            user: PROMPT,
            responses: [
              {
                text: 'The fresh health check is complete. The earlier checkpoint remains saved.',
              },
            ],
          },
        ],
      },
      null,
    )

    await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await dialog.$('.automation-run-btn').click()
    await expect(dialog.$('.automation-status')).toHaveText('Started “Health check”.')
    await scenario.waitForComplete()
    await scenario.assertComplete()
    assert.equal(await $('.chat-row.selected').getAttribute('data-thread-id'), 'notes-thread')
    const newRuns = (): string[] =>
      readdirSync(join(e2eWorkspaceDir(), PROJECT)).filter(
        (id) => id !== OLD && existsSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
      )
    await browser.waitUntil(() => newRuns().some((id) => meta(id).status === 'idle'), {
      timeout: 10_000,
      timeoutMsg: 'the new headless run did not settle in its own persisted thread',
    })
    const [newId] = newRuns()
    assert.ok(newId)
    assert.equal(newRuns().length, 1)
    assert.notEqual(meta(newId).worktree?.path, retainedCheckout)
    assert.ok(meta(newId).worktree?.path, 'the new run must have its own isolated checkout')
    assert.equal(meta(OLD).status, 'idle')
    assert.ok(meta(OLD).interruptedTurnAt)
    assert.equal(meta(OLD).currentEpoch, 'original-human-tree')
    assert.equal(meta(OLD).continuationUsed, 5)
    for (const [index, path] of evidencePaths.entries())
      assert.deepEqual(readFileSync(path), before[index])
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: retainedCheckout,
        encoding: 'utf8',
      }).trim(),
      baseHead,
    )
    const artifactRoot = join(process.cwd(), 'tests/e2e/artifacts/automation-interrupted-run')
    mkdirSync(artifactRoot, { recursive: true })
    const recovered = meta(OLD)
    const recoveredMetaBytes = readFileSync(join(e2eWorkspaceDir(), PROJECT, OLD, 'meta.json'))
    writeFileSync(join(artifactRoot, 'before-meta.json'), previousMetaBytes)
    writeFileSync(join(artifactRoot, 'after-meta.json'), recoveredMetaBytes)
    writeFileSync(
      join(artifactRoot, 'new-thread-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, newId, 'meta.json')),
    )
    const protectedFiles = evidencePaths.map((path, index) => {
      const saved = before[index]
      assert.ok(saved)
      const after = readFileSync(path)
      writeFileSync(join(artifactRoot, `before-${String(index)}.bin`), saved)
      writeFileSync(join(artifactRoot, `after-${String(index)}.bin`), after)
      return { path, beforeSha256: sha256(saved), afterSha256: sha256(after) }
    })
    writeFileSync(
      join(artifactRoot, 'receipt.json'),
      `${JSON.stringify(
        {
          oldThreadId: OLD,
          newThreadId: newId,
          oldCheckout: retainedCheckout,
          newCheckout: meta(newId).worktree,
          protectedFiles,
          oldMeta: {
            beforeSha256: sha256(previousMetaBytes),
            afterSha256: sha256(recoveredMetaBytes),
          },
          epoch: {
            before: previous.currentEpoch,
            after: recovered.currentEpoch,
            beforeSha256: sha256(JSON.stringify(previous.currentEpoch)),
            afterSha256: sha256(JSON.stringify(recovered.currentEpoch)),
          },
          continuationUsed: {
            before: previous.continuationUsed,
            after: recovered.continuationUsed,
            beforeSha256: sha256(JSON.stringify(previous.continuationUsed)),
            afterSha256: sha256(JSON.stringify(recovered.continuationUsed)),
          },
          retainedWorktree: {
            beforeSha256: sha256(JSON.stringify(previous.worktree)),
            afterSha256: sha256(JSON.stringify(recovered.worktree)),
            head: baseHead,
          },
        },
        null,
        2,
      )}\n`,
    )
    await browser.keys('Escape')
    await $('.project-row*=health project').click()
    for (const selector of [
      '.automation-threads-toggle',
      `.automation-schedule-group[data-schedule-id="${SCHEDULE}"] .automation-schedule-toggle`,
    ]) {
      const toggle = $(selector)
      await toggle.waitForExist({ timeout: 10_000 })
      await browser.execute((currentSelector) => {
        const currentToggle = document.querySelector(currentSelector)
        if (!(currentToggle instanceof HTMLButtonElement))
          throw new Error(`Missing automation toggle: ${currentSelector}`)
        const expanded = currentToggle.getAttribute('aria-expanded')
        if (expanded !== 'true' && expanded !== 'false')
          throw new Error(`Automation toggle has no expanded state: ${currentSelector}`)
        if (expanded === 'false') currentToggle.click()
      }, selector)
    }
    await $(`.chat-row[data-thread-id="${newId}"]`).click()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('The fresh health check is complete.'),
    )
    const restoreTime = await pinTextForCapture(
      '.automation-schedule-runs',
      /^Latest · .+$/,
      'Latest · Jan 1, 2026, 12:00 AM',
    )
    // The completed run renames its real checkout after the thread title.
    // Wait for that state, then pin only the generated suffix for capture.
    await expect($('.footer-branch-label')).toHaveText(/^copse\/health-check-[a-f0-9]+$/)
    const restoreBranch = await pinTextForCapture(
      '.footer-branch-label',
      /^copse\/health-check-[a-f0-9]+$/,
      'copse/health-check-000001',
    )
    try {
      await parkPointer()
      await saveAppScreenshot('automation-interrupted-fresh-run.png')
    } finally {
      await restoreBranch()
    }
    await $(`.chat-row[data-thread-id="${OLD}"]`).click()
    const card = $('[data-turn-recovery-card]')
    await expect(card.$('.turn-recovery-title')).toHaveText('Turn interrupted')
    await expect(card.$('.turn-recovery-button')).toHaveText('Retry this turn')
    await expect(card.$('.turn-recovery-detail')).toHaveText(
      expect.stringContaining('Copse closed before this turn finished.'),
    )
    await parkPointer()
    await saveAppScreenshot('automation-interrupted-saved-run.png')
    await restoreTime()
  })
})
