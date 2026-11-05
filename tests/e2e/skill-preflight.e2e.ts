import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('skill preflight diagnostics in Sources', () => {
  let workspace = ''
  before(async () => {
    resetUserData()
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'copse-e2e-preflight-')))
    const skill = join(workspace, '.cursor/skills/preflight-workflow')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      `---
name: preflight-workflow
description: A workflow with explicit requirements.
copse-requirements:
  tools: [capture_screen]
  agents: [missing-reviewer]
  executors: [acp]
---
Read references/required.md before starting.
`,
    )
    seedEmptyProject(workspace, 'e2e-skill-preflight', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
    removeE2eTree(workspace)
  })
  it('shows actionable failures and keeps unverified compatibility visibly untested', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const diagnostics = $('#sources-skills-diagnostics')
    await browser.waitUntil(
      async () =>
        (await diagnostics.getText()).includes('Required agent "missing-reviewer" is missing'),
      { timeout: 15_000 },
    )
    const text = await diagnostics.getText()
    assert.match(text, /Install its definition in an agents folder/)
    assert.match(text, /capture_screen.*has not been checked/)
    assert.match(text, /Executor restrictions not checked.*acp/)
    assert.match(text, /Supporting file "references\/required.md" is missing/)
    assert.match(text, /Workflow\/model compatibility is untested/)
    await browser.execute(() => {
      for (const row of document.querySelectorAll('#sources-skills-diagnostics .sources-row')) {
        if (row.textContent.includes('Required agent "missing-reviewer" is missing')) {
          row.setAttribute('data-preflight-evidence', 'missing-agent')
          row.scrollIntoView({ block: 'center' })
        }
      }
    })
    await expect($('[data-preflight-evidence="missing-agent"] .sources-badge')).toHaveText(
      'unavailable',
    )
    await saveElementScreenshot(
      '[data-preflight-evidence="missing-agent"]',
      'skill-preflight-missing-agent.png',
    )
  })

  it('reports runtime blockers in the failed tool card before loading workflow instructions', async () => {
    await $('#settings-close').click()
    await prepareMockToolTurn(
      'Read the preflight-workflow skill and check whether it can start.',
      { name: 'read_skill', args: { name: 'preflight-workflow' } },
      'This workflow is blocked by unavailable requirements.',
    )
    await submitComposer()
    await waitForAgentIdle(30_000)
    const selector = '.tool-card[data-tool-id][data-status="error"]'
    const card = $(selector)
    await card.waitForDisplayed({ timeout: 10_000 })
    if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
    await expect(card).toHaveText('Skill preflight for "preflight-workflow": blocked.', {
      containing: true,
    })
    await expect(card).toHaveText('Required tool "capture_screen" is not offered', {
      containing: true,
    })
    await expect(card).toHaveText('Required agent "missing-reviewer" is missing', {
      containing: true,
    })
    await expect(card).toHaveText('Executor "native" is excluded', { containing: true })
    await expect(card).toHaveText('Supporting file "references/required.md" is missing', {
      containing: true,
    })
    await expect(card).not.toHaveText('Read references/required.md before starting.', {
      containing: true,
    })
    await saveElementScreenshot(selector, 'skill-preflight-runtime-blockers.png')
  })
})
