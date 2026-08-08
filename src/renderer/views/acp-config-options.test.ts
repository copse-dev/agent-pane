import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import {
  ACP_MODE_GROUP_ID,
  acpOptionGroupsFor,
  loadAcpOptionGroups,
  saveAcpOptionSelection,
} from './acp-config-options.ts'

/**
 * The composer picker's ACP selectors. ACP v1 exposes two mechanisms — the
 * generic `configOptions` list (reasoning level and anything else the agent
 * advertises) and the older `modes` state — and both surface here as the same
 * kind of row, so the tests pin which one backs a given group and where a pick
 * is persisted.
 */

const AGENT: AcpAgentConfig = {
  id: 'claude',
  title: 'Claude Code',
  command: 'claude-code-acp',
  enabled: true,
  availableConfigOptions: [
    {
      configId: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'sonnet',
      choices: [
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'opus', label: 'Opus' },
      ],
    },
    {
      configId: 'thinking',
      name: 'Thinking effort',
      category: 'thought_level',
      currentValue: 'medium',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    },
  ],
  availablePermissionModes: [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept edits' },
  ],
}

function fakeSettings(agents: AcpAgentConfig[]): {
  api: {
    settings: {
      get: (key: string) => Promise<unknown>
      set: (k: string, v: unknown) => Promise<void>
    }
  }
  written: () => unknown
} {
  let written: unknown = null
  return {
    api: {
      settings: {
        get: () => Promise.resolve(agents),
        set: (_key: string, value: unknown): Promise<void> => {
          written = value
          return Promise.resolve()
        },
      },
    },
    written: () => written,
  }
}

describe('acpOptionGroupsFor', () => {
  it('offers the agent’s non-model selectors, plus its session modes', () => {
    assert.deepEqual(
      acpOptionGroupsFor(AGENT).map((group) => [group.id, group.kind, group.label]),
      [
        // The model category is deliberately absent: the picker's own list owns it.
        ['thinking', 'config', 'Thinking effort'],
        [ACP_MODE_GROUP_ID, 'mode', 'Mode'],
      ],
    )
  })

  it('prefers a saved choice over the agent’s default', () => {
    const groups = acpOptionGroupsFor({
      ...AGENT,
      configOptions: { thinking: 'high' },
      permissionMode: 'acceptEdits',
    })

    assert.equal(groups[0]?.currentValue, 'high')
    assert.equal(groups[1]?.currentValue, 'acceptEdits')
  })

  it('drops selectors with nothing to choose between', () => {
    assert.deepEqual(
      acpOptionGroupsFor({
        ...AGENT,
        availableConfigOptions: [
          {
            configId: 'thinking',
            name: 'Thinking effort',
            category: 'thought_level',
            currentValue: 'only',
            choices: [{ value: 'only', label: 'Only' }],
          },
        ],
        availablePermissionModes: [{ value: 'default', label: 'Default' }],
      }),
      [],
    )
  })

  it('does not double up when the agent ships modes as a config option', () => {
    const groups = acpOptionGroupsFor({
      ...AGENT,
      availableConfigOptions: [
        {
          configId: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'default',
          choices: [
            { value: 'default', label: 'Default' },
            { value: 'plan', label: 'Plan' },
          ],
        },
      ],
    })

    assert.deepEqual(
      groups.map((group) => group.id),
      ['mode'],
    )
  })

  it('surfaces an uncategorized selector rather than hiding it', () => {
    const groups = acpOptionGroupsFor({
      ...AGENT,
      availableConfigOptions: [
        {
          configId: 'verbosity',
          name: 'Verbosity',
          category: 'other',
          currentValue: 'normal',
          choices: [
            { value: 'terse', label: 'Terse' },
            { value: 'normal', label: 'Normal' },
          ],
        },
      ],
      availablePermissionModes: [],
    })

    assert.deepEqual(
      groups.map((group) => group.label),
      ['Verbosity'],
    )
  })
})

describe('loadAcpOptionGroups', () => {
  it('resolves the agent behind an acp: model value', async () => {
    const { api } = fakeSettings([AGENT])
    const loaded = await loadAcpOptionGroups(api, 'acp:claude#opus')
    assert.ok(loaded)
    assert.equal(loaded.agentId, 'claude')
    assert.equal(loaded.groups.length, 2)
  })

  it('returns null for non-ACP models, unknown ids, and disabled agents', async () => {
    const { api } = fakeSettings([AGENT])
    assert.equal(await loadAcpOptionGroups(api, 'claude-sonnet-4-6'), null)
    assert.equal(await loadAcpOptionGroups(api, 'acp:nope'), null)

    const { api: disabled } = fakeSettings([{ ...AGENT, enabled: false }])
    assert.equal(await loadAcpOptionGroups(disabled, 'acp:claude'), null)
  })

  it('returns null for an agent that has never been probed', async () => {
    const { api } = fakeSettings([
      { id: 'x', title: 'X', command: 'x', enabled: true } satisfies AcpAgentConfig,
    ])
    assert.equal(await loadAcpOptionGroups(api, 'acp:x'), null)
  })
})

describe('saveAcpOptionSelection', () => {
  it('writes a config option under its configId', async () => {
    const { api, written } = fakeSettings([AGENT])
    await saveAcpOptionSelection(api, 'claude', { id: 'thinking', kind: 'config' }, 'high')

    assert.deepEqual(written(), [{ ...AGENT, configOptions: { thinking: 'high' } }])
  })

  it('writes a session mode to permissionMode instead', async () => {
    const { api, written } = fakeSettings([AGENT])
    await saveAcpOptionSelection(api, 'claude', { id: ACP_MODE_GROUP_ID, kind: 'mode' }, 'plan')

    assert.deepEqual(written(), [{ ...AGENT, permissionMode: 'plan' }])
  })

  it('leaves other agents and other options untouched', async () => {
    const other: AcpAgentConfig = { id: 'other', title: 'Other', command: 'o', enabled: true }
    const { api, written } = fakeSettings([
      { ...AGENT, configOptions: { thinking: 'low', verbosity: 'terse' } },
      other,
    ])
    await saveAcpOptionSelection(api, 'claude', { id: 'thinking', kind: 'config' }, 'high')

    assert.deepEqual(written(), [
      { ...AGENT, configOptions: { thinking: 'high', verbosity: 'terse' } },
      other,
    ])
  })
})
