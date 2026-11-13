import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../src/shared/safe-json.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

const PROJECT = 'context-project'
const CALLER = 'context-caller'
const GUIDANCE =
  'Renderer validation requires the focused browser test. The earlier run passed on its recorded checkout.'
const searchSchema = z.object({
  results: z.array(z.object({ id: z.string(), revision: z.string(), excerpt: z.string() })),
})

async function expandRuns(): Promise<void> {
  for (const rollup of await $$('.tool-card-rollup:not([open])')) {
    await rollup.scrollIntoView()
    await rollup.$('summary.tool-card-header').click()
  }
}

describe('project context retrieval through a native turn', function () {
  this.timeout(120_000)
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    resetUserData()
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    const workspace = seedStableWorkspace()
    const now = Date.UTC(2026, 10, 7)
    const source = {
      id: 'build-guidance',
      title: 'Build guidance',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [
        {
          id: 'saved-guidance',
          role: 'assistant',
          content: GUIDANCE,
          createdAt: now,
          toolCalls: [],
        },
      ],
    }
    writeSeedConfig({
      projects: [
        { id: PROJECT, path: workspace, name: 'Workbench' },
        { id: 'context-other', path: '/other-project', name: 'Other project' },
      ],
      activeProjectId: PROJECT,
      activeThreadId: CALLER,
      [`threads:${PROJECT}`]: [
        source,
        { ...source, id: CALLER, title: 'Find earlier build guidance', messages: [] },
      ],
      'threads:context-other': [
        {
          ...source,
          messages: [
            {
              id: 'foreign',
              role: 'assistant',
              content: 'Renderer validation FOREIGN PROJECT SECRET',
              createdAt: now,
              toolCalls: [],
            },
          ],
        },
      ],
    })
    writeSettings({ threadReadAccess: [CALLER] })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('sends scoped search results to the provider, reads their revision and displays source metadata', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    const pluginSelector = '.plugin-row[data-plugin-id="copse.project-context"]'
    const plugin = $(pluginSelector)
    await plugin.waitForExist()
    await plugin.scrollIntoView()
    await expect(plugin).toHaveAttribute('data-enabled', 'false')
    await expect(plugin.$('.plugin-badge-experimental')).toHaveText('Experimental', {
      ignoreCase: true,
    })
    await saveElementScreenshot(pluginSelector, 'settings-project-context-plugin.png')
    await plugin.$('label.plugin-toggle').click()
    await expect($(pluginSelector)).toHaveAttribute('data-enabled', 'true')
    await $('#settings-close').click()
    const prompt = 'Find the earlier build guidance.'
    const scenario = await installMockScenario({
      title: 'Find earlier build guidance',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'search_project_context',
                  args: { query: 'renderer validation', kinds: ['evidence'], limit: 1 },
                },
              ],
            },
            {
              text: 'I found the earlier guidance and its recorded source.',
              expectToolResults: [{ name: 'search_project_context', includes: GUIDANCE }],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await scenario.waitForComplete(30_000)
    await scenario.assertComplete()
    await waitForAgentIdle()
    await expandRuns()
    const searchCard = $('.tool-card*=Searched project history')
    await searchCard.waitForExist()
    await searchCard.scrollIntoView()
    await searchCard.$('summary.tool-card-header').click()
    const output = await searchCard.$('.tool-result').getText()
    assert.doesNotMatch(output, /FOREIGN PROJECT SECRET/)
    const parsed = safeJsonParse(
      output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
      decodeWithSchema(searchSchema),
    )
    assert.ok(parsed)
    assert.equal(parsed.results.length, 1)
    const source = parsed.results[0]
    assert.ok(source)
    assert.equal(source.excerpt, GUIDANCE)
    await searchCard.$('summary.tool-card-header').click()

    const readPrompt = 'Read that source before continuing.'
    const readScenario = await installMockScenario({
      title: 'Find earlier build guidance',
      turns: [
        {
          user: readPrompt,
          responses: [
            {
              toolCalls: [
                {
                  name: 'read_project_context',
                  args: { id: source.id, revision: source.revision },
                },
              ],
            },
            {
              text: 'The source calls for a focused browser test. Its earlier pass does not establish that the current checkout passes.',
              expectToolResults: [{ name: 'read_project_context', includes: GUIDANCE }],
            },
          ],
        },
      ],
    })
    await setComposerValue(readPrompt)
    await submitComposer()
    await readScenario.waitForComplete(30_000)
    await readScenario.assertComplete()
    await waitForAgentIdle()
    await expandRuns()
    const readCard = $('.tool-card*=Read project history')
    await readCard.waitForExist()
    await readCard.scrollIntoView()
    await readCard.$('summary.tool-card-header').click()
    await expect(readCard.$('.tool-result')).toBeDisplayed()
    const readOutput = await readCard.$('.tool-result').getText()
    assert.ok(readOutput.includes(GUIDANCE))
    assert.match(readOutput, /saved-guidance\.md/)
    assert.match(readOutput, /historical/)
    assert.match(readOutput, /"store":\s*"workspace"/)
    assert.match(readOutput, /context-project\/build-guidance\/messages\/saved-guidance\.md/)
    assert.doesNotMatch(readOutput, /\/Users\/|\/home\//)
    assert.doesNotMatch(readOutput, /FOREIGN PROJECT SECRET/)
    await readCard.scrollIntoView()
    const readToolId = await readCard.getAttribute('data-tool-id')
    assert.ok(readToolId)
    await saveElementScreenshot(
      `.tool-card[data-tool-id=${JSON.stringify(readToolId)}]`,
      'project-context-retrieval.png',
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="customise"]').click()
    await $(pluginSelector).scrollIntoView()
    await $(pluginSelector).$('label.plugin-toggle').click()
    await expect($(pluginSelector)).toHaveAttribute('data-enabled', 'false')
    await $('#settings-close').click()
  })
})
