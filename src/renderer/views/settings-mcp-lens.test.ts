// Settings → MCP servers as a lens on *every* outbound MCP connection.
//
// The list used to answer only "what is connected right now". That reads as the
// complete picture while being two things short of it: it never said who asked
// for a server — a repo's `.mcp.json` and the user's own global config rendered
// identically — and it said nothing at all about servers an installed plugin
// declares but nothing is running, so a package on disk naming three servers
// could sit behind a section reading "No servers configured."
//
// Both gaps are about *disclosure* rather than connectivity, which is why they
// are pinned here: the assertions are that the origin reaches the row, and that
// a declared-but-inert server is visible and unmistakably not running.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { DeclaredMcpServer, McpServerStatus } from '@shared/types/mcp.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

function status(
  overrides: Partial<McpServerStatus> & Pick<McpServerStatus, 'name'>,
): McpServerStatus {
  return {
    transport: 'stdio',
    state: 'connected',
    toolCount: 1,
    tools: ['search'],
    userEnabled: true,
    configDisabled: false,
    origin: 'user',
    ...overrides,
  } satisfies McpServerStatus
}

function stubApi(servers: McpServerStatus[], declared: DeclaredMcpServer[]): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    mcp: {
      ...base.mcp,
      list: () => Promise.resolve(servers),
      listCurated: () => Promise.resolve([]),
      listDeclared: () => Promise.resolve(declared),
    },
  }
}

/** Settle the staged section refresh the dialog runs on open. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openMcp(
  servers: McpServerStatus[],
  declared: DeclaredMcpServer[] = [],
): Promise<void> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore({ activeProjectId: 'project-1' }), stubApi(servers, declared))
  const btn = document.querySelector<HTMLButtonElement>('.settings-nav-btn[data-section="mcp"]')
  assert.ok(btn)
  btn.click()
  await flush()
}

function rowFor(name: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('#mcp-server-list .mcp-server-row')].find(
    (candidate) => candidate.textContent.startsWith(`${name} (`),
  )
  assert.ok(row, `expected a row for ${name}`)
  return row
}

describe('settings → MCP servers origin lens', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('labels each server with who asked for it', async () => {
    await openMcp([
      status({ name: 'mine', origin: 'user', source: '/home/dev/.cursor/mcp.json' }),
      status({ name: 'theirs', origin: 'project', source: '/workspace/.mcp.json' }),
      status({ name: 'bundled', origin: 'built-in', transport: 'in-process' }),
    ])

    const chip = (name: string): HTMLElement => {
      const el = rowFor(name).querySelector<HTMLElement>('.mcp-origin-chip')
      assert.ok(el)
      return el
    }
    assert.equal(chip('mine').textContent, 'Your config')
    assert.equal(chip('theirs').textContent, 'This project')
    assert.equal(chip('bundled').textContent, 'Built in')

    // The distinction that matters most is repo-supplied vs everything else, so
    // it has to survive as a class the stylesheet can colour, not just as text.
    assert.equal(chip('theirs').dataset['mcpOrigin'], 'project')
    assert.ok(chip('theirs').classList.contains('mcp-origin-project'))
    assert.equal(chip('mine').classList.contains('mcp-origin-project'), false)
  })

  it('names the plugin rather than the word "plugin" when one supplied the server', async () => {
    await openMcp([
      status({
        name: 'from-plugin',
        origin: 'plugin',
        originDetail: 'acme/reviewer',
        source: '/home/dev/.cursor/plugins/acme/reviewer/.mcp.json',
      }),
    ])
    const chip = rowFor('from-plugin').querySelector<HTMLElement>('.mcp-origin-chip')
    assert.ok(chip)
    // Which plugin is the actionable part — "Plugin" alone would leave the user
    // hunting through Customise to find which one to turn off.
    assert.equal(chip.textContent, 'acme/reviewer')
    assert.match(chip.title, /^Plugin — /)
  })

  it('hides the declared-but-not-running list when there is nothing to disclose', async () => {
    await openMcp([status({ name: 'mine' })])
    const fieldset = document.querySelector<HTMLElement>('#mcp-declared-fieldset')
    assert.ok(fieldset)
    assert.equal(fieldset.hidden, true)
  })

  it('discloses a server a disabled plugin declares, and why it is not running', async () => {
    await openMcp(
      [],
      [
        {
          name: 'reviewer',
          transport: 'stdio',
          pluginId: 'acme.reviewer',
          pluginEnabled: false,
          reason: 'The plugin that declares it is turned off.',
        },
      ],
    )

    const fieldset = document.querySelector<HTMLElement>('#mcp-declared-fieldset')
    assert.ok(fieldset)
    assert.equal(fieldset.hidden, false)

    const row = document.querySelector<HTMLElement>('#mcp-declared-list .mcp-declared-row')
    assert.ok(row)
    assert.equal(row.dataset['pluginId'], 'acme.reviewer')
    assert.match(row.textContent, /reviewer \(stdio\)/)
    assert.match(row.textContent, /not running/)
    assert.match(row.textContent, /turned off/)

    // No toggle: this row is a disclosure, not a control. Offering a switch here
    // would imply Copse could start the server, which is the opposite of what
    // the row exists to say.
    assert.equal(row.querySelector('.toggle-switch'), null)
  })
})
