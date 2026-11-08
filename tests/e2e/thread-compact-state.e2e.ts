import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import {
  resetUserData,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const projectId = 'compact-worker-project'
const owner = 'compact-coordinator'

describe('compact saved worker state', () => {
  before(async () => {
    resetUserData()
    const root = seedStableWorkspace()
    writeSettings({
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      threadReadAccess: [owner],
    })
    const base = {
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    writeSeedConfig({
      projects: [{ id: projectId, path: root, name: 'Worker coordination' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: owner,
      [`threads:${projectId}`]: [
        {
          ...base,
          id: owner,
          title: 'Coordinate the repair',
          draftPrompt: 'Check saved worker state',
          messages: [],
        },
        {
          ...base,
          id: 'compact-repair-worker',
          title: 'Repair worker',
          workingBrief: 'Own the label repair. Verification belongs to the other worker.',
          todos: [{ id: 'repair', content: 'Repair label normalization', status: 'completed' }],
          gitBranch: 'codex/repair-label',
          messages: [
            {
              id: 'repair-history',
              role: 'assistant',
              content: 'PRIVATE_TRANSCRIPT_BODY',
              createdAt: 1,
              toolCalls: [],
            },
          ],
        },
        {
          ...base,
          id: 'compact-verify-worker',
          title: 'Verification worker',
          workingBrief: 'Own independent tests and report remaining gaps.',
          todos: [{ id: 'verify', content: 'Run independent label checks', status: 'in_progress' }],
          gitBranch: 'codex/verify-label',
          messages: [
            {
              id: 'verify-history',
              role: 'assistant',
              content: 'UNRELATED_OLD_TOOL_LOG',
              createdAt: 1,
              toolCalls: [],
            },
          ],
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows both owners and bounded saved plans without replaying transcripts', async () => {
    const prompt = 'Check the workers’ saved ownership and plans.'
    const reply =
      'The repair is marked complete; independent verification is still in progress. Saved state is not acceptance evidence.'
    const scenario = await installMockScenario({
      title: 'Check saved worker state',
      turns: [
        {
          user: prompt,
          responses: [
            {
              toolCalls: [
                { name: 'list_threads', args: { project_id: projectId, include_state: true } },
              ],
            },
            {
              text: reply,
              expectToolResults: [
                { name: 'list_threads', includes: 'Run independent label checks' },
              ],
            },
          ],
        },
      ],
    })
    await setComposerValue(prompt)
    await submitComposer()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await expectAssistantReply(reply)
    const rollup = $('.tool-card-rollup')
    if ((await rollup.isExisting()) && !(await rollup.getProperty('open')))
      await rollup.$('summary').click()
    const tool = $('.tool-card:not(.tool-card-rollup)')
    await tool.waitForExist({ timeout: 15_000 })
    if (!(await tool.getProperty('open'))) await tool.$('summary').click()
    await tool.$('.tool-result').waitForDisplayed({ timeout: 10_000 })
    const content = await tool.getText()
    assert.match(content, /stored-metadata/)
    assert.match(content, /Repair label normalization/)
    assert.match(content, /Run independent label checks/)
    assert.match(content, /recorded-not-verified/)
    assert.doesNotMatch(content, /PRIVATE_TRANSCRIPT_BODY|UNRELATED_OLD_TOOL_LOG/)
    // The native result contains the profile's temporary path. Assert it while
    // expanded, then capture the normal completed disclosure without path noise.
    await tool.$('summary').click()
    await saveAppScreenshot('thread-compact-worker-state.png')
  })
})
