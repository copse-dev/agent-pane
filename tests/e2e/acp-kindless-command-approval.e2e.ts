import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

const AGENT_TITLE = 'Kind-less fixture agent'
const ROUTE = 'acp:kindless-fixture#fixture-sonnet'
const OTHER_REMEMBER = `Always allow ${AGENT_TITLE} "other" tool calls`

/** The fixture agent's reports of the client's answers, oldest first. */
function agentReports(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('.messages-list .message-text')]
      .map((node) => node.textContent.trim())
      .filter((text) => text.startsWith('client ')),
  )
}

async function waitForReports(expected: string[]): Promise<void> {
  await browser.waitUntil(async () => (await agentReports()).length >= expected.length, {
    timeout: 30_000,
    timeoutMsg: `The agent should report ${String(expected.length)} answer(s)`,
  })
  // The transcript reveals streamed text gradually, so the newest report can
  // be read part-way through ("client answered a"). Let it finish, then
  // compare, so a wrong answer still fails with its diff.
  await browser
    .waitUntil(async () => isDeepStrictEqual(await agentReports(), expected), { timeout: 10_000 })
    .catch(() => undefined)
  assert.deepEqual(await agentReports(), expected)
}

// A real ACP agent process (tests/fixtures/mock-acp-agent.mjs) sends
// permission requests that omit ACP's optional tool `kind`. Neither request
// runs anything; the agent only reports the answer it got.
describe('kind-less ACP permission requests', function () {
  this.timeout(120_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-kindless-bin-'))
    const windows = process.platform === 'win32'
    const fixturePath = join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')
    const executable = join(fixtureBin, windows ? 'fixture-acp.cmd' : 'fixture-acp')
    writeFileSync(
      executable,
      windows
        ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
        : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fixturePath).href)})\n`,
    )
    if (!windows) chmodSync(executable, 0o755)
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [
        fixtureBin,
        ...(windows
          ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
          : ['/usr/bin', '/bin']),
      ].join(delimiter),
    })
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-kindless-command', {
      model: ROUTE,
      registeredAcpAgents: [
        // Keep an ambient Codex CLI's adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'kindless-fixture',
          title: AGENT_TITLE,
          command: 'fixture-acp',
          enabled: true,
          model: 'fixture-sonnet',
          availableModels: [{ value: 'fixture-sonnet', label: 'Fixture model' }],
          modelsProbedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: originalPreservePath, PATH: originalPath })
    resetUserData()
    if (fixtureBin) removeE2eTree(fixtureBin)
  })

  it('remembers a kind-less tool call but still gates a kind-less shell command', async () => {
    const dialog = $('#approval-dialog')
    const remember = dialog.$('.approval-remember:not(.approval-turn-tree)')

    // A kind-less request without a command gets the generic prompt, which can
    // remember the agent's "other" tool calls.
    await setComposerValue('ask')
    await submitComposer()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(`Run a tool? — ${AGENT_TITLE}`)
    await expect(remember).toBeDisplayed()
    await expect(remember).toHaveText(OTHER_REMEMBER)
    await remember.$('.approval-remember-input').click()
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForReports(['client answered allow'])

    // That grant answers the next request of the same shape without a prompt.
    await setComposerValue('ask again')
    await submitComposer()
    await waitForReports(['client answered allow', 'client answered allow'])
    await expect(dialog).not.toBeDisplayed()

    // A kind-less request carrying `rm -rf build` is a shell command: the shell
    // gate classifies and asks despite the stored grant, and offers no remember.
    await setComposerValue('run-kindless')
    await submitComposer()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Run shell command?')
    await expect(dialog.$('.approval-body-code')).toHaveText('rm -rf build')
    await expect(dialog).toHaveText(
      expect.stringContaining('Deletes files and folders recursively (rm -rf)'),
    )
    await expect(remember).not.toBeDisplayed()
    await saveElementScreenshot('#approval-dialog', 'acp-kindless-command-approval.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForReports([
      'client answered allow',
      'client answered allow',
      'client answered reject',
    ])
  })
})
