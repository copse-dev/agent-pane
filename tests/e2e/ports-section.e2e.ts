import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { approveUnsandboxedTerminalIfPrompted } from './helpers/terminal-approval.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { E2E_SCREENSHOT_DIR, prepareE2eScreenshot } from './helpers/screenshot.ts'

// Ports are discovered by scanning the host, and the CI image has neither `ss`
// nor `lsof` — so this spec seeds the rows main would have produced. What it
// proves is the section: that it sits in the Terminal rail, which rows are
// actionable, which are inert, and that the two look different at a glance.
// Attribution itself is unit-tested against a synthetic process tree in
// ports-registry.test.ts.
const SEEDED_ROWS = [
  {
    port: 3000,
    pid: 4242,
    command: 'node',
    address: '127.0.0.1',
    owner: { kind: 'background', id: 'task-1', label: 'npm run dev' },
    url: 'http://localhost:3000',
  },
  {
    port: 5173,
    pid: 4300,
    command: 'vite',
    address: '::1',
    owner: { kind: 'terminal', id: 'session-1', label: 'Terminal 1' },
    url: 'http://localhost:5173',
  },
  {
    port: 5432,
    pid: 900,
    command: 'postgres',
    address: '192.168.1.20',
    owner: null,
    url: null,
  },
]

async function seedPortRows(rows: unknown): Promise<void> {
  await browser.execute(async (seeded) => {
    const bridge = (
      window as unknown as { __copseE2e?: { setPortRows: (rows: unknown) => Promise<unknown> } }
    ).__copseE2e
    if (!bridge) throw new Error('__copseE2e unavailable')
    await bridge.setPortRows(seeded)
  }, rows)
}

describe('ports section', function () {
  this.timeout(120_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ports-project')
    await browser.reloadSession()
    await $('#input-bar').waitForExist({ timeout: 30_000 })
    await seedPortRows(SEEDED_ROWS)

    // Ports live under Terminal, so the pane has to be open for any of this.
    await $('.titlebar-btn[aria-label="Open terminal"]').click()
    await approveUnsandboxedTerminalIfPrompted()
  })

  it('lists listening ports in the terminal rail, marking the ones Copse can act on', async () => {
    const rows = $$('.ports-row')
    await browser.waitUntil(async () => (await rows.length) === SEEDED_ROWS.length, {
      timeout: 20_000,
      timeoutMsg: 'expected the seeded ports to render in the terminal rail',
    })

    // The section sits inside the Terminal tab's left rail, not its own pane.
    assert.equal(
      await $('#terminals-list-host .ports-section').isDisplayed(),
      true,
      'ports section should live in the terminal rail',
    )

    // Owned rows sort first and carry a badge; the foreign one carries none.
    const ordered = await $$('.ports-row').map((row) => row.getAttribute('data-port'))
    assert.deepEqual(ordered, ['3000', '5173', '5432'])
    assert.equal(await $('.ports-row[data-port="3000"] .ports-row-owner').getText(), 'Task')
    assert.equal(await $('.ports-row[data-port="5173"] .ports-row-owner').getText(), 'Shell')
    assert.equal(await $('.ports-row[data-port="5432"] .ports-row-owner').isExisting(), false)

    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'ports-section-list.png'))
    await assertNoErrorToasts('ports section list')
  })

  it('expands an owned port in place, with open and kill', async () => {
    await $('.ports-row[data-port="3000"]').click()
    await $('.ports-detail').waitForExist({ timeout: 10_000 })

    assert.equal(await $('.ports-open-btn').isExisting(), true)
    assert.equal(await $('.ports-kill-btn').isExisting(), true)
    assert.match(await $('.ports-detail').getText(), /npm run dev/)

    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'ports-section-owned.png'))
    await assertNoErrorToasts('ports section owned row')
  })

  it('offers neither for a port Copse did not start, and says why', async () => {
    await $('.ports-row[data-port="5432"]').click()
    await $('.ports-detail-note').waitForExist({ timeout: 10_000 })

    assert.equal(await $('.ports-kill-btn').isExisting(), false)
    // Bound to a specific interface, so there is no loopback URL to open either.
    assert.equal(await $('.ports-open-btn').isExisting(), false)
    assert.match(await $('.ports-detail-note').getText(), /only stops processes it started/)

    await prepareE2eScreenshot()
    await browser.saveScreenshot(join(E2E_SCREENSHOT_DIR, 'ports-section-foreign.png'))
    await assertNoErrorToasts('ports section foreign row')
  })

  it('opens the port in the browser pane', async () => {
    await $('.ports-row[data-port="3000"]').click()
    await $('.ports-open-btn').click()

    await browser.waitUntil(async () => $('#browser-tabs-host').isDisplayed(), {
      timeout: 15_000,
      timeoutMsg: 'expected the browser pane to take over the right panel',
    })
    await assertNoErrorToasts('ports section open in browser')
  })
})
