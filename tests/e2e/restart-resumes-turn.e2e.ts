import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedStableWorkspace,
  seedLastRun,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

/**
 * A turn cut off by a quit, an update relaunch or a crash continues by itself on
 * the next launch (`src/main/services/interrupted-turn-resume.ts`). The fixture is
 * the state such an exit leaves on disk: the thread still `running`, its answer
 * partly written and no outcome. Launching Copse on it must add one restart
 * continuation, finish the turn and settle the thread, with no click.
 */

const PROJECT_ID = 'e2e-restart-resumes-turn'
const THREAD_ID = 'e2e-restart-resumes-turn-thread'
const PROMPT = 'Summarise the plan in PLAN.md.'
const PARTIAL = 'The plan has three steps. First'
const RESUME_NOTE = 'Copse restarted during this turn. Continuing where it stopped.'

const metaSchema = z.looseObject({ status: z.string() })

function persistedStatus(): string | undefined {
  try {
    const raw = readFileSync(join(e2eWorkspaceDir(), PROJECT_ID, THREAD_ID, 'meta.json'), 'utf8')
    return safeJsonParse(raw, decodeWithSchema(metaSchema))?.status
  } catch {
    return undefined
  }
}

describe('a turn cut off by the last exit', function () {
  this.timeout(120_000)

  before(async () => {
    resetUserData()
    const now = Date.now() - 60_000
    writeSeedConfig({
      projects: [
        {
          id: PROJECT_ID,
          path: seedStableWorkspace({
            files: { 'PLAN.md': '1. build\n2. test\n3. ship\n' },
          }),
          name: 'workspace',
        },
      ],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREAD_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'Summarise the plan',
          status: 'running',
          model: 'claude-sonnet-4-6',
          messages: [
            {
              id: 'cut-off-prompt',
              role: 'user',
              content: PROMPT,
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'cut-off-answer',
              role: 'assistant',
              content: PARTIAL,
              toolCalls: [],
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 1,
        },
      ],
    })
    writeSettings({ model: 'claude-sonnet-4-6', subagentsEnabled: false })
    // The run that left the thread running crashed after it started, so this
    // launch continues it (`last-run.ts`); a quit the user chose would not.
    seedLastRun({ startedAt: now - 60_000 })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('continues on launch and settles the thread', async () => {
    await $('.chat-row.selected').waitForExist({ timeout: 30_000 })
    const note = $('.msg-user.msg-machine-origin')
    await note.waitForExist({
      timeout: 60_000,
      timeoutMsg: 'the cut-off turn was not continued on launch',
    })
    assert.equal((await note.$('.message-text').getText()).trim(), RESUME_NOTE)

    await browser.waitUntil(() => persistedStatus() === 'idle', {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: 'the resumed turn did not finish',
    })
    // The original prompt and partial answer stay; the continuation follows them once.
    const users = await $$('.msg-user .message-text').map((el) => el.getText())
    assert.deepEqual(
      users.map((text) => text.trim()),
      [PROMPT, RESUME_NOTE],
    )
    const answers = await $$('.msg-assistant .message-text').map((el) => el.getText())
    assert.equal(answers[0]?.trim(), PARTIAL)
    assert.ok(answers.length >= 2, 'the resumed turn wrote an answer')

    // No screenshot: mock scenarios live in the app process, so none can be
    // installed before a restart resume claims the model, and the mock's
    // fallback reply is refused by the screenshot guard. The note reuses the
    // existing machine-origin bubble; its copy is asserted above.
  })
})
