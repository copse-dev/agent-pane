import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '../../src/shared/safe-json.ts'
import { INTERRUPTED_TURN_CONTINUATION } from '../../src/shared/turn-recovery.ts'
import { continuationBudgetExhaustedSummary } from '../../src/main/services/continuation-budget-summary.ts'
import type { TodoItem } from '../../src/shared/types/todo.ts'
import {
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { parkPointer, saveAppScreenshot } from './helpers/screenshot.ts'
import { frameInTranscript } from './helpers/sticky-prompt.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT = 'e2e-budget-recovery'
const MODEL = 'budget-fixture:chat'
const PROMPT = 'Write each migration phase checkpoint, then finish the migration.'
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
})

function respond(
  response: ServerResponse,
  text: string,
  call?: { id: string; name: string; args: Record<string, unknown> },
): void {
  const delta = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { content: text }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.end(
    `data: ${JSON.stringify({ id: 'budget-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
}

describe('productive run budget and explicit checkpoint continuation', function () {
  this.timeout(240_000)
  let root = ''
  let baseUrl = ''
  let calls = 0
  let continuationCalls = 0
  let continuing = false
  const failures: string[] = []
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [{ id: 'chat' }, { id: 'titles' }] }))
        return
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      let body = ''
      request.setEncoding('utf8')
      for await (const part of request) {
        body += String(part)
        assert.ok(body.length < 2_000_000)
      }
      const parsed = safeJsonParse(body, decodeWithSchema(requestSchema))
      assert.ok(parsed)
      if (parsed.model === 'titles') {
        respond(response, 'Migration checkpoint recovery')
        return
      }
      assert.equal(parsed.model, 'chat')
      if (continuing) {
        continuationCalls += 1
        const latestUser = parsed.messages.findLast((message) => message.role === 'user')
        if (continuationCalls === 1)
          assert.equal(latestUser?.content, INTERRUPTED_TURN_CONTINUATION)
        respond(response, 'Continued from the saved phases without replaying a completed write.')
        return
      }
      calls += 1
      if (calls <= 50) {
        respond(response, '', {
          id: `migration-${String(calls)}`,
          name: 'write_file',
          args: {
            path: `phase-${String(calls)}.txt`,
            content: `Phase ${String(calls)} completed once.\n`,
          },
        })
      } else {
        assert.equal(calls, 51, 'The native run must pause after its two existing extensions')
        respond(response, '')
      }
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: failures.at(-1) } }))
    })
  })

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-native-budget-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: root })
    writeFileSync(join(root, 'README.txt'), 'Synthetic migration fixture\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@copse.invalid',
        'commit',
        '-m',
        'Synthetic baseline',
      ],
      { cwd: root },
    )
    baseUrl = await new Promise<string>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        resolve(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '0', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })
    resetUserData()
    seedEmptyProject(root, PROJECT)
    writeSettings({
      model: MODEL,
      smallTasksModel: 'budget-fixture:titles',
      nextStepSuggestionEnabled: false,
      extraProviders: [
        {
          slug: 'budget-fixture',
          label: 'Local test model',
          baseUrl,
          models: [{ id: 'chat' }, { id: 'titles' }],
        },
      ],
      subagentsEnabled: false,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    writeE2eEnv({ COPSE_PANEL_MOCK_LLM: '1' })
    resetUserData()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      }),
    )
    if (root) removeE2eTree(root)
  })

  it('keeps fifty applied writes and offers a bounded human continuation instead of claiming completion', async () => {
    await setComposerValue(PROMPT)
    await submitComposer()
    await $('[data-turn-recovery-card]').waitForDisplayed({ timeout: 180_000 })
    await waitForAgentIdle(15_000)
    assert.deepEqual(failures, [])
    assert.equal(calls, 51)
    const phases = readdirSync(root).filter((name) => /^phase-\d+\.txt$/.test(name))
    assert.equal(phases.length, 50)
    assert.equal(readFileSync(join(root, 'phase-1.txt'), 'utf8'), 'Phase 1 completed once.\n')
    const checkpointTime = statSync(join(root, 'phase-1.txt')).mtimeMs
    const card = $('[data-turn-recovery-card]')
    await expect(card.$('.turn-recovery-title')).toHaveText('RUN LIMIT REACHED')
    await expect(card).toHaveText(expect.stringContaining('Your completed work is saved.'))
    await expect(card.$('.turn-recovery-button')).toHaveText('Continue task')
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('step limit before finishing'),
    )
    await parkPointer()
    await saveAppScreenshot('run-budget-checkpoint-paused.png')
    continuing = true
    await card.$('.turn-recovery-button').click()
    await waitForAgentIdle(30_000)
    assert.equal(continuationCalls, 1)
    assert.equal(statSync(join(root, 'phase-1.txt')).mtimeMs, checkpointTime)
    assert.equal(readdirSync(root).filter((name) => /^phase-\d+\.txt$/.test(name)).length, 50)
    await expect($('[data-turn-recovery-card]')).not.toExist()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('without replaying a completed write'),
    )
    assert.deepEqual(failures, [])
    await parkPointer()
    await saveAppScreenshot('run-budget-explicitly-continued.png')
  })

  it('names a persisted deadline and keeps its continuation action visible', async () => {
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'workspace' }],
      activeProjectId: PROJECT,
      activeThreadId: 'budget-timeout-thread',
      [`threads:${PROJECT}`]: [
        {
          id: 'budget-timeout-thread',
          title: 'Migration time limit',
          status: 'idle',
          model: MODEL,
          messages: [
            {
              id: 'timeout-user',
              role: 'user',
              content: 'Finish the migration.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'timeout-assistant',
              role: 'assistant',
              content: 'The completed migration phases are saved.',
              model: MODEL,
              toolCalls: [],
              createdAt: now + 1,
              turnOutcome: {
                status: 'failed',
                stopReason: 'timeout',
                source: 'host',
                executor: 'local',
                provider: 'budget-fixture',
                model: MODEL,
                endedAt: now + 1,
              },
            },
          ],
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
    const card = $('[data-turn-recovery-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    await expect(card.$('.turn-recovery-title')).toHaveText('TIME LIMIT REACHED')
    await expect(card.$('.turn-recovery-button')).toHaveText('Continue task')
    await parkPointer()
    await saveAppScreenshot('run-budget-deadline-recovery.png')
  })

  it('keeps the persisted remaining plan and grant summary visible beside explicit recovery', async () => {
    const now = Date.now()
    const todos: TodoItem[] = [
      { id: 'migration', content: 'Migrate the remaining modules', status: 'in_progress' },
      { id: 'tests', content: 'Add the regression tests', status: 'pending' },
    ]
    const summary = continuationBudgetExhaustedSummary(
      todos,
      {
        'todo-closeout': 3,
        'pre-review-todo': 2,
        'post-review-remediation': 0,
      },
      { remaining: 0, aborted: false, failed: false },
    )
    assert.ok(summary)
    writeSeedConfig({
      projects: [{ id: PROJECT, path: root, name: 'workspace' }],
      activeProjectId: PROJECT,
      activeThreadId: 'budget-plan-thread',
      [`threads:${PROJECT}`]: [
        {
          id: 'budget-plan-thread',
          title: 'Remaining migration plan',
          status: 'idle',
          model: MODEL,
          todos,
          messages: [
            {
              id: 'plan-user',
              role: 'user',
              content: 'Finish the migration and regression tests.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'plan-assistant',
              role: 'assistant',
              content: `\n\n${summary}`,
              model: MODEL,
              toolCalls: [],
              createdAt: now + 1,
              turnOutcome: {
                status: 'failed',
                stopReason: 'max_steps',
                source: 'host',
                executor: 'local',
                provider: 'budget-fixture',
                model: MODEL,
                endedAt: now + 1,
              },
            },
          ],
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    await browser.reloadSession()
    const card = $('[data-turn-recovery-card]')
    await card.waitForDisplayed({ timeout: 30_000 })
    await expect(card.$('.turn-recovery-title')).toHaveText('RUN LIMIT REACHED')
    await expect(card.$('.turn-recovery-button')).toHaveText('Continue task')
    const transcript = $('.messages-list')
    await expect(transcript).toHaveText(
      expect.stringContaining('automatic continuation limit of 5'),
    )
    await expect(transcript).toHaveText(
      expect.stringContaining('In progress: Migrate the remaining modules'),
    )
    await expect(transcript).toHaveText(
      expect.stringContaining('Pending: Add the regression tests'),
    )
    await expect(transcript).toHaveText(expect.stringContaining('todo closeout: 3'))
    await expect(transcript).toHaveText(
      expect.stringContaining('pre-review plan reconciliation: 2'),
    )
    await parkPointer()
    await saveAppScreenshot('run-budget-exhausted-plan-summary.png')
    await saveAppScreenshot('run-budget-exhausted-plan-recovery.png', undefined, async () => {
      const frame = await frameInTranscript(['[data-turn-recovery-card]'])
      assert.ok(frame.fits, `the recovery card must fit the transcript: ${JSON.stringify(frame)}`)
      const bounds = await browser.execute(() => {
        const recovery = document.querySelector('[data-turn-recovery-card]')
        const list = document.querySelector('.messages-list')
        const app = document.getElementById('app')
        const composer = document.getElementById('input-bar')
        const button = recovery?.querySelector('button')
        if (!recovery || !list || !app || !composer || !button)
          throw new Error('The recovery view is missing')
        const cardRect = recovery.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        const appRect = app.getBoundingClientRect()
        const composerRect = composer.getBoundingClientRect()
        const buttonRect = button.getBoundingClientRect()
        return {
          top: cardRect.top,
          bottom: cardRect.bottom,
          cardHeight: cardRect.height,
          cardClientHeight: recovery.clientHeight,
          cardScrollHeight: recovery.scrollHeight,
          visibleTop: Math.max(listRect.top, appRect.top),
          visibleBottom: Math.min(listRect.bottom, appRect.bottom, composerRect.top),
          listTop: listRect.top,
          listBottom: listRect.bottom,
          listClientHeight: list.clientHeight,
          listScrollHeight: list.scrollHeight,
          listScrollTop: list.scrollTop,
          listOverflow: getComputedStyle(list).overflowY,
          appTop: appRect.top,
          appBottom: appRect.bottom,
          appWidth: appRect.width,
          appHeight: appRect.height,
          composerTop: composerRect.top,
          buttonTop: buttonRect.top,
          buttonBottom: buttonRect.bottom,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
        }
      })
      // Match frameInTranscript's one-pixel allowance for fractional scroll rounding.
      assert.ok(
        bounds.top >= bounds.visibleTop - 1 && bounds.bottom <= bounds.visibleBottom + 1,
        `the complete recovery card must fit the captured scrollport after resize: ${JSON.stringify(bounds)}`,
      )
      assert.ok(
        bounds.buttonTop >= bounds.visibleTop && bounds.buttonBottom <= bounds.visibleBottom,
        `Continue task must be fully visible: ${JSON.stringify(bounds)}`,
      )
    })
  })
})
