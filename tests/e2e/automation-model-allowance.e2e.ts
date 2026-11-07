import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {} from './helpers/browser-globals.d.ts'
import { $, browser, expect } from '@wdio/globals'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, writeSeedConfig } from './helpers/seed-config.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'

const PROJECT_ID = 'e2e-model-allowance'

async function openSchedule(): Promise<WebdriverIO.Element> {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await $(`.project-entry[data-project-id="${PROJECT_ID}"] .project-menu-btn`).click()
  await $('.context-menu-item=Automations').click()
  const dialog = $('#automation-dialog')
  await dialog.$('.automation-row-btn=Edit').click()
  return dialog
}

describe('automation model allowance editor', function () {
  this.timeout(60_000)
  before(async () => {
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('The isolated test worktree root is missing')
    const projectRoot = join(dirname(worktreesRoot), 'allowance-fixture')
    mkdirSync(projectRoot, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'e2e@example.invalid')
    git('config', 'user.name', 'Copse E2E')
    writeFileSync(join(projectRoot, 'README.md'), 'Model allowance fixture\n')
    git('add', 'README.md')
    git('commit', '-qm', 'seed')
    seedEmptyProject(projectRoot, PROJECT_ID, { model: 'claude-haiku-4-5' })
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'Allowance fixture' }],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [],
      pluginDisabled: ['copse.automations'],
      pluginMigration: { automationsEnablement: true },
      plugin: {
        copse: {
          automations: {
            storage: [
              {
                id: 'limited-review',
                projectId: PROJECT_ID,
                name: 'Limited project review',
                cron: '0 9 * * 1-5',
                prompt: 'Review the project.',
                model: 'claude-haiku-4-5',
                enabled: false,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      },
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('saves through real IPC, survives relaunch and can be removed for future runs', async () => {
    let dialog = await openSchedule()
    const field = dialog.$('.automation-model-allowance-input')
    await expect(field).toHaveValue('')
    await field.setValue('12.50')
    const label = dialog.$('.automation-model-allowance-label')
    await label.scrollIntoView({ block: 'center' })
    assert.match(await label.getText(), /USD estimate/)
    assert.match(await label.getText(), /Anthropic API models only/)
    assert.match(await label.getText(), /not refunded/)
    await saveElementScreenshot(
      '.automation-model-allowance-label',
      'automation-model-allowance.png',
    )
    await dialog.$('.automation-save-btn').click()
    await expect(dialog.$('.automation-form')).not.toBeDisplayed()
    await browser.reloadSession()
    dialog = await openSchedule()
    await expect(dialog.$('.automation-model-allowance-input')).toHaveValue('12.5')
    await dialog.$('.automation-model-allowance-input').clearValue()
    await dialog.$('.automation-save-btn').click()
    await expect(dialog.$('.automation-form')).not.toBeDisplayed()
    await dialog.$('.automation-row-btn=Edit').click()
    await expect(dialog.$('.automation-model-allowance-input')).toHaveValue('')
    await expect(dialog.$('.automation-plugin-toggle')).toHaveText('Enable automations')
  })

  it('Run now stops before consuming a mock provider response and shows why', async () => {
    const dialog = $('#automation-dialog')
    await dialog.$('.automation-model-allowance-input').setValue('0.01')
    await dialog.$('.automation-save-btn').click()
    await expect(dialog.$('.automation-form')).not.toBeDisplayed()
    await dialog.$('.automation-plugin-toggle').click()
    await expect(dialog.$('.automation-plugin-toggle')).toHaveText('Disable plugin')
    await browser.execute(async () => {
      if (!window.__copseE2e) throw new Error('Scenario bridge missing')
      await window.__copseE2e.setMockScenario('allowance-refuses-first-call', {
        title: 'Limited project review',
        turns: [
          {
            user: 'Review the project.',
            responses: [{ text: 'This response must never be consumed.' }],
          },
        ],
      })
    })
    await dialog.$('.automation-run-btn').click()
    await expect(dialog.$('.automation-status')).toHaveText(expect.stringContaining('Started'))
    await dialog.$('[aria-label="Close automations"]').click()
    // Run now selects its newly created thread in the active project.
    const error = $('.messages-list .markdown-alert-caution')
    await expect(error).toHaveText(expect.stringContaining('Automation model allowance exhausted'))
    await expect(error).toHaveText(expect.stringContaining('No request was sent'))
    const state = await browser.execute(async () => {
      if (!window.__copseE2e) throw new Error('Scenario bridge missing')
      return window.__copseE2e.mockScenarioStatus('allowance-refuses-first-call')
    })
    assert.equal(state.turn, 0)
    assert.equal(state.response, 0)
    assert.equal(state.complete, false)
    assert.deepEqual(state.errors, [])
    await saveElementScreenshot(
      '.markdown-alert-caution',
      'automation-model-allowance-exhausted.png',
    )
    await browser.execute(async () => {
      await window.__copseE2e?.clearMockScenarios()
    })
  })

  it('every out-of-turn helper and review reads the durable allowance through real IPC', async () => {
    const threadId = await browser.execute(async (projectId: string) => {
      const threads = await window.api.threads.loadProject(projectId)
      const thread = threads.find((candidate) => candidate.title === 'Limited project review')
      if (!thread) throw new Error('The automation run is missing')
      return thread.id
    }, PROJECT_ID)
    const path = join(copseUserDataDir(), 'automation-budgets', PROJECT_ID, `${threadId}.json`)
    const original = readFileSync(path, 'utf8')
    // Corrupt the isolated fixture on disk. Even mock-mode helpers that normally
    // return a canned title or no suggestion must read and reject this record.
    writeFileSync(path, '{broken')
    try {
      const results = await browser.execute(
        async (projectId: string, id: string) => {
          const context = JSON.stringify({
            userMessage: 'Review',
            assistantMessage: 'Done',
            toolNames: [],
          })
          const agent = window.api.agent
          const requests = [
            agent.suggestTitle('Review the project', projectId, id),
            agent.suggestTerminalTitle('Running tests', projectId, id),
            agent.suggestCommandSummary(['pwd', 'git status'], projectId, id),
            agent.suggestToolTurnSummary(['Read files', 'Run tests'], projectId, id),
            agent.suggestNextStep(context, projectId, id),
            agent.suggestFollowUps(projectId, id, context),
            agent.suggestPrBody(projectId, id, context),
            agent.describeImages(projectId, id, 'claude-haiku-4-5', '', [
              'data:image/png;base64,AAAA',
            ]),
            agent.retryReview(projectId, id, '{}'),
            window.api.review.run(projectId, id, '{}'),
          ]
          return Promise.all(
            requests.map(async (request) => {
              try {
                await request
                return 'unexpectedly admitted'
              } catch (error) {
                return error instanceof Error ? error.message : String(error)
              }
            }),
          )
        },
        PROJECT_ID,
        threadId,
      )
      assert.equal(results.length, 10)
      for (const result of results) assert.match(result, /allowance is unreadable/)
    } finally {
      writeFileSync(path, original)
    }
  })
})
