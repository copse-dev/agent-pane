import { realpathSync } from 'node:fs'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// Real child loop and registry; scripted selection proves plumbing, not model quality.
describe('custom agent progressive skill access', () => {
  before(async () => {
    resetUserData()
    const workspaceRoot = seedStableWorkspace({
      files: {
        '.copse/agents/tiny-reader.md':
          '---\nname: tiny-reader\ndescription: Read a tiny workflow\ntools: read_skill\nreadonly: true\nmaxTurns: 6\n---\nRead the tiny-workflow skill, then its references/result.md file and report the result.',
        '.cursor/skills/tiny-workflow/SKILL.md':
          '---\nname: tiny-workflow\ndescription: Explain a tiny workflow\n---\nRead references/result.md for the workflow result.',
        '.cursor/skills/tiny-workflow/references/result.md':
          'The tiny workflow result is a silver birch.',
      },
    })
    seedEmptyProject(workspaceRoot, 'custom-skills-project', {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    writeSeedConfig({
      projects: [{ id: 'custom-skills-project', path: workspaceRoot, name: 'workspace' }],
      activeProjectId: 'custom-skills-project',
      trustedWorkspaceRoots: [realpathSync(workspaceRoot)],
      'threads:custom-skills-project': [],
    })
    await browser.reloadSession()
  })
  after(() => {
    resetUserData()
  })

  it('shows skill instructions and supporting reads inside the named child', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    const scenario = await installMockScenario({
      title: 'Child workflow skill',
      turns: [
        {
          user: { includes: 'tiny workflow' },
          responses: [
            { toolCalls: [{ name: 'read_skill', args: { name: 'tiny-workflow' } }] },
            {
              expectToolResults: [{ name: 'read_skill', includes: 'Read references/result.md' }],
              toolCalls: [
                {
                  name: 'read_skill',
                  args: { name: 'tiny-workflow', path: 'references/result.md' },
                },
              ],
            },
            {
              expectToolResults: [{ name: 'read_skill', includes: 'silver birch' }],
              text: 'The tiny workflow result is a silver birch.',
              continueTurn: true,
            },
            {
              text: 'The tiny-reader agent reports that the tiny workflow result is a silver birch.',
            },
          ],
        },
      ],
    })
    await setComposerValue('/tiny-reader Explain the tiny workflow.')
    await submitComposer()
    await waitForAgentIdle(30_000)
    await scenario.assertComplete()
    const card = $('.tool-card-subagent')
    await card.waitForDisplayed({ timeout: 10_000 })
    await expect(card).toHaveText('tiny-reader', { containing: true })
    if (!(await card.getProperty('open'))) await card.$('summary.tool-card-header').click()
    const reads = await $$('.subagent-inner-tool').getElements()
    expect(reads.length).toBe(2)
    for (const read of reads) {
      if (!(await read.getProperty('open'))) await read.$('summary').click()
    }
    await expect(card).toHaveText('Skill activated by the model: tiny-workflow', {
      containing: true,
    })
    await expect(card).toHaveText('UNTRUSTED SOURCE', { containing: true })
    await expect(card).toHaveText(
      'Supporting file for skill "tiny-workflow": references/result.md',
      { containing: true },
    )
    await expect(card).toHaveText('silver birch', { containing: true })
    // Keep both attributed reads and the child's report in the viewport. The
    // expanded trust text was asserted above and scrolls within each result.
    for (const read of reads) await read.$('summary').click()
    await saveElementScreenshot('.tool-card-subagent', 'custom-agent-skills.png')
  })
})
