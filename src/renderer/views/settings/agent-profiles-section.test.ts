import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentProfile } from '../../../shared/agent-profiles.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createAgentProfilesSection } from './agent-profiles-section.ts'

const REVIEWER: AgentProfile = {
  id: 'reviewer',
  name: 'Reviewer',
  model: 'claude-sonnet-5-5',
  instructions: 'Review first.',
}

describe('agent profiles settings', () => {
  it('keeps a profile’s model when its first Edit saves before the model list loads', async () => {
    const base = createFakeApi()
    let stored: unknown = [REVIEWER]
    const api = {
      ...base,
      settings: {
        ...base.settings,
        get: (key: string): Promise<unknown> =>
          key === 'agentProfiles' ? Promise.resolve(stored) : base.settings.get(key),
        set: (key: string, value: unknown): Promise<void> => {
          if (key === 'agentProfiles') stored = value
          return Promise.resolve()
        },
      },
    }
    const section = createAgentProfilesSection(api)
    await section.refresh()
    const edit = section.root.querySelector<HTMLButtonElement>(
      '.agent-profile-row[data-profile-id="reviewer"] button',
    )
    assert.ok(edit)
    edit.click()
    const name = section.root.querySelector<HTMLInputElement>('.agent-profile-name')
    assert.ok(name)
    name.value = 'Reviewer 2'
    section.root.querySelector<HTMLButtonElement>('.agent-profile-save')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(stored, [{ ...REVIEWER, name: 'Reviewer 2' }])
  })
})
