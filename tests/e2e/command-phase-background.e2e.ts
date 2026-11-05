import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { installMockScenario } from './helpers/mock-scenario.ts'
import {
  E2E_WORKSPACE_ROOT,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT_ID = 'e2e-command-phase-background'
const SIGNAL = join(E2E_WORKSPACE_ROOT, '.e2e-command-phase-background-done')
// Prints a line straight away, then waits for the spec's signal and exits 3, so
// the task is still running when its turn ends and exits only afterwards.
const COMMAND = `node -e "const fs=require('node:fs');console.log('suite: 12 passed, 1 failing');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);process.exit(3)}},50)" ${JSON.stringify(SIGNAL)}`
const USER = 'Run the full suite in the background and tell me when it finishes.'
// Resolved once the call exists: the card of the one command with a phase.
let CARD = ''

async function findCommandCard(): Promise<string> {
  let id: string | null = null
  await browser.waitUntil(
    async () => {
      id = await browser.execute(
        () =>
          document
            .querySelector('.tool-command-phase')
            ?.closest<HTMLElement>('details.tool-card[data-tool-id]')
            ?.getAttribute('data-tool-id') ?? null,
      )
      return id !== null
    },
    { timeout: 30_000, interval: 100, timeoutMsg: 'expected the command card' },
  )
  return `details.tool-card[data-tool-id="${String(id)}"]`
}

/** Open every disclosure around the command card, and the card itself. */
async function openCommandCard(): Promise<void> {
  await browser.execute((selector) => {
    const card = document.querySelector<HTMLDetailsElement>(selector)
    for (let node = card?.parentElement; node; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement) node.open = true
    }
    if (card && !card.open) card.querySelector<HTMLElement>(':scope > summary')?.click()
  }, CARD)
  await $(`${CARD} .tool-task-logs`).waitForExist({ timeout: 10_000 })
}

async function expectCardPhase(state: string, text: string | RegExp): Promise<void> {
  const label = $(`${CARD} > summary .tool-command-phase`)
  await browser.waitUntil(
    async () => {
      if (!(await label.isExisting())) return false
      // textContent, not getText: the card may sit inside a closed rollup.
      const seen = String(await label.getProperty('textContent'))
      const matches = typeof text === 'string' ? seen === text : text.test(seen)
      return matches && (await label.getAttribute('data-phase')) === state
    },
    { timeout: 30_000, interval: 100, timeoutMsg: `expected the card to read ${String(text)}` },
  )
}

describe('a background command after its turn ends (#3956)', function () {
  this.timeout(120_000)

  before(async () => {
    rmSync(SIGNAL, { force: true })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeFileSync(SIGNAL, '')
    rmSync(SIGNAL, { force: true })
    resetUserData()
  })

  it('links the task output, records its exit on the card, and points the wake back to it', async () => {
    await installMockScenario({
      title: 'Background suite',
      turns: [
        {
          user: USER,
          responses: [
            {
              toolCalls: [
                {
                  name: 'run_background',
                  args: {
                    action: 'start',
                    command: COMMAND,
                    wake_on_completion: true,
                    timeout_ms: 60_000,
                  },
                },
              ],
            },
            { text: 'The suite is running in the background.' },
          ],
        },
        {
          user: { includes: 'exited with code 3' },
          responses: [{ text: 'The suite finished with one failing test.' }],
        },
      ],
    })
    await setComposerValue(USER)
    await submitComposer()
    await browser.waitUntil(
      async () => {
        const stop = $('.stop-btn')
        return (await stop.isExisting()) && (await stop.getProperty('hidden')) !== true
      },
      { timeout: 15_000, interval: 100, timeoutMsg: 'the agent did not start' },
    )
    // Approve the start wherever this host prompts for it.
    await browser.waitUntil(
      async () => {
        const dialog = $('#approval-dialog')
        if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
          await dialog.$('.approval-approve').click()
        }
        return (await $('.stop-btn').getProperty('hidden')) === true
      },
      { timeout: 30_000, interval: 100, timeoutMsg: 'the first turn did not finish' },
    )
    await waitForAgentIdle(30_000)
    CARD = await findCommandCard()

    // The turn is over and the task still runs: the card names it.
    await openCommandCard()
    await expectCardPhase('running', /^Background task \S+$/)
    await $(`${CARD} .tool-task-logs-button`).click()
    const output = $(`${CARD} .tool-task-logs-output pre`)
    await output.waitForExist({ timeout: 10_000 })
    await expect(output).toHaveText('suite: 12 passed, 1 failing')
    await expect($(`${CARD} .tool-task-logs-button`)).toHaveText('Refresh logs')
    await saveElementScreenshot(CARD, 'command-phase-background-logs.png')

    // The task exits after its turn: the card that started it says how.
    const assistants = (await $$('.msg-assistant').getElements()).length
    writeFileSync(SIGNAL, '')
    await expectCardPhase('exited', 'Exit 3')
    await browser.waitUntil(
      async () => (await $$('.msg-assistant').getElements()).length === assistants + 1,
      { timeout: 30_000, interval: 100, timeoutMsg: 'the completion wake did not answer' },
    )
    await waitForAgentIdle(30_000)

    // The wake points back at that card, which keeps its last observed state.
    const wake = $('.msg-machine-origin')
    const showCommand = wake.$('.msg-origin-command-link')
    await expect(showCommand).toHaveText('Show command')
    await browser.execute((selector) => {
      const card = document.querySelector<HTMLDetailsElement>(selector)
      for (let node: HTMLElement | null = card; node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = false
      }
    }, CARD)
    await showCommand.click()
    await browser.waitUntil(
      async () =>
        (await $(CARD).isDisplayed({ withinViewport: true })) &&
        ((await $(CARD).getAttribute('class')) ?? '').includes('tool-card-revealed'),
      { timeout: 5_000, interval: 50, timeoutMsg: 'Show command did not reveal the card' },
    )
    await expectCardPhase('exited', 'Exit 3')
    // Wait out the reveal outline so the capture is the card's settled look.
    await browser.waitUntil(
      async () => !((await $(CARD).getAttribute('class')) ?? '').includes('tool-card-revealed'),
      { timeout: 5_000, interval: 100 },
    )
    await saveElementScreenshot('.messages-list', 'command-phase-background-exited.png')

    // Written to disk, not just drawn: a reloaded window reads the same ending.
    await browser.execute(() => {
      window.location.reload()
    })
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(CARD).waitForExist({ timeout: 30_000 })
    await expectCardPhase('exited', 'Exit 3')
  })
})
