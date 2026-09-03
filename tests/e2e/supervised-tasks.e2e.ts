import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, writeSeedSupervisedTask } from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'

const SEEDED_PORTS = [
  {
    port: 3000,
    pid: 4242,
    command: 'node',
    address: '127.0.0.1',
    owner: { kind: 'background', id: 'task-1', label: 'npm run dev' },
    url: 'http://localhost:3000',
  },
  {
    port: 5432,
    pid: 900,
    command: 'postgres',
    address: '127.0.0.1',
    owner: null,
    url: 'http://localhost:5432',
  },
]

const PROJECT_ID = 'e2e-supervised-tasks'

interface SectionHeights {
  root: number
  shells: number
  background: number
  ports: number
  shellMin: number
  backgroundMin: number
  portsMin: number
}

function readSectionHeights(): Promise<SectionHeights> {
  return browser.execute(() => {
    const root = document.getElementById('terminals-list-host')
    const shells = document.querySelector<HTMLElement>('.terminal-shells-section')
    const background = document.querySelector<HTMLElement>('.supervised-tasks-section')
    const ports = document.querySelector<HTMLElement>('.ports-section')
    if (!root || !shells || !background || !ports) throw new Error('terminal rail is incomplete')
    return {
      root: root.getBoundingClientRect().height,
      shells: shells.getBoundingClientRect().height,
      background: background.getBoundingClientRect().height,
      ports: ports.getBoundingClientRect().height,
      shellMin: Number.parseFloat(getComputedStyle(shells).minHeight),
      backgroundMin: Number.parseFloat(getComputedStyle(background).minHeight),
      portsMin: Number.parseFloat(getComputedStyle(ports).minHeight),
    }
  })
}

describe('supervised task list', function () {
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(process.cwd(), PROJECT_ID)
    writeSeedSupervisedTask({
      taskId: 'waiting-long-task',
      projectId: PROJECT_ID,
      threadId: 'thread-1',
      handler: 'long_horizon_continue',
      provenance: 'agent',
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1,
      trigger: { kind: 'event', event: 'test:continue' },
      permissionSnapshot: {
        capturedAt: 1,
        autoRunSandboxCommands: false,
        projectSandboxEnabled: false,
      },
      reapproveOnWake: false,
      concurrencyClass: 'agent',
      attempt: 0,
      maxAttempts: 1,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await browser.execute(async (rows) => {
      const bridge = (
        window as unknown as { __copseE2e?: { setPortRows: (value: unknown) => Promise<unknown> } }
      ).__copseE2e
      if (!bridge) throw new Error('__copseE2e unavailable')
      await bridge.setPortRows(rows)
    }, SEEDED_PORTS)
  })

  after(() => {
    resetUserData()
  })

  it('resizes the terminal rail and cancels an active supervised task', async () => {
    await browser.execute(() => {
      const body = document.getElementById('body')
      body?.style.setProperty('--projects-width', '180px')
      body?.style.setProperty('--files-width', '360px')
    })
    await $('button[aria-label="Open terminal"]').click()
    const row = $('.supervised-task-row')
    await row.waitForDisplayed({ timeout: 15_000 })
    await expect(row.$('.supervised-task-label')).toHaveText('Long task continuation')
    await expect(row.$('.supervised-task-state')).toHaveText('Waiting')
    await $('.ports-row').waitForDisplayed({ timeout: 15_000 })

    const initial = await readSectionHeights()
    assert.ok(initial.shells >= initial.root / 3 - 1, 'Shells should start at least one third high')
    assert.ok(initial.background >= initial.backgroundMin - 1)
    assert.ok(initial.ports >= initial.portsMin - 1)

    const shellsTaskHandle = $('[aria-label="Resize Shells and Background tasks"]')
    await shellsTaskHandle.dragAndDrop({ x: 0, y: 80 }, { duration: 300 })
    const afterShellResize = await readSectionHeights()
    assert.ok(afterShellResize.shells > initial.shells + 40)
    assert.ok(afterShellResize.background < initial.background - 40)

    const taskPortsHandle = $('[aria-label="Resize Background tasks and Ports"]')
    await taskPortsHandle.dragAndDrop({ x: 0, y: 60 }, { duration: 300 })
    const resized = await readSectionHeights()
    assert.ok(resized.background > afterShellResize.background + 25)
    assert.ok(resized.ports < initial.ports - 25)
    assert.ok(resized.shells >= resized.shellMin - 1)
    assert.ok(resized.background >= resized.backgroundMin - 1)
    assert.ok(resized.ports >= resized.portsMin - 1)

    await saveAppScreenshot('supervised-tasks-waiting.png')

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('.supervised-task-cancel')?.click()
    })
    await row.waitForExist({ reverse: true, timeout: 15_000 })
    await expect($('.supervised-tasks-section')).toHaveAttribute('hidden')
  })
})
