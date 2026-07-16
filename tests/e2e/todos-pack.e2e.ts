import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedTodoPlanFixtures,
} from './helpers/seed-config.ts'

// Visual eval for the P4 pilot pack (`copse.todos`).
//
// P4 extracts the plan panel into a level-2 declarative contribution owned by
// the shipped `copse.todos` pack. The renderer replaces the retired
// `createTodoListEl` with the generic `createPackPanelEl`, tagged with the
// pack ids so the panel is unambiguously the plan contribution. This spec
// pins the DOM shape (pack ids, panel kind, header/summary) and captures a
// reference screenshot for visual review.
//
// The disable-atomicity contract (one flag flip drops tool + hooks + prompt
// + panel from new work) is proven in
// `packages/agent/src/packs/todos-pack.test.ts`; the
// history-never-consults-registration invariant (decision 17) is proven in
// `src/main/services/packs/history-never-consults-live-registration.test.ts`.
// This spec covers the visual half — that the extracted panel renders.
describe('copse.todos plan panel (P4)', function () {
  // Boot + reload the profile with a seeded todos-bearing thread; the panel
  // renders during that boot cycle. Boot can take up to ~30s on constrained
  // runners, so bump the mocha spec timeout above the default (30_000).
  this.timeout(60_000)

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedTodoPlanFixtures(process.cwd())
    seedE2eThreePaneLayout()
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('renders the plan as a level-2 pack panel tagged with the copse.todos ids', async () => {
    const panel = await $(
      `.conversation-todos-host .pack-panel[data-pack-id="copse.todos"][data-contribution-id="plan"]`,
    )
    await panel.waitForExist({ timeout: 30_000 })

    assert.equal(await panel.getAttribute('data-panel-kind'), 'list')
    // `.pack-panel-header` applies `text-transform: uppercase`; `getText()`
    // returns the *rendered* text, so compare case-insensitively.
    const title = (await panel.$('.pack-panel-title').getText()).toLowerCase()
    assert.equal(title, 'to-dos')
    await expect(panel.$('.pack-panel-summary')).toHaveText('1/5 done')

    await saveAppScreenshot('todos-pack-plan-panel.png')
  })
})
