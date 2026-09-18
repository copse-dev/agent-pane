import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type {
  ToolPermissionCatalog,
  ToolPermissionPolicy,
  ToolPermissionReset,
  ToolPermissionUpdate,
} from '@shared/types/tool-permissions.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createToolPermissionsPanel } from './tool-permissions-panel.ts'

function catalog(): ToolPermissionCatalog {
  return {
    groups: [
      {
        id: 'copse',
        name: 'Copse tools',
        kind: 'copse',
        tools: [
          {
            id: 'copse:read-file',
            executionName: 'read_file',
            name: 'Read file',
            description: 'Read a file in the active project.',
            policy: 'allow',
            defaultPolicy: 'allow',
            overridden: false,
          },
          {
            id: 'copse:prepare-worktree',
            executionName: 'prepare_worktree',
            name: 'Prepare worktree',
            description: 'Create an isolated checkout for a new thread.',
            policy: 'ask',
            defaultPolicy: 'ask',
            overridden: false,
            disabledPolicies: ['allow'],
            disabledReason: 'Worktree preparation always requires approval.',
          },
        ],
      },
      {
        id: 'mcp:project:proton',
        name: 'proton-mcp',
        kind: 'mcp',
        origin: 'project',
        originDetail: '/workspace/.mcp.json',
        status: 'connected',
        tools: [
          {
            id: 'mcp:project:proton:list-mail',
            executionName: 'mcp__proton__list_mail',
            name: 'List mail',
            description: 'List messages in a folder.',
            policy: 'ask',
            defaultPolicy: 'ask',
            overridden: false,
          },
          {
            id: 'mcp:project:proton:send-mail',
            executionName: 'mcp__proton__send_mail',
            name: 'Send mail',
            description: 'Send a new message.',
            policy: 'block',
            defaultPolicy: 'ask',
            overridden: true,
          },
        ],
      },
      {
        id: 'mcp:project:offline',
        name: 'offline-mcp',
        kind: 'mcp',
        origin: 'project',
        originDetail: '/workspace/.mcp.json',
        status: 'disabled',
        tools: [],
      },
    ],
  }
}

function updateCatalog(
  current: ToolPermissionCatalog,
  ids: readonly string[],
  policy?: ToolPermissionPolicy,
): ToolPermissionCatalog {
  const selected = new Set(ids)
  return {
    groups: current.groups.map((group) => ({
      ...group,
      tools: group.tools.map((tool) =>
        selected.has(tool.id)
          ? policy
            ? { ...tool, policy, overridden: true }
            : { ...tool, policy: tool.defaultPolicy, overridden: false }
          : tool,
      ),
    })),
  }
}

interface ApiHarness {
  api: ApiClient['toolPermissions']
  sets: ToolPermissionUpdate[]
  resets: ToolPermissionReset[]
}

function apiHarness(options?: {
  failSet?: boolean
  initialCatalog?: ToolPermissionCatalog
}): ApiHarness {
  let current = options?.initialCatalog ?? catalog()
  const sets: ToolPermissionUpdate[] = []
  const resets: ToolPermissionReset[] = []
  return {
    sets,
    resets,
    api: {
      list: async () => structuredClone(current),
      set: async (update): Promise<ToolPermissionCatalog> => {
        sets.push(update)
        if (options?.failSet) throw new Error('Settings write failed')
        current = updateCatalog(current, update.toolIds, update.policy)
        return structuredClone(current)
      },
      reset: async (reset): Promise<ToolPermissionCatalog> => {
        resets.push(reset)
        current = updateCatalog(current, reset.toolIds)
        return structuredClone(current)
      },
    },
  }
}

