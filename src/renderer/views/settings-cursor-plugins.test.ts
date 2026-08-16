// Cursor-installed plugins in the one plugin list.
//
// They used to sit in a separate "From Cursor" group at the bottom of the list,
// in a dashed card, with no switch — which left the question the list exists to
// answer unanswered. Are they on? They are: nothing gates `~/.cursor/plugins`,
// so `skills-registry.ts` adds every discovered plugin's skills and
// `mcp-registry.ts` reads every discovered plugin's MCP config, unconditionally.
//
// So the row claims Active, and these tests hold that claim to the same shape as
// every other row: it sorts into the Active group by id rather than trailing the
// list, it carries a switch that is on, and the switch is disabled — Cursor owns
// the lifecycle, so the state is real but the control is visibly not ours.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { CursorPluginSummary } from '@shared/types/cursor-plugins.ts'
import type { PluginSummary, PluginsListResult } from '@shared/types/plugins.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

function registryPlugin(id: string, enabled: boolean): PluginSummary {
  return {
    id,
    trust: 'first-party',
    stability: 'stable',
    name: id,
    enabled,
    contributions: {
      toolNames: [],
      modelRoutes: [],
      browserOrigins: [],
      blockingHooks: [],
      asyncHooks: [],
      commandHooks: [],
      promptBlocks: [],
      ui: [],
      followUps: [],
      capabilities: [],
      permissions: [],
    },
    settings: [],
  }
}

const CURSOR_PLUGIN: CursorPluginSummary = {
  name: 'huggingface-skills',
  root: '/Users/dev/.cursor/plugins/cache/cursor-public/huggingface-skills/d7223848',
  description: 'Agent Skills for AI/ML tasks.',
  version: '1.0.8',
  skillsDir: '/Users/dev/.cursor/plugins/cache/cursor-public/huggingface-skills/d7223848/skills',
  mcpConfigPath:
    '/Users/dev/.cursor/plugins/cache/cursor-public/huggingface-skills/d7223848/.mcp.json',
}

function stubApi(plugins: PluginsListResult, cursorPlugins: CursorPluginSummary[]): ApiClient {
  return createPendingApi({
    'instructions.list': () => Promise.resolve([]),
    'cursorRules.list': () => Promise.resolve([]),
    'skills.list': () => Promise.resolve([]),
    'hooks.list': () => Promise.resolve({ hooks: [], warnings: [] }),
    'plugins.list': () => Promise.resolve(plugins),
    'cursorPlugins.list': () => Promise.resolve(cursorPlugins),
  })
}

async function openCustomise(
  plugins: PluginsListResult,
  cursorPlugins: CursorPluginSummary[],
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore(), stubApi(plugins, cursorPlugins))
  const btn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="customise"]',
  )
  assert.ok(btn)
  btn.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('plugins-list')
  assert.ok(list)
  return list
}

function cursorRow(list: HTMLElement): HTMLElement {
  const row = list.querySelector<HTMLElement>('.plugin-row[data-plugin-origin="cursor"]')
  assert.ok(row)
  return row
}

describe('settings → Cursor plugins in the plugin list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reports the plugin as active, with a switch that is on', async () => {
    const list = await openCustomise({ plugins: [] }, [CURSOR_PLUGIN])
    const row = cursorRow(list)

    assert.equal(row.dataset['enabled'], 'true')
    const toggle = row.querySelector<HTMLInputElement>('.plugin-toggle-input')
    assert.ok(toggle, 'a Cursor row carries the same switch as every other row')
    assert.equal(toggle.checked, true)
    // Cursor owns the lifecycle. The state is real; the control is not ours.
    assert.equal(toggle.disabled, true)
    assert.match(
      row.querySelector('.plugin-toggle')?.getAttribute('title') ?? '',
      /Managed by Cursor/,
    )
  })

  it('sorts into the Active group by id rather than trailing the list', async () => {
    // 'a.first' sorts before 'huggingface-skills', 'z.last' after — so a correct
    // merge interleaves rather than appending a Cursor block at the end.
    const list = await openCustomise(
      { plugins: [registryPlugin('z.last', true), registryPlugin('a.first', true)] },
      [CURSOR_PLUGIN],
    )

    const ids = [...list.querySelectorAll<HTMLElement>('.plugin-row')].map(
      (row) => row.dataset['pluginId'],
    )
    assert.deepEqual(ids, ['a.first', 'huggingface-skills', 'z.last'])

    const headings = [...list.querySelectorAll('.plugins-group-heading')].map((h) => h.textContent)
    assert.deepEqual(headings, ['Active'], 'no separate "From Cursor" section')
  })

  it('groups under Active while a disabled registry plugin stays under Inactive', async () => {
    const list = await openCustomise({ plugins: [registryPlugin('a.off', false)] }, [CURSOR_PLUGIN])
    const headings = [...list.querySelectorAll('.plugins-group-heading')].map((h) => h.textContent)
    assert.deepEqual(headings, ['Active', 'Inactive'])

    const rows = [...list.querySelectorAll<HTMLElement>('.plugin-row')]
    assert.equal(rows[0]?.dataset['pluginOrigin'], 'cursor', 'the running plugin sorts first')
    assert.equal(rows[1]?.dataset['pluginId'], 'a.off')
  })

  it('names the origin and shows a Cursor mark rather than an initial tile', async () => {
    const list = await openCustomise({ plugins: [] }, [CURSOR_PLUGIN])
    const row = cursorRow(list)

    assert.equal(row.querySelector('.plugin-badge-cursor')?.textContent, 'Cursor')
    const icon = row.querySelector('.plugin-icon-cursor')
    assert.ok(icon, 'the origin reads as a mark, not a letter')
    // Cursor's real asset, the same way a first-party row uses the Copse one —
    // a mark stands for who made the thing, so it is not ours to redraw.
    assert.equal(icon.querySelector('img')?.getAttribute('src'), './cursor-mark.svg')

    // Same row furniture as every other plugin, not a bespoke card.
    assert.equal(row.classList.contains('plugin-row'), true)
    assert.match(row.querySelector('.plugin-row-desc')?.textContent ?? '', /AI\/ML tasks/)
    assert.equal(row.querySelector('.plugin-version')?.textContent, '1.0.8')
    const chips = [...row.querySelectorAll('.plugin-chip')].map((c) => c.textContent)
    assert.deepEqual(chips, ['Skills', 'MCP servers'])
  })
})

describe('settings → plugin settings disclosure', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  // The chevron is built by outlineIcon, which *replaces* the class rather than
  // appending — so omitting `ui-icon` costs the icon its `fill: none; stroke:
  // currentColor` and the path renders as a solid triangle instead of the
  // outline chevron every other disclosure in the app uses.
  it('renders the disclosure chevron as a stroked outline icon', async () => {
    // The fold only renders when it has something to hold, so give it a field.
    const plugin: PluginSummary = {
      ...registryPlugin('a.plugin', true),
      settings: [{ id: 'budget', kind: 'number', title: 'Budget', value: 3 }],
    }
    const list = await openCustomise({ plugins: [plugin] }, [])
    const chevron = list.querySelector('.plugin-settings-chevron')
    assert.ok(chevron)
    assert.equal(chevron.classList.contains('ui-icon'), true)
  })
})
