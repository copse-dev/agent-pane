// Sources → Agents: discovered definitions, plus the two failure modes users
// actually hit — a definition that lost a name collision, and one Copse skipped.
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { AgentsListResult } from '@shared/types/agents.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

function stubApi(agents: AgentsListResult): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    instructions: { ...base.instructions, list: () => Promise.resolve([]) },
    cursorRules: { ...base.cursorRules, list: () => Promise.resolve([]) },
    skills: { ...base.skills, list: () => Promise.resolve([]) },
    agents: { ...base.agents, list: () => Promise.resolve(agents) },
    cursorPlugins: { ...base.cursorPlugins, list: () => Promise.resolve([]) },
    hooks: { ...base.hooks, list: () => Promise.resolve({ hooks: [], warnings: [] }) },
  }
}

const EMPTY: AgentsListResult = { agents: [], skipped: [], shadowed: [] }

async function openAgentsList(agents: AgentsListResult): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore(), stubApi(agents))
  const sourcesBtn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="customise"]',
  )
  assert.ok(sourcesBtn)
  sourcesBtn.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('sources-agents-list')
  assert.ok(list)
  return list
}

describe('settings sources → agents list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('says so when nothing was discovered', async () => {
    const list = await openAgentsList(EMPTY)
    assert.match(list.textContent, /No agents discovered/)
  })

  it('shows the name, scope, container and path of a discovered agent', async () => {
    const list = await openAgentsList({
      ...EMPTY,
      agents: [
        {
          name: 'reviewer',
          description: 'Reviews code',
          source: 'user',
          container: '.claude',
          agentPath: '/home/u/.claude/agents/reviewer.md',
          unsupportedFields: [],
        },
      ],
    })

    const row = list.querySelector('.sources-row')
    assert.ok(row)
    assert.match(row.textContent, /reviewer/)
    assert.match(row.textContent, /Reviews code/)
    assert.match(row.textContent, /\.claude/)
    assert.equal(row.getAttribute('title'), '/home/u/.claude/agents/reviewer.md')
  })

  it('marks an agent whose frontmatter Copse only partly honours, and says why', async () => {
    const list = await openAgentsList({
      ...EMPTY,
      agents: [
        {
          name: 'builder',
          description: 'Builds',
          source: 'project',
          container: '.claude',
          agentPath: '/ws/.claude/agents/builder.md',
          unsupportedFields: [
            {
              field: 'isolation',
              reason: 'runs in your working tree, not an isolated worktree copy',
            },
          ],
        },
      ],
    })

    const text = list.textContent
    assert.match(text, /partly supported/)
    assert.match(text, /working tree/, 'the reason is visible, not just the badge')
  })

  it('explains a definition that lost a name collision', async () => {
    const list = await openAgentsList({
      ...EMPTY,
      shadowed: [
        {
          name: 'reviewer',
          agentPath: '/home/u/.claude/agents/reviewer.md',
          source: 'user',
          shadowedBy: '/ws/.copse/agents/reviewer.md',
        },
      ],
    })

    const text = list.textContent
    assert.match(text, /overridden/)
    assert.match(text, /\/ws\/\.copse\/agents\/reviewer\.md/)
  })

  it('lists a skipped file with the reason it was skipped', async () => {
    const list = await openAgentsList({
      ...EMPTY,
      skipped: [
        {
          agentPath: '/home/u/.claude/agents/broken.md',
          source: 'user',
          reason: 'invalid name “-bad” — cannot start with “-”',
        },
      ],
    })

    const text = list.textContent
    assert.match(text, /skipped/)
    assert.match(text, /broken\.md/, 'skipped rows are keyed by filename, not agent name')
    assert.match(text, /cannot start with/)
  })
})
