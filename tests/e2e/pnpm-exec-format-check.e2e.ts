import { $, browser, expect } from '@wdio/globals'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const COMMAND = "pnpm exec oxfmt --check package.json && printf 'format-check-passed'"
const PROMPT = 'Check the package manifest formatting.'
const REPLY = 'The formatter check passed.'

describe('pnpm exec format check', function () {
  this.timeout(90_000)
  const originalPath = process.env['PATH']
  let fixtureBin = ''
  let fixtureWorkspace = ''
  let fixtureRoot = ''

  before(async () => {
    resetUserData()
    mkdirSync(join(process.cwd(), '.tmp'), { recursive: true })
    fixtureRoot = mkdtempSync(join(process.cwd(), '.tmp', 'pnpm-exec-workspace-'))
    fixtureWorkspace = join(fixtureRoot, 'formatter-project')
    mkdirSync(fixtureWorkspace)
    fixtureBin = join(fixtureWorkspace, 'fixture-bin')
    mkdirSync(fixtureBin)
    // Give the real app an independent project: creating its first checkout must
    // never change this spec's own Git worktree or shared repository index.
    writeFileSync(join(fixtureWorkspace, 'package.json'), '{}\n')
    writeFileSync(join(fixtureWorkspace, '.gitignore'), 'node_modules/\nfixture-bin/\n')
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: fixtureWorkspace })
    }
    git(['init', '-b', 'main'])
    git(['add', 'package.json', '.gitignore'])
    git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Copse fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-m',
      'Seed formatter fixture',
    ])
    // pnpm links oxfmt's dependencies into its store directory. cpSync's
    // `dereference` resolves only the top-level source, so resolve each link
    // here: the sandbox cannot read the repository's store when it sits under
    // HOME, as it does on CI runners.
    const copyResolved = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) {
        const source = realpathSync(join(from, name))
        if (name.startsWith('@')) copyResolved(source, join(to, name))
        else cpSync(source, join(to, name), { recursive: true })
      }
    }
    const installed = dirname(realpathSync(join(process.cwd(), 'node_modules', 'oxfmt')))
    copyResolved(installed, join(fixtureWorkspace, 'node_modules'))
    mkdirSync(join(fixtureWorkspace, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      join(fixtureWorkspace, 'node_modules', '.bin', 'oxfmt'),
      '#!/bin/sh\nexec node ./node_modules/oxfmt/bin/oxfmt "$@"\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(fixtureBin, 'pnpm'),
      '#!/bin/sh\nif [ "$1" != "exec" ] || [ "$2" != "oxfmt" ]; then exit 2; fi\nshift 2\n./node_modules/.bin/oxfmt "$@"\n',
      { mode: 0o755 },
    )
    writeE2eEnv({
      COPSE_PRESERVE_PATH: '1',
      PATH: [fixtureBin, originalPath].filter(Boolean).join(delimiter),
    })
    seedEmptyProject(fixtureWorkspace, 'e2e-pnpm-exec-format-check', {
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
    if (fixtureRoot) removeE2eTree(fixtureRoot)
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
