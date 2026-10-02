import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { openProjectManager } from './helpers/project-manager.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedSshWorkspaceSettings, writeSeedConfig } from './helpers/seed-config.ts'

describe('SSH project sidebar path labels', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeSeedConfig({
      projects: [
        {
          id: 'ssh-srv-app',
          path: '/srv/app',
          name: 'remote-dev-testing-016:app',
          sshHost: 'dev',
        },
        {
          id: 'ssh-home-app',
          path: '/home/ubuntu/app',
          name: 'remote-dev-testing-016:app',
          sshHost: 'dev',
        },
      ],
      activeProjectId: 'ssh-srv-app',
      'threads:ssh-srv-app': [],
      'threads:ssh-home-app': [],
    })
    seedSshWorkspaceSettings({
      hosts: [
        {
          id: 'dev',
          label: 'remote-dev-testing-016',
          host: 'remote-dev-testing-016',
          user: 'ubuntu',
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows full remote paths when two SSH projects share a basename', async () => {
    await $('.prompt-input').waitForExist({ timeout: 15_000 })

    const projectsPane = await $('#pane-projects')
    await expect(projectsPane).toBeDisplayed()

    // The default thread sidebar names projects in its project filter.
    const scopeLabels = async (): Promise<string[]> =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[aria-label="Filter by project"] option'), (option) =>
          option.textContent.trim(),
        ),
      )
    await browser.waitUntil(async () => (await scopeLabels()).length >= 3, {
      timeout: 15_000,
      timeoutMsg: 'SSH projects did not appear in the project filter',
    })
    const scoped = await scopeLabels()
    assert.ok(scoped.includes('remote-dev-testing-016:/srv/app'), `got: ${scoped.join(' | ')}`)
    assert.ok(
      scoped.includes('remote-dev-testing-016:/home/ubuntu/app'),
      `got: ${scoped.join(' | ')}`,
    )

    await openProjectManager()
    await browser.waitUntil(async () => (await $$('#pane-projects .project-name')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'SSH project rows did not appear',
    })

    const texts = (await $$('#pane-projects .project-name').map((el) => el.getText())).map((t) =>
      t.trim(),
    )
    assert.ok(texts.includes('remote-dev-testing-016:/srv/app'), `got: ${texts.join(' | ')}`)
    assert.ok(
      texts.includes('remote-dev-testing-016:/home/ubuntu/app'),
      `got: ${texts.join(' | ')}`,
    )
    assert.ok(!texts.includes('remote-dev-testing-016:app'))

    await saveElementScreenshot('#pane-projects', 'ssh-project-path-labels.png')
  })
})
