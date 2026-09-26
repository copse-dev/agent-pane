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
import type {
  BundledSkillPluginSummary,
  CursorPluginSummary,
} from '@shared/types/cursor-plugins.ts'
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
      instructionSources: [],
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

function stubApi(
  plugins: PluginsListResult,
  cursorPlugins: CursorPluginSummary[],
  bundledPlugins: BundledSkillPluginSummary[] = [],
  overrides: Readonly<Record<string, (...args: never[]) => unknown>> = {},
): ApiClient {
  return createPendingApi({
    'instructions.list': () => Promise.resolve([]),
    'cursorRules.list': () => Promise.resolve([]),
    'skills.list': () => Promise.resolve([]),
    'agents.list': () => Promise.resolve({ agents: [], skipped: [], shadowed: [] }),
    'hooks.list': () => Promise.resolve({ hooks: [], warnings: [] }),
    'plugins.list': () => Promise.resolve(plugins),
    'cursorPlugins.list': () => Promise.resolve(cursorPlugins),
    'bundledSkillPlugins.list': () => Promise.resolve(bundledPlugins),
    ...overrides,
  })
}

async function openCustomise(
  plugins: PluginsListResult,
  cursorPlugins: CursorPluginSummary[],
  api: ApiClient = stubApi(plugins, cursorPlugins),
): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore(), api)
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

const PSTACK: BundledSkillPluginSummary = {
  name: 'pstack',
  description: 'Rigorous agent workflows.',
  version: '0.9.2',
  skillCount: 36,
  enabled: false,
  defaultEnabled: false,
  offByDefaultReason: 'Written for Cursor.',
  suppressed: false,
}

const TEAM_KIT: BundledSkillPluginSummary = {
  name: 'cursor-team-kit',
  skillCount: 1,
  enabled: true,
  defaultEnabled: true,
  suppressed: false,
}

describe('settings → bundled Cursor plugins in the plugin list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function bundledRow(list: HTMLElement, name: string): HTMLElement {
    const row = list.querySelector<HTMLElement>(
      `.plugin-row[data-plugin-origin="bundled"][data-plugin-id="${name}"]`,
    )
    assert.ok(row)
    return row
  }

  it('gives each bundled plugin a live switch and groups it by its own state', async () => {
    const list = await openCustomise(
      { plugins: [] },
      [],
      stubApi({ plugins: [] }, [], [PSTACK, TEAM_KIT]),
    )
    const ids = [...list.querySelectorAll<HTMLElement>('.plugin-row')].map(
      (row) => row.dataset['pluginId'],
    )
    assert.deepEqual(ids, ['cursor-team-kit', 'pstack'], 'Active first, then Inactive')

    const pstack = bundledRow(list, 'pstack')
    const toggle = pstack.querySelector<HTMLInputElement>('.plugin-toggle-input')
    assert.ok(toggle)
    assert.equal(toggle.checked, false)
    assert.equal(toggle.disabled, false, 'Copse vendors it, so the switch is ours')
    assert.equal(pstack.querySelector('.plugin-badge-cursor')?.textContent, 'Cursor · Bundled')
    assert.equal(
      pstack.querySelector('.plugin-default-off-note')?.textContent,
      'Off by default. Written for Cursor.',
    )
    assert.deepEqual(
      [...pstack.querySelectorAll('.plugin-chip')].map((chip) => chip.textContent),
      ['36 skills'],
    )
    assert.equal(
      bundledRow(list, 'cursor-team-kit').querySelector('.plugin-default-off-note'),
      null,
    )
  })

  it("saves the switch into the per-plugin choices, keeping the others'", async () => {
    const writes: unknown[] = []
    const api = stubApi({ plugins: [] }, [], [PSTACK], {
      'settings.get': (key: string) =>
        Promise.resolve(
          key === 'bundledSkillPluginOverrides' ? { 'cursor-team-kit': false } : null,
        ),
      'settings.set': (key: string, value: unknown) => {
        if (key === 'bundledSkillPluginOverrides') writes.push(value)
        return Promise.resolve()
      },
    })
    const list = await openCustomise({ plugins: [] }, [], api)
    const toggle = bundledRow(list, 'pstack').querySelector<HTMLInputElement>(
      '.plugin-toggle-input',
    )
    assert.ok(toggle)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(writes, [{ 'cursor-team-kit': false, pstack: true }])
  })

  it('locks every switch while all bundled skills are off, and says where to change it', async () => {
    const list = await openCustomise(
      { plugins: [] },
      [],
      stubApi({ plugins: [] }, [], [{ ...TEAM_KIT, suppressed: true }]),
    )
    const row = bundledRow(list, 'cursor-team-kit')
    assert.equal(row.dataset['enabled'], 'false', 'contributes nothing, so it is not Active')
    assert.equal(row.querySelector<HTMLInputElement>('.plugin-toggle-input')?.disabled, true)
    assert.match(row.querySelector('.plugin-toggle')?.getAttribute('title') ?? '', /Agent → Skills/)
  })
})
