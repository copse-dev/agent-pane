import { $, browser, expect } from '@wdio/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { waitForAgentIdle } from './helpers.ts'

const COMMAND = "pnpm exec oxfmt --check package.json && printf 'format-check-passed'"
const PROMPT = 'Check the package manifest formatting.'
const REPLY = 'The formatter check passed.'

describe('pnpm exec format check', () => {
  const originalPath = process.env['PATH']
  let fixtureBin = ''

  before(async () => {
    resetUserData()
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    fixtureBin = mkdtempSync(join(process.cwd(), '.tmp', 'pnpm-exec-bin-'))
    writeFileSync(
      join(fixtureBin, 'pnpm'),
      '#!/bin/sh\nif [ "$1" != "exec" ] || [ "$2" != "oxfmt" ]; then exit 2; fi\nshift 2\n./node_modules/.bin/oxfmt "$@"\n',
      { mode: 0o755 },
    )
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [fixtureBin, originalPath].filter(Boolean).join(delimiter),
    })
    seedEmptyProject(process.cwd(), 'e2e-pnpm-exec-format-check', {
      subagentsEnabled: false,
      autoRunSandboxCommands: true,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    writeE2eEnv({ COPSE_PRESERVE_PATH: undefined, PATH: originalPath })
    resetUserData()
    if (fixtureBin) rmSync(fixtureBin, { recursive: true, force: true })
  })

  it('runs the installed formatter inside the sandbox without an approval dialog', async () => {
    const scenario = await installMockScenario({
      title: 'Check package manifest formatting',
      turns: [
        {
          user: PROMPT,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: COMMAND } }] },
            {
              text: REPLY,
              expectToolResults: [{ name: 'run_shell', includes: 'format-check-passed' }],
            },
          ],
        },
      ],
    })
    await setComposerValue(PROMPT)
    await submitComposer()

    await waitForAgentIdle(60_000)
    await saveAppScreenshot('pnpm-exec-format-check.png')
    await scenario.waitForComplete()
    await expectAssistantReply(REPLY)
    await expect($('#approval-dialog')).not.toBeDisplayed()
    await expect($('.tool-card')).toBeExisting()
    await scenario.assertComplete()
  })
})
