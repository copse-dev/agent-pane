import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT_ID = 'e2e-environment-setup'
const THREADS = ['env-setup-a', 'env-setup-b'] as const
const COMMAND = 'xcodebuild -scheme App build'
const ORIGIN = 'https://docs.example.com'

let workspaceRoot: string

/** A thread whose assistant ran `COMMAND` three times, each after the user approved it. */
function thread(id: string, now: number): Record<string, unknown> {
  return {
    id,
    title: `Build the app (${id})`,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      { id: `${id}-user`, role: 'user', content: 'Build the app', toolCalls: [], createdAt: now },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        content: 'Built it.',
        createdAt: now + 1,
        toolCalls: [0, 1, 2].map((n) => ({
          id: `${id}-call-${String(n)}`,
          name: 'run_shell',
          args: { command: COMMAND },
          status: 'done',
          result: 'BUILD SUCCEEDED',
        })),
      },
    ],
  }
}

/** The approvals a person gave in that thread: three escalations and three web fetches. */
function appendApprovals(id: string, now: number): void {
  const lines = [0, 1, 2].flatMap((n) => [
    {
      v: 1,
      type: 'decision',
      id: `${id}-shell-${String(n)}`,
      at: now,
      kind: 'shell',
      actor: 'user',
      verdict: 'approved',
      subject: 'shell command (arguments omitted)',
      scope: 'external',
      cause: 'shell-sandbox-escalation',
      toolCallId: `${id}-call-${String(n)}`,
    },
    {
      v: 1,
      type: 'decision',
      id: `${id}-web-${String(n)}`,
      at: now,
      kind: 'web',
      actor: 'user',
      verdict: 'approved',
      subject: ORIGIN,
      scope: 'external',
      cause: 'web-origin',
    },
  ])
  appendFileSync(
    join(e2eWorkspaceDir(), PROJECT_ID, id, 'events.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  )
}

describe('environment setup', () => {
  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    workspaceRoot = join(mkdtempSync(join(tmpdir(), 'copse-e2e-env-setup-')), 'workspace')
    mkdirSync(workspaceRoot)
    const now = Date.now()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: PROJECT_ID,
      activeThreadId: THREADS[0],
      trustedWorkspaceRoots: [realpathSync(workspaceRoot)],
      [`threads:${PROJECT_ID}`]: THREADS.map((id) => thread(id, now)),
    })
    for (const id of THREADS) appendApprovals(id, now)
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    removeE2eTree(dirname(workspaceRoot))
  })

  it('offers, reviews, applies and undoes suggestions drawn from approved prompts', async function () {
    this.timeout(90_000)
    const notice = $('.environment-setup-notice')
    await notice.waitForDisplayed({ timeout: 30_000 })
    assert.match(await notice.getText(), /asked you 12 times this week/)
    await saveElementScreenshot('.environment-setup-notice', 'environment-setup-offer.png')

    await notice.$('.environment-setup-notice-review').click()
    const dialog = $('#environment-setup-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('.environment-setup-section').waitForDisplayed({ timeout: 15_000 })
    const sections = await dialog.$$('.environment-setup-section h3').map((h) => h.getText())
    assert.deepEqual(sections, ['Web origins', 'Trusted commands'])

    const originBox = dialog.$('[data-kind="web-origin"] input[type="checkbox"]')
    const commandBox = dialog.$('[data-kind="trusted-command"] input[type="checkbox"]')
    assert.equal(await originBox.isSelected(), true, 'a repeatedly approved origin starts ticked')
    assert.equal(await commandBox.isSelected(), false, 'a host-access grant never starts ticked')
    assert.match(await dialog.getText(), /You approved this 6 times in 2 threads/)
    await saveElementScreenshot('#environment-setup-dialog', 'environment-setup-review.png')

    await commandBox.click()
    const apply = dialog.$('.environment-setup-apply')
    assert.equal(await apply.getText(), 'Apply 2 changes')
    await apply.click()
    await dialog.waitForDisplayed({ timeout: 15_000, reverse: true })

    const commands = await browser.execute(() => window.api.settings.get('trustedShellCommands'))
    const origins = await browser.execute(() => window.api.settings.get('webAllowedOrigins'))
    assert.deepEqual(commands, ['xcodebuild'])
    assert.ok(Array.isArray(origins) && origins.includes(ORIGIN))

    const undo = $('.toast .toast-action')
    await undo.waitForDisplayed({ timeout: 15_000 })
    await undo.click()
    await browser.waitUntil(
      async () => {
        const after = await browser.execute(() => window.api.settings.get('trustedShellCommands'))
        return Array.isArray(after) && after.length === 0
      },
      { timeout: 15_000, timeoutMsg: 'expected Undo to remove the trusted command' },
    )
    const originsAfter = await browser.execute(() => window.api.settings.get('webAllowedOrigins'))
    assert.ok(Array.isArray(originsAfter) && !originsAfter.includes(ORIGIN))
  })

  it('saves trusted registries and production targets from Settings → Permissions', async function () {
    this.timeout(90_000)
    await $('[aria-label="Settings"]').click()
    const dialog = $('#settings-dialog')
    await expect(dialog).toBeDisplayed()
    await dialog.$('button[data-section="permissions"]').click()
    await expect(dialog.$('#environment-setup-review')).toBeDisplayed()

    await dialog
      .$('textarea[name="trustedPackageRegistries"]')
      .setValue('https://NPM.corp.example/api/npm/\ndirect\nhttp://not-loopback.example')
    await dialog
      .$('textarea[name="productionTargets"]')
      .setValue('Prod-EU\nbad name\ndb.prod.example')
    await $('#settings-dialog button[type="submit"]').click()
    await $('#settings-dialog').waitForDisplayed({ timeout: 30_000, reverse: true })

    const registries = await browser.execute(() =>
      window.api.settings.get('trustedPackageRegistries'),
    )
    const targets = await browser.execute(() => window.api.settings.get('productionTargets'))
    assert.deepEqual(registries, ['https://npm.corp.example'])
    assert.deepEqual(targets, ['prod-eu', 'db.prod.example'])

    await $('[aria-label="Settings"]').click()
    await dialog.$('button[data-section="permissions"]').click()
    const review = dialog.$('.environment-setup-settings-row')
    await review.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      '.environment-setup-settings-row',
      'settings-environment-setup-review.png',
    )
    const targetsField = dialog.$('label:has(textarea[name="productionTargets"])')
    await targetsField.scrollIntoView({ block: 'center' })
    await saveElementScreenshot(
      'label:has(textarea[name="trustedPackageRegistries"])',
      'settings-trusted-package-registries.png',
    )
    await saveElementScreenshot(
      'label:has(textarea[name="productionTargets"])',
      'settings-production-targets.png',
    )
  })
})
