import { $, browser, expect } from '@wdio/globals'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { submitComposer } from './helpers/composer.ts'

const PROJECT_ID = 'e2e-outside-sandbox-approval-copy'

describe('outside-sandbox approval copy', () => {
  before(async () => {
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
  })

  it('keeps advice separate while exposing the complete long command', async () => {
    const command = [
      'set -o pipefail',
      ...Array.from(
        { length: 18 },
        (_, index) =>
          `gh pr create --draft --title "Visual approval ${String(index + 1)}" --body "Review item ${String(index + 1)}"`,
      ),
      'printf "final command remains visible\\n"',
    ].join('\n')
    const scenario = await prepareMockToolTurn(
      'Prepare the draft pull requests.',
      {
        name: 'run_shell',
        args: { command, expects_sandbox_block: true },
      },
      'I left the draft pull requests unchanged.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Agent requests sandbox escape')

    const advice = dialog.$('.approval-advice')
    await expect(advice).toHaveText(expect.stringContaining('expects the project sandbox to block'))
    await expect(advice).toHaveText(expect.stringContaining('asking to run outside the sandbox'))

    const body = dialog.$('.approval-body')
    expect(await body.getText()).toBe(command)
    const commandRegion = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>('#approval-dialog .approval-body')
      if (!element) throw new Error('approval command region is missing')
      return {
        scrolls: element.scrollHeight > element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }
    })
    expect(commandRegion).toEqual({ scrolls: true, overflowY: 'auto' })
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining("agent's expectation, not a confirmed sandbox block"),
    )

    await saveElementScreenshot('#approval-dialog', 'outside-sandbox-long-command-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I left the draft pull requests unchanged.')
    await scenario.assertComplete()
  })

  it('offers bounded retries when the agent expects a project script to need the outside', async () => {
    // A browser demo rerun after each fix: opaque local execution, nothing else.
    const command = 'node scripts/run-demo.mts --spec tests/demo/remote-acp-first-run.demo.ts'
    const scenario = await prepareMockToolTurn(
      'Run the browser demo outside the sandbox.',
      { name: 'run_shell', args: { command, expects_sandbox_block: true } },
      'I left the browser demo unrun.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Agent requests sandbox escape')
    const leaseOption = dialog.$('.approval-turn-tree')
    await expect(leaseOption).toBeDisplayed()
    await expect(leaseOption).toHaveText(
      'Allow retries outside the sandbox (up to 10, for 2 hours). This exact command only; Stop revokes retries. Changed scripts can change what it does.',
    )
    // Opt-in: leaving the sandbox again is never the default.
    await expect(leaseOption.$('.approval-turn-tree-input')).not.toBeChecked()

    await saveElementScreenshot('#approval-dialog', 'agent-escape-retry-lease-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I left the browser demo unrun.')
    await scenario.assertComplete()
  })

  it('honours outside consent for a background command without enabling Guarded YOLO', async () => {
    const fixture = join(tmpdir(), 'copse-e2e-background-outside-approval')
    const target = join(fixture, 'approved.txt')
    mkdirSync(fixture, { recursive: true })
    rmSync(target, { force: true })
    const command = `printf approved-background > '${target.replaceAll("'", "'\\''")}'`
    try {
      const scenario = await prepareMockToolTurn(
        'Run this background command with the access I approve.',
        { name: 'run_background', args: { action: 'start', command, timeout_ms: 10_000 } },
        'The approved background command completed.',
      )
      await submitComposer()
      const dialog = await $('#approval-dialog')
      await dialog.waitForDisplayed({ timeout: 30_000 })
      await expect(dialog.$('.approval-heading')).toHaveText('Run outside sandbox?')
      await expect(dialog.$('.approval-body')).toHaveText(command)
      await saveElementScreenshot('#approval-dialog', 'background-command-outside-approval.png')
      await dialog.$('.approval-approve').click()
      await waitForAgentIdle(30_000)
      await expectAssistantReply('The approved background command completed.')
      expect(readFileSync(target, 'utf8')).toBe('approved-background')
      await scenario.assertComplete()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('shows a fresh background escape request and keeps a declined attempt contained', async () => {
    const command = 'node scripts/run-demo.mts --spec tests/demo/remote-acp-first-run.demo.ts'
    const scenario = await prepareMockToolTurn(
      'Start the background demo with the access I approve.',
      { name: 'run_background', args: { action: 'start', command, expects_sandbox_block: true } },
      'I kept the background attempt inside the sandbox.',
    )
    await submitComposer()
    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText('Agent requests sandbox escape')
    await expect(dialog.$('.approval-body')).toHaveText(command)
    await expect(dialog.$('.approval-footer')).toHaveText(
      expect.stringContaining("agent's expectation, not a confirmed sandbox block"),
    )
    await expect(dialog.$('.approval-turn-tree')).not.toBeDisplayed()
    await saveElementScreenshot('#approval-dialog', 'background-expected-block-approval.png')
    await dialog.$('.approval-reject').click()
    await waitForAgentIdle(30_000)
    await expectAssistantReply('I kept the background attempt inside the sandbox.')
    await scenario.assertComplete()
  })
})
