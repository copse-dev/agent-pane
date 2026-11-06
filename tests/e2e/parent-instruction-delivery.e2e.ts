import { mkdirSync, realpathSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'
import { expectAssistantReply } from './helpers/mock-scenario.ts'
import {
  assertParentInstructionFiles,
  PARENT_INSTRUCTION_DEFERRAL,
  PARENT_INSTRUCTION_FILES,
  PARENT_INSTRUCTION_HOLD,
  PARENT_INSTRUCTION_PROMPT,
  PARENT_INSTRUCTION_REPLY,
  parentInstructionResponses,
} from './helpers/parent-instruction-fixture.ts'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

describe('parent instruction delivery', function () {
  this.timeout(90_000)
  let server: ConversationServer
  let workspace: string

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    server = await startConversationServer({ title: 'Update both API files' })
    server.configureEnvironment()
    resetUserData()
    workspace = seedStableWorkspace({ files: PARENT_INSTRUCTION_FILES })
    seedEmptyProject(workspace, 'e2e-parent-instruction-delivery', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    // Nested AGENTS.md scopes only activate in a trusted workspace, so without
    // this nothing is deferred and both edits run before the guidance arrives.
    writeSeedConfig({
      projects: [{ id: 'e2e-parent-instruction-delivery', path: workspace, name: 'workspace' }],
      activeProjectId: 'e2e-parent-instruction-delivery',
      trustedWorkspaceRoots: [realpathSync(workspace)],
      'threads:e2e-parent-instruction-delivery': [],
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    server.enqueue(...parentInstructionResponses(workspace))
    await browser.reloadSession()
  })

  after(async () => {
    try {
      server.assertComplete()
    } finally {
      await server.close()
      resetUserData()
    }
  })

  it('shows both same-response edits deferred until the model receives nested guidance', async () => {
    await setComposerValue(PARENT_INSTRUCTION_PROMPT)
    await submitComposer()

    try {
      // The HTTP fixture has checked the actual next request's system guidance,
      // both deferral results and unchanged files before entering this hold.
      await server.waitForHold(PARENT_INSTRUCTION_HOLD)
      assertParentInstructionFiles(workspace, false)
      await expect($$('[data-tool-id]')).toBeElementsArrayOfSize(3)

      // Open the real disclosures through their summaries, including any
      // containing rollup/group, so lazy tool bodies render as they do for users.
      for (const index of [1, 2]) {
        const selector = `[data-tool-id$="-tool-${String(index)}"]`
        await browser.waitUntil(
          () =>
            browser.execute((cardSelector) => {
              const card = document.querySelector<HTMLDetailsElement>(cardSelector)
              if (!card) return false
              const disclosures: HTMLDetailsElement[] = []
              for (let parent = card.parentElement; parent; parent = parent.parentElement) {
                if (parent instanceof HTMLDetailsElement) disclosures.unshift(parent)
              }
              for (const disclosure of [...disclosures, card]) {
                if (!disclosure.open)
                  disclosure.querySelector<HTMLElement>(':scope > summary')?.click()
              }
              return (card.querySelector('.tool-result')?.getBoundingClientRect().height ?? 0) > 0
            }, selector),
          { timeout: 15_000, timeoutMsg: 'Expected the deferred edit disclosure to open' },
        )
        await expect($(selector)).toHaveAttribute('data-status', 'done')
        await expect($(selector).$('.tool-result')).toBeDisplayed()
        await expect($(selector).$('.tool-result')).toHaveText(PARENT_INSTRUCTION_DEFERRAL)
      }
      await saveElementScreenshot(
        '.tool-card-rollup',
        'parent-instruction-same-response-deferred.png',
      )
      assertParentInstructionFiles(workspace, false)
    } finally {
      server.release(PARENT_INSTRUCTION_HOLD)
    }

    await waitForAgentIdle(30_000)
    await expectAssistantReply(PARENT_INSTRUCTION_REPLY)
    assertParentInstructionFiles(workspace, true)
    server.assertComplete()
  })
})