async function mount(harness: ApiHarness): Promise<HTMLElement> {
  const panel = createToolPermissionsPanel(harness.api)
  document.body.append(panel.root)
  await panel.refresh()
  return panel.root
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('tool permissions panel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders grouped tools, metadata, accessible choices, and fixed restrictions', async () => {
    const root = await mount(apiHarness())
    const groups = root.querySelectorAll('.tool-permission-group')
    assert.equal(groups.length, 3)
    assert.match(groups[0]?.textContent ?? '', /Copse tools/)
    assert.match(groups[0]?.textContent ?? '', /2/)
    assert.match(groups[1]?.textContent ?? '', /proton-mcp/)
    assert.match(groups[1]?.textContent ?? '', /project/)
    assert.match(groups[1]?.textContent ?? '', /connected/)
    assert.match(groups[2]?.textContent ?? '', /offline-mcp/)
    assert.match(groups[2]?.textContent ?? '', /disabled/)
    assert.match(groups[2]?.textContent ?? '', /has not reported any tools/)
    assert.match(root.textContent, /Read a file in the active project/)

    const readRow = root.querySelector<HTMLElement>('[data-tool-id="copse:read-file"]')
    assert.ok(readRow)
    assert.equal(readRow.dataset['policy'], 'allow')
    assert.equal(
      readRow.querySelector('.tool-permission-inherited')?.getAttribute('aria-label'),
      'Using inherited default: Always allow',
    )
    assert.equal(
      readRow
        .querySelector('[aria-label="Always allow for Read file"]')
        ?.getAttribute('aria-checked'),
      'true',
    )

    const fixedAllow = root.querySelector<HTMLButtonElement>(
      '[aria-label="Always allow for Prepare worktree"]',
    )
    assert.ok(fixedAllow)
    assert.equal(fixedAllow.disabled, true)
    assert.equal(fixedAllow.title, 'Worktree preparation always requires approval.')
  })

  it('summarises a group whose effective defaults all match', async () => {
    const initialCatalog = catalog()
    const proton = initialCatalog.groups.find((group) => group.id === 'mcp:project:proton')
    assert.ok(proton)
    const ask: ToolPermissionPolicy = 'ask'
    proton.tools = proton.tools.map((tool) => ({
      ...tool,
      policy: ask,
      defaultPolicy: ask,
      overridden: false,
    }))

    const root = await mount(apiHarness({ initialCatalog }))
    const select = root.querySelector<HTMLSelectElement>(
      '[aria-label="Set all permissions in proton-mcp"]',
    )
    assert.equal(select?.value, 'ask')
  })

  it('filters by server or tool while group actions still target every named-group tool', async () => {
    const harness = apiHarness()
    const root = await mount(harness)
    const search = root.querySelector<HTMLInputElement>('.tool-permissions-search')
    assert.ok(search)

    search.value = 'proton'
    search.dispatchEvent(new Event('input'))
    assert.equal(root.querySelectorAll('.tool-permission-row').length, 2)

    search.value = 'send mail'
    search.dispatchEvent(new Event('input'))
    assert.equal(root.querySelectorAll('.tool-permission-row').length, 1)
    assert.match(root.textContent, /Send mail/)
    assert.doesNotMatch(root.textContent, /List mail/)

    const select = root.querySelector<HTMLSelectElement>(
      '[aria-label="Set all permissions in proton-mcp"]',
    )
    assert.ok(select)
    assert.equal(select.value, 'mixed')
    select.value = 'allow'
    select.dispatchEvent(new Event('change'))
    await settle()

    assert.deepEqual(harness.sets, [
      {
        toolIds: ['mcp:project:proton:list-mail', 'mcp:project:proton:send-mail'],
        policy: 'allow',
      },
    ])
  })

  it('turns the inherited hint into an explicit override when selected', async () => {
    const harness = apiHarness()
    const root = await mount(harness)
    const ask = root.querySelector<HTMLButtonElement>('[aria-label="Always ask for List mail"]')
    assert.ok(ask)
    assert.equal(ask.getAttribute('aria-checked'), 'true')
    assert.equal(
      root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:list-mail"]')?.dataset[
        'overridden'
      ],
      'false',
    )
    ask.click()
    await settle()

    assert.deepEqual(harness.sets, [{ toolIds: ['mcp:project:proton:list-mail'], policy: 'ask' }])
    const row = root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:list-mail"]')
    assert.ok(row)
    assert.equal(row.dataset['overridden'], 'true')
    assert.equal(
      row.querySelector('[aria-label="Always ask for List mail"]')?.getAttribute('aria-checked'),
      'true',
    )
  })

  it('supports arrow-key selection and restores focus after saving', async () => {
    const harness = apiHarness()
    const root = await mount(harness)
    const ask = root.querySelector<HTMLButtonElement>('[aria-label="Always ask for List mail"]')
    assert.ok(ask)
    ask.focus()
    const KeyboardEventCtor = document.defaultView?.KeyboardEvent
    assert.ok(KeyboardEventCtor)
    ask.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'ArrowRight', bubbles: true }))
    await settle()

    assert.deepEqual(harness.sets, [{ toolIds: ['mcp:project:proton:list-mail'], policy: 'block' }])
    const blocked = root.querySelector<HTMLButtonElement>('[aria-label="Blocked for List mail"]')
    assert.equal(document.activeElement, blocked)
    assert.equal(blocked?.getAttribute('aria-checked'), 'true')
  })

  it('rolls an optimistic selection back and explains a failed save', async () => {
    const root = await mount(apiHarness({ failSet: true }))
    const button = root.querySelector<HTMLButtonElement>(
      '[aria-label="Always allow for List mail"]',
    )
    assert.ok(button)
    button.click()

    assert.equal(
      root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:list-mail"]')?.dataset[
        'policy'
      ],
      'allow',
    )
    assert.equal(root.dataset['pending'], 'true')
    assert.match(root.querySelector('.tool-permissions-status')?.textContent ?? '', /Saving/)

    await settle()

    assert.equal(
      root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:list-mail"]')?.dataset[
        'policy'
      ],
      'ask',
    )
    assert.equal(root.dataset['pending'], 'false')
    assert.match(
      root.querySelector('.tool-permissions-status')?.textContent ?? '',
      /Could not save: Settings write failed/,
    )
  })

  it('resets one override without touching the rest of the catalog', async () => {
    const harness = apiHarness()
    const root = await mount(harness)
    const reset = root.querySelector<HTMLButtonElement>(
      '[aria-label="Use default permission for Send mail"]',
    )
    assert.ok(reset)
    assert.equal(reset.hidden, false)
    reset.click()
    await settle()

    assert.deepEqual(harness.resets, [{ toolIds: ['mcp:project:proton:send-mail'] }])
    const row = root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:send-mail"]')
    assert.ok(row)
    assert.equal(row.dataset['policy'], 'ask')
    assert.equal(row.dataset['overridden'], 'false')
    assert.equal(row.querySelector<HTMLElement>('.tool-permission-inherited')?.hidden, false)
  })

  it('resets every current tool by explicit id', async () => {
    const harness = apiHarness()
    const root = await mount(harness)
    const resetAll = root.querySelector<HTMLButtonElement>('.tool-permissions-reset-all')
    assert.ok(resetAll)
    assert.equal(resetAll.hidden, false)
    resetAll.click()
    await settle()

    assert.deepEqual(harness.resets, [
      {
        toolIds: [
          'copse:read-file',
          'copse:prepare-worktree',
          'mcp:project:proton:list-mail',
          'mcp:project:proton:send-mail',
        ],
      },
    ])
    assert.equal(
      root.querySelector<HTMLElement>('[data-tool-id="mcp:project:proton:send-mail"]')?.dataset[
        'overridden'
      ],
      'false',
    )
    assert.equal(resetAll.hidden, true)
  })
})
