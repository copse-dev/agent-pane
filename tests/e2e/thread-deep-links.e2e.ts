import { readChromeOptions } from './helpers/chrome-options.ts'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveElectronExecutable } from './helpers/electron-executable.ts'
import { $, browser, expect } from '@wdio/globals'
import type { Thread } from '@shared/types'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const electronBinary = resolveElectronExecutable()

const PROJECT = 'deep-link-project'
const COLD = '11111111-1111-4111-8111-111111111111'
const WARM = '22222222-2222-4222-8222-222222222222'

function thread(id: string, title: string): Thread {
  const now = Date.UTC(2026, 9, 3)
  return {
    id,
    title,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [{ id: `${id}-prompt`, role: 'user', content: title, toolCalls: [], createdAt: now }],
  }
}

describe('native thread deep links', () => {
  let launcherDir: string | undefined
  before(async function () {
    // The process launcher below is POSIX; Windows protocol delivery needs its
    // own native launcher evidence rather than pretending this shell runs there.
    if (process.platform === 'win32') {
      this.skip()
    }
    launcherDir = mkdtempSync(join(tmpdir(), 'copse-link-launcher-'))
    resetUserData()
    writeSeedConfig({
      projects: [{ id: PROJECT, path: process.cwd(), name: 'workspace' }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: WARM,
      [`threads:${PROJECT}`]: [
        thread(COLD, 'Cold launch destination'),
        thread(WARM, 'Running app destination'),
      ],
    })
    const capabilities = browser.capabilities
    const chrome = readChromeOptions(browser.requestedCapabilities)
    if (!chrome.args) throw new Error('Expected Electron launch capabilities')
    // ChromeDriver prefixes non-switch args with '--'. Inject the ordinary OS
    // launch argument at the process boundary instead of adding a product flag.
    const launcher = join(launcherDir, 'electron-link-launcher')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${quote(electronBinary)} ${quote(join(process.cwd(), 'tests/e2e/electron-shell'))} "$@" ${quote(`copse://thread/${COLD}`)}\n`,
      { mode: 0o755 },
    )
    await browser.reloadSession({
      ...capabilities,
      'goog:chromeOptions': { ...chrome, binary: launcher },
    })
  })

  after(() => {
    resetUserData()
    if (launcherDir) rmSync(launcherDir, { recursive: true, force: true })
  })

  it('restores and selects a cold-launch destination before accepting a second-instance link', async () => {
    await expect($(`.chat-row[data-thread-id="${COLD}"]`)).toHaveElementClass('selected')
    await expect($('.messages-list .msg-user')).toHaveText(
      expect.stringContaining('Cold launch destination'),
    )
    await saveAppScreenshot('thread-deep-link-cold-launch.png')

    // The OS protocol handler launches another process; the real single-instance
    // lock must hand its argument to the existing main process and then exit.
    const child = spawn(
      electronBinary,
      [join(process.cwd(), 'tests/e2e/electron-shell'), `copse://thread/${WARM}`],
      {
        env: process.env,
        stdio: 'ignore',
      },
    )
    try {
      await expect($(`.chat-row[data-thread-id="${WARM}"]`)).toHaveElementClass('selected')
      await expect($('.messages-list .msg-user')).toHaveText(
        expect.stringContaining('Running app destination'),
      )
      await saveAppScreenshot('thread-deep-link-running-app.png')
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })
  it('shows the opt-in thread-link setting and its public-id explanation', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="agent"]').click()
    const section = $('[data-testid="git-thread-link-settings"]')
    await section.scrollIntoView()
    await expect(section).toBeDisplayed()
    await expect(section.$('input[name="gitThreadLinksEnabled"]')).not.toBeChecked()
    await expect(section).toHaveText(expect.stringContaining('opaque thread ID'))
    await expect(section).toHaveText(expect.stringContaining('Off by default.'))
    await saveAppScreenshot('settings-git-thread-links.png')
  })
})
