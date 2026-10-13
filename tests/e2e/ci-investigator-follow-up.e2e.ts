import { createFixtureDirectory } from './helpers/fixture-directory.ts'
import { $, browser, expect } from '@wdio/globals'
import { delimiter } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  completeMockTurn,
  seedCleanFeatureBranch,
  writeFailingPrGhFixture,
} from './helpers/follow-up-suggestions.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

describe('CI investigator follow-up', () => {
  const originalPath = process.env['PATH']
  let workspace = ''
  let cleanupWorkspace: (() => void) | undefined
  let fixtureBin = ''
  let cleanupBin: (() => void) | undefined

  before(async function () {
    this.timeout(120_000)
    resetUserData()
    const fixture = createFixtureDirectory('copse-follow-up-investigate-ci')
    workspace = fixture.root
    cleanupWorkspace = fixture.cleanup
    const bin = createFixtureDirectory('copse-follow-up-gh')
    fixtureBin = bin.root
    cleanupBin = bin.cleanup
    seedCleanFeatureBranch(workspace)
    writeFailingPrGhFixture(fixtureBin)
    writeE2eEnv({
      COPSE_AGENT_EVAL: '1',
      COPSE_PRESERVE_PATH: '1',
      PATH: [fixtureBin, '/usr/bin', '/bin'].join(delimiter),
    })
    seedEmptyProject(workspace, 'e2e-follow-up-investigate-ci-project', {
      subagentsEnabled: true,
      ciInvestigatorEnabled: true,
    })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({
      COPSE_AGENT_EVAL: undefined,
      COPSE_PRESERVE_PATH: undefined,
      PATH: originalPath,
    })
    resetUserData()
    cleanupWorkspace?.()
    cleanupBin?.()
  })

  it('names the available investigate_ci tool in the failing-CI bubble', async () => {
    const scenario = await completeMockTurn()
    const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
    await ciBubble.waitForDisplayed({ timeout: 30_000 })
    await expect(ciBubble).toHaveText('Investigate CI failure')

    await browser.waitUntil(
      async () =>
        browser.execute(async () => {
          const status = await window.api.index.status()
          return (
            status.fileIndex.phase !== 'building' &&
            status.semantic.phase !== 'building' &&
            document.querySelector('.footer-indexing')?.getAttribute('data-state') !== 'building'
          )
        }),
      { timeout: 30_000, timeoutMsg: 'expected workspace indexing to finish before capture' },
    )
    await saveAppScreenshot('follow-up-suggestions-investigate-ci.png')
    await scenario.assertComplete()
  })
})
