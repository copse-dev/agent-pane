import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { parseSpine } from '../../src/shared/threads/spine-schema.ts'
import { startConversationServer } from './helpers/conversation-server.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  resetUserMcpConfig,
  seedE2eViewport,
  seedUserMcpConfig,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { parkPointer, pinTextForCapture, saveAppScreenshot } from './helpers/screenshot.ts'

const PROJECT = 'e2e-headless-tool-history'
const OTHER = 'e2e-headless-tool-notes'
const SCHEDULE = 'project-verification'
const TOOL = 'mcp__verification__verify_project'
const PROMPT = 'Verify the project and report the result.'
const SEEDED_AT = Date.parse('2026-11-06T12:00:00Z')
const metaSchema = z.object({
  id: z.string(),
  status: z.enum(['idle', 'running', 'error']),
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
})
const enteredSchema = z.object({ calls: z.number(), pid: z.number() })

function meta(id: string): z.infer<typeof metaSchema> {
  const value = safeJsonParse(
    readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json'), 'utf8'),
    decodeWithSchema(metaSchema),
  )
  assert.ok(value)
  return value
}
function runs(): string[] {
  const directory = join(e2eWorkspaceDir(), PROJECT)
  return existsSync(directory)
    ? readdirSync(directory).filter((id) => existsSync(join(directory, id, 'meta.json')))
    : []
}
function savedMessages(id: string): ReturnType<typeof parseSpine> {
  return parseSpine(readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl'), 'utf8'))
}
async function pinBranch(id: string, prefix: string): Promise<() => Promise<void>> {
  await browser.waitUntil(() => meta(id).worktree?.branch.startsWith(prefix) === true, {
    timeout: 10_000,
    timeoutMsg: `The real run branch never reached ${prefix}`,
  })
  const branch = meta(id).worktree?.branch
  assert.ok(branch)
  await expect($('.footer-branch-label')).toHaveText(branch)
  return pinTextForCapture(
    '.footer-branch-label',
    /^copse\/[a-z0-9-]+-[a-f0-9]+$/,
    branch.replace(/-[^-]+$/, '-000001'),
  )
}

describe('headless automation tool history', function () {
  this.timeout(90_000)
  let directory = ''
  let conversation: Awaited<ReturnType<typeof startConversationServer>> | undefined

  before(async () => {
    resetUserData()
    const worktrees = process.env['COPSE_WORKTREES_DIR']
    assert.ok(worktrees)
    const base = dirname(worktrees)
    const projectRoot = join(base, 'headless-tool-project')
    const otherRoot = join(base, 'headless-tool-notes')
    directory = join(base, 'verification-service')
    for (const path of [projectRoot, otherRoot, directory]) mkdirSync(path, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })
    writeFileSync(join(projectRoot, 'README.md'), 'Verify this project before reporting success.\n')
    execFileSync('git', ['add', 'README.md'], { cwd: projectRoot })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Copse E2E',
        '-c',
        'user.email=e2e@example.invalid',
        'commit',
        '-qm',
        'seed',
      ],
      { cwd: projectRoot },
    )
    conversation = await startConversationServer({ title: 'Project verification' })
    conversation.enqueue(
      { user: PROMPT, text: '', toolCalls: [{ name: TOOL, args: {} }] },
      {
        user: PROMPT,
        toolResults: [{ name: TOOL, includes: 'Verification completed successfully.' }],
        text: 'Verification complete. The project is ready.',
      },
    )
    conversation.configureEnvironment()
    seedUserMcpConfig({
      verification: {
        command: process.execPath,
        args: [join(process.cwd(), 'tests/e2e/fixtures/held-verification-mcp.mts')],
        env: { MCP_VERIFICATION_HOLD_DIR: directory },
      },
    })
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: projectRoot, name: 'verification project' },
        { id: OTHER, path: otherRoot, name: 'notes' },
      ],
      activeProjectId: OTHER,
      activeThreadId: 'notes',
      [`threads:${OTHER}`]: [
        {
          id: 'notes',
          title: 'Notes',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
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
                name: 'Project verification',
                cron: '* * * * *',
                prompt: PROMPT,
                model: conversation.settings.model,
                permissions: [{ kind: 'mcp-tool', toolName: TOOL }],
                enabled: false,
                createdAt: SEEDED_AT,
                updatedAt: SEEDED_AT,
              },
            ],
          },
        },
      },
    })
    seedE2eViewport({ width: 1280, height: 800 }, conversation.settings)
    await browser.reloadSession()
  })

  after(async () => {
    if (directory && existsSync(directory)) writeFileSync(join(directory, 'release'), 'finish\n')
    await conversation?.close()
    resetUserMcpConfig()
    resetUserData()
  })

  it('never shows unfinished work as a completed tool, then shows its actual terminal result', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => window.api.mcp.list())).some(
          (server) =>
            server.name === 'verification' &&
            server.state === 'connected' &&
            server.tools.includes('verify_project'),
        ),
      { timeout: 30_000, timeoutMsg: 'the verification service never connected' },
    )
    await $(`.project-entry[data-project-id="${PROJECT}"] .project-menu-btn`).click()
    await $('.context-menu-item=Automations').click()
    const dialog = $('#automation-dialog')
    await dialog.$('.automation-run-btn').click()
    await expect(dialog.$('.automation-status')).toHaveText('Started “Project verification”.')
    await dialog.$('[aria-label="Close automations"]').click()
    await browser.waitUntil(() => existsSync(join(directory, 'entered.json')), {
      timeout: 30_000,
      timeoutMsg: 'the actual verification tool never started',
    })
    const [id] = runs()
    assert.ok(id)
    assert.equal(runs().length, 1)
    assert.equal(meta(id).status, 'running')
    const pending = savedMessages(id)
    assert.equal(pending.flatMap((message) => message.toolCalls).length, 0)
    const orderingPlaceholder = pending.find((message) => message.role === 'assistant')
    assert.ok(orderingPlaceholder)
    const artifacts = join(process.cwd(), 'tests/e2e/artifacts/headless-tool-history')
    mkdirSync(artifacts, { recursive: true })
    const spine = join(e2eWorkspaceDir(), PROJECT, id, 'events.jsonl')
    const pendingBytes = readFileSync(spine)
    writeFileSync(join(artifacts, 'pending-events.jsonl'), pendingBytes)
    writeFileSync(
      join(artifacts, 'pending-meta.json'),
      readFileSync(join(e2eWorkspaceDir(), PROJECT, id, 'meta.json')),
    )
    await $('.project-row*=verification project').click()
    const toggle = $('.automation-threads-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    await $(`.chat-row[data-thread-id="${id}"]`).click()
    await expect($('.messages-list')).toHaveText(expect.stringContaining(PROMPT))
    assert.equal((await $$('.messages-list .tool-card[data-status="done"]')).length, 0)
    const placeholder = await browser.execute((messageId) => {
      const row = document.querySelector(`[data-message-id="${messageId}"]`)
      const body = row?.querySelector('.message-body')
      if (!row || !body) throw new Error('Pending ordering placeholder missing')
      const style = getComputedStyle(row)
      return {
        content: body.textContent,
        bodyHeight: body.getBoundingClientRect().height,
        rowHeight: row.getBoundingClientRect().height,
        verticalPadding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
        background: style.backgroundColor,
        actions: row.querySelectorAll('.msg-reply-actions, .tool-card').length,
      }
    }, orderingPlaceholder.id)
    assert.equal(placeholder.content, '')
    assert.equal(placeholder.bodyHeight, 0)
    assert.equal(placeholder.background, 'rgba(0, 0, 0, 0)')
    assert.equal(placeholder.actions, 0)
    assert.ok(placeholder.rowHeight <= placeholder.verticalPadding + 0.5)
    await expect($('.agent-activity')).toBeDisplayed()
    await expect($('.stop-btn')).toBeDisplayed()
    const restorePendingBranch = await pinBranch(id, 'copse/thread-')
    await parkPointer()
    await saveAppScreenshot('automation-headless-tool-pending.png')
    await restorePendingBranch()

    writeFileSync(join(directory, 'release'), 'finish\n')
    await browser.waitUntil(
      () =>
        meta(id).status === 'idle' &&
        savedMessages(id)
          .flatMap((message) => message.toolCalls)
          .some((call) => call.name === TOOL && call.result !== null),
      {
        timeout: 20_000,
        timeoutMsg: 'the terminal verification result never reached saved history',
      },
    )
    assert.ok(conversation)
    conversation.assertComplete()
    const entered = safeJsonParse(
      readFileSync(join(directory, 'entered.json'), 'utf8'),
      decodeWithSchema(enteredSchema),
    )
    assert.ok(entered)
    assert.equal(entered.calls, 1, 'verification must execute exactly once')
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Verification complete. The project is ready.'),
    )
    await $('.stop-btn').waitForDisplayed({ reverse: true, timeout: 10_000 })
    const restoreCompletedBranch = await pinBranch(id, 'copse/project-verification-')
    const completedCard = $('.messages-list .tool-card[data-status="done"]')
    await completedCard.waitForExist({ timeout: 10_000 })
    if ((await completedCard.getAttribute('open')) === null)
      await completedCard.$('.tool-card-header').click()
    await expect(completedCard).toHaveText(
      expect.stringContaining('Verification completed successfully.'),
    )
    const completedBytes = readFileSync(spine)
    writeFileSync(join(artifacts, 'completed-events.jsonl'), completedBytes)
    writeFileSync(
      join(artifacts, 'receipt.json'),
      JSON.stringify(
        {
          threadId: id,
          actualToolCalls: entered.calls,
          pendingSpineSha256: createHash('sha256').update(pendingBytes).digest('hex'),
          completedSpineSha256: createHash('sha256').update(completedBytes).digest('hex'),
          pendingToolCount: pending.flatMap((message) => message.toolCalls).length,
          pendingPlaceholder: placeholder,
          completed: savedMessages(id).flatMap((message) => message.toolCalls),
          scope: 'Terminal-only persisted history; no live pending-card attachment added',
        },
        null,
        2,
      ) + '\n',
    )
    await parkPointer()
    await saveAppScreenshot('automation-headless-tool-completed.png')
    await restoreCompletedBranch()
  })
})
