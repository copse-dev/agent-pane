import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  E2E_WORKSPACE_ROOT,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const READY = join(E2E_WORKSPACE_ROOT, '.e2e-send-now-ready')
const RELEASE = join(E2E_WORKSPACE_ROOT, '.e2e-send-now-release')
const DONE = join(E2E_WORKSPACE_ROOT, '.e2e-send-now-done')
const COMMAND = `node -e "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);fs.writeFileSync(process.argv[3],String(process.pid));console.log('check-completed')}},50)" ${JSON.stringify(READY)} ${JSON.stringify(RELEASE)} ${JSON.stringify(DONE)}`

function removeSignals(): void {
  for (const path of [READY, RELEASE, DONE]) rmSync(path, { force: true })
}

describe('Send now preserves a running shell', function () {
  this.timeout(180_000)
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'e2e-send-now-preserves-shell', {
      subagentsEnabled: false,
    })
    removeSignals()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    writeFileSync(RELEASE, '')
    resetUserData()
  })

  it('Ctrl+Enter sends the queue and the original process completes in the background', async () => {
    const scenario = await installMockScenario({
      title: 'Send queued follow-up while a check continues',
      turns: [
        {
          user: 'Run the workspace check.',
          allowAbort: true,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: COMMAND, timeout_ms: 60_000 } }] },
            { text: 'The workspace check has completed.' },
          ],
        },
        {
          user: 'Please explain what you are checking.',
          responses: [
            {
              text: 'The workspace check continues in the background while I answer your question.',
            },
          ],
        },
      ],
    })
    await setComposerValue('Run the workspace check.')
    await submitComposer()
    await browser.waitUntil(
      async () => {
        const dialog = $('#approval-dialog')
        if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true)
          await dialog.$('.approval-approve').click()
        return existsSync(READY)
      },
      { timeout: 30_000, interval: 100, timeoutMsg: 'foreground command did not start' },
    )
    const originalPid = readFileSync(READY, 'utf8')
    await setComposerValue('Please explain what you are checking.')
    await submitComposer()
    await expect($('.conversation-queued .queued-send-now')).toBeDisplayed()
    await $('.prompt-input').click()
    await browser.keys(['Control', 'Enter'])
    await expectAssistantReply(
      'The workspace check continues in the background while I answer your question.',
    )
    await expect($('.conversation-queued .queued-send-now')).not.toBeExisting()
    writeFileSync(RELEASE, '')
    await browser.waitUntil(() => existsSync(DONE), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Send now cancelled the running command',
    })
    assert.equal(
      readFileSync(DONE, 'utf8'),
      originalPid,
      'the original process must complete, without a restart',
    )
    await scenario.assertComplete()
    await saveAppScreenshot('send-now-preserves-shell.png')
    removeSignals()
  })
  it('dismisses an unanswered dangerous rm after two minutes and continues without deleting', async () => {
    const output = join(E2E_WORKSPACE_ROOT, '.e2e-rm-timeout-output')
    const marker = join(output, 'keep.txt')
    mkdirSync(output, { recursive: true })
    writeFileSync(marker, 'must survive the safety timeout')
    try {
      const scenario = await installMockScenario({
        title: 'Dangerous rm confirmation deadline',
        turns: [
          {
            user: 'Clean up the temporary build output.',
            responses: [
              {
                toolCalls: [
                  { name: 'run_shell', args: { command: 'rm -rf .e2e-rm-timeout-output' } },
                ],
              },
              {
                expectToolResults: [{ name: 'run_shell', includes: 'timed out after two minutes' }],
                text: 'The safety confirmation timed out. I will continue with safer work and rewrite the cleanup command.',
              },
            ],
          },
        ],
      })
      await setComposerValue('Clean up the temporary build output.')
      await submitComposer()
      const dialog = $('#approval-dialog')
      await browser.waitUntil(
        async () => (await dialog.isExisting()) && (await dialog.getProperty('open')) === true,
        {
          timeout: 15_000,
          interval: 100,
          timeoutMsg: 'expected the dangerous rm safety confirmation',
        },
      )
      await expect(dialog).toHaveText(expect.stringContaining('rm -rf .e2e-rm-timeout-output'))
      await browser.waitUntil(async () => (await dialog.getProperty('open')) !== true, {
        timeout: 135_000,
        interval: 500,
        timeoutMsg: 'the dangerous rm prompt stalled the run',
      })
      await expectAssistantReply(
        'The safety confirmation timed out. I will continue with safer work and rewrite the cleanup command.',
      )
      assert.equal(readFileSync(marker, 'utf8'), 'must survive the safety timeout')
      await scenario.assertComplete()
      await saveAppScreenshot('rm-safety-timeout.png')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
