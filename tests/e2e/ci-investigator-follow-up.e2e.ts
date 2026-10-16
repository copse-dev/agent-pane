import { $, browser, expect } from '@wdio/globals'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import {
  completeMockTurn,
  seedCleanFeatureBranch,
  writeFailingPrGhFixture,
} from './helpers/follow-up-suggestions.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

describe('CI investigator follow-up', () => {
  const originalPath = process.env['PATH']
  let workspace = ''
  let fixtureBin = ''

  before(async function () {
    this.timeout(120_000)
    resetUserData()
    workspace = join(mkdtempSync(join(tmpdir(), 'copse-follow-up-investigate-ci-')), 'workspace')
    mkdirSync(workspace)
    fixtureBin = mkdtempSync(join(tmpdir(), 'copse-follow-up-gh-'))
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
    if (workspace) removeE2eTree(dirname(workspace))
    if (fixtureBin) removeE2eTree(fixtureBin)
  })

  it('names the available investigate_ci tool in the failing-CI bubble', async () => {
    const scenario = await completeMockTurn()
    const ciBubble = await $('.follow-up-bubble[data-id="debug-ci"]')
    await ciBubble.waitForDisplayed({ timeout: 30_000 })
    await expect(ciBubble).toHaveText('Investigate CI failure')

    await $('.footer-indexing').waitForDisplayed({ timeout: 30_000, reverse: true })
    await saveAppScreenshot('follow-up-suggestions-investigate-ci.png')
    await scenario.assertComplete()
  })
})
