import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedSshWorkspaceSettings, writeSeedConfig } from './helpers/seed-config.ts'

describe('SSH project sidebar path labels', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    writeSeedConfig({
      projects: [
        {
          id: 'ssh-etc-ddg',
          path: '/etc/ddg',
          name: 'euw-serp-dev-testing16:ddg',
          sshHost: 'dev',
        },
        {
          id: 'ssh-home-ddg',
          path: '/home/ubuntu/ddg',
          name: 'euw-serp-dev-testing16:ddg',
          sshHost: 'dev',
        },
      ],
      activeProjectId: 'ssh-etc-ddg',
      'threads:ssh-etc-ddg': [],
      'threads:ssh-home-ddg': [],
    })
    seedSshWorkspaceSettings({
      hosts: [
        {
          id: 'dev',
          label: 'euw-serp-dev-testing16',
          host: 'euw-serp-dev-testing16',
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

    await browser.waitUntil(async () => (await $$('#pane-projects .project-name')).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'SSH project rows did not appear',
    })

    const texts = (await $$('#pane-projects .project-name').map((el) => el.getText())).map((t) =>
      t.trim(),
    )
    assert.ok(texts.includes('euw-serp-dev-testing16:/etc/ddg'), `got: ${texts.join(' | ')}`)
    assert.ok(
      texts.includes('euw-serp-dev-testing16:/home/ubuntu/ddg'),
      `got: ${texts.join(' | ')}`,
    )
    assert.ok(!texts.includes('euw-serp-dev-testing16:ddg'))

    await saveElementScreenshot('#pane-projects', 'ssh-project-path-labels.png')
  })
})
