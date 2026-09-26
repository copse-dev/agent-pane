import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { threadToJsonl } from '../../src/shared/threads/export-jsonl.ts'

const PROJECT = 'coordination-demo'
const COLLECTOR = 'license-collector'
const LINT = 'notices-staleness-lint'
const OUTPUT = join(process.cwd(), '.tmp/coordination-demo')
const COLLECTOR_PROMPT = 'Run the scripted coordination demo as the license collector.'
const LINT_PROMPT = 'Run the scripted coordination demo as the notices lint task.'

describe('agent coordination in Electron (scripted mock)', () => {
  before(() => {
    mkdirSync(OUTPUT, { recursive: true })
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
  })

  it('runs two concurrent tasks, exchanges real tool notes, and persists their traces', async function () {
    this.timeout(90_000)
    await $(`.chat-row[data-thread-id="${COLLECTOR}"]`).waitForDisplayed({ timeout: 30_000 })
    await $(`.chat-row[data-thread-id="${COLLECTOR}"]`).click()
    await setComposerValue(COLLECTOR_PROMPT)
    await submitComposer()
    await expect($('.tool-card .tool-name')).toHaveText('Checking overlapping work', {
      wait: 20_000,
    })
    await saveAppScreenshot('agent-coordination-waiting.png')

    await $(`.chat-row[data-thread-id="${LINT}"]`).click()
    await setComposerValue(LINT_PROMPT)
    await submitComposer()
    await browser.waitUntil(
      async () =>
        (await $('.messages-list').getText()).includes('Scripted coordination demo — completed'),
      { timeout: 40_000 },
    )
    await waitForAgentIdle()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('I will own the notices file'),
    )
    await saveAppScreenshot('agent-coordination-lint.png')

    await $(`.chat-row[data-thread-id="${COLLECTOR}"]`).click()
    await browser.waitUntil(
      async () => (await $('.messages-list').getText()).includes('I released the notices file'),
      { timeout: 20_000 },
    )
    await waitForAgentIdle()
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Received from peer (untrusted context)'),
    )
    await saveAppScreenshot('agent-coordination-agreement.png')
    const rollup = $('.tool-card-rollup')
    await rollup.$('summary.tool-card-header').click()
    await expect(rollup).toHaveAttribute('open')
    await expect(rollup).toHaveText(expect.stringContaining('Sent peer note'))
    await expect(rollup).toHaveText(expect.stringContaining('Read peer notes'))
    await saveAppScreenshot('agent-coordination-tools.png')

    const threads = await browser.execute(async (project) => {
      const summaries = await window.api.threads.loadProject(project)
      return Promise.all(
        summaries.map(async (thread) => ({
          ...thread,
          messages: await window.api.threads.loadMessages(project, thread.id),
        })),
      )
    }, PROJECT)
    assert.equal(threads.length, 2)
    for (const thread of threads) {
      const calls = thread.messages.flatMap((message) => message.toolCalls ?? [])
      assert.ok(
        calls.some(
          (call) => call.name === 'coordination_note' && call.result?.includes('read-by-peer'),
        ),
      )
      assert.ok(
        calls.some(
          (call) =>
            call.name === 'coordination_read' && call.result?.includes('untrusted-peer-context'),
        ),
      )
      assert.ok(calls.every((call) => call.name.startsWith('coordination_')))
      assert.equal(thread.messages.filter((message) => message.role === 'user').length, 1)
      assert.equal(thread.continuationUsed ?? 0, 0)
      writeFileSync(join(OUTPUT, `${thread.id}.jsonl`), threadToJsonl(thread))
    }
    writeFileSync(join(OUTPUT, 'threads.json'), JSON.stringify(threads, null, 2))
    // Preserve the actual runtime profile for a local replay after WDIO exits.
    const userData = process.env.COPSE_PANEL_USER_DATA
    const workspace = process.env.COPSE_WORKSPACE_DIR
    assert.ok(userData && workspace)
    const profile = join(OUTPUT, 'profile')
    mkdirSync(profile, { recursive: true })
    for (const filename of ['config.json', 'settings.json']) {
      cpSync(join(userData, filename), join(profile, filename))
    }
    cpSync(workspace, join(profile, 'workspace'), { recursive: true })
    assert.ok(
      readFileSync(join(profile, 'workspace', PROJECT, COLLECTOR, 'events.jsonl'), 'utf8').length >
        0,
    )
  })

  after(() => {
    writeE2eEnv({ COPSE_COORDINATION_DEMO: '0' })
    resetUserData()
  })
})
