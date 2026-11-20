import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

// A real ACP agent process (tests/fixtures/mock-acp-agent.mjs, `stop-mid-command`)
// starts a command, then replies while it still runs, so the reply streams into
// a later bubble than the command's card. Stop cancels the command: the host
// records the call as a cancelled error, and the user-cancel outcome lands on
// the reply, not on the card's bubble. The transcript keeps unchanged bubbles
// across a reconcile (transcript-rows.ts), so the card's bubble must still be
// redrawn for the interruption: it used to be kept, showing the raw error.

const ROUTE = 'acp:stop-fixture#fixture-sonnet'
const CARD = '.messages-list [data-tool-id="mock-tool-long-check"]'
const REPLY = 'The long check is running; it takes a few minutes.'

describe('Stop interrupts a running command on an earlier bubble', function () {
  this.timeout(120_000)
  const originalPath = process.env['PATH']
  const originalPreservePath = process.env['COPSE_PRESERVE_PATH']
  let fixtureBin = ''

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-acp-stop-bin-'))
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
    seedEmptyProject(seedStableWorkspace(), 'e2e-acp-stop-interrupted-card', {
      model: ROUTE,
      registeredAcpAgents: [
        // Keep an ambient Codex CLI's adapter-install approval out of this journey.
        { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: false },
        {
          id: 'stop-fixture',
          title: 'Stop fixture agent',
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

  it('shows the cancelled command as interrupted, not as an error', async () => {
    await setComposerValue('stop-mid-command')
    await submitComposer()

    // The command is running and the reply has streamed in after it.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (card, reply) => {
            const status = document.querySelector(card)?.getAttribute('data-status')
            const replies = [...document.querySelectorAll('.messages-list .msg-assistant')]
            return status === 'running' && replies.some((msg) => msg.textContent.includes(reply))
          },
          CARD,
          REPLY,
        ),
      { timeout: 30_000, timeoutMsg: 'expected the running command and the streamed reply' },
    )
    // The state this covers: the card's bubble is not the one the reply (and so
    // the turn's outcome) lands on.
    const separate = await browser.execute(
      (card, reply) => {
        const cardMsg = document.querySelector(card)?.closest<HTMLElement>('.msg')
        const replyMsg = [...document.querySelectorAll<HTMLElement>('.messages-list .msg')].find(
          (msg) => msg.textContent.includes(reply),
        )
        return cardMsg !== undefined && cardMsg !== null && replyMsg !== cardMsg
      },
      CARD,
      REPLY,
    )
    expect(separate).toBe(true)

    await $('.stop-btn').click()
    // Settled: the turn is over and the card has its final status.
    await $('.stop-btn').waitForDisplayed({ reverse: true, timeout: 30_000 })
    await browser.waitUntil(
      async () =>
        browser.execute(
          (card) => document.querySelector(card)?.getAttribute('data-status') === 'interrupted',
          CARD,
        ),
      {
        timeout: 15_000,
        timeoutMsg: 'expected the cancelled command to read as interrupted, not as an error',
      },
    )

    const status = await browser.execute(
      (card) => document.querySelector(card)?.getAttribute('data-status') ?? null,
      CARD,
    )
    expect(status).toBe('interrupted')

    await saveElementScreenshot('.messages-list', 'acp-stop-interrupted-earlier-card.png')
  })
})
