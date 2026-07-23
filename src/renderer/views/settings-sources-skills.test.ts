// Sources → Skills: source badge + hover-only filesystem path (skill origin).
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

function stubApi(skills: SkillSummary[]): ApiClient {
  const fallback: unknown = new Proxy(() => new Promise(() => {}), {
    get: () => fallback,
    apply: () => new Promise(() => {}),
  })
  const overrides: Record<string, unknown> = {
    instructions: { list: () => Promise.resolve([]) },
    cursorRules: { list: () => Promise.resolve([]) },
    skills: { list: () => Promise.resolve(skills) },
    plugins: { list: () => Promise.resolve([]) },
    hooks: { list: () => Promise.resolve({ hooks: [], warnings: [] }) },
  }
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, prop) =>
        typeof prop === 'string' && prop in overrides ? overrides[prop] : fallback,
    },
  )
  return proxy as ApiClient
}

const BUNDLED_SKILL: SkillSummary = {
  name: 'principle-boundary-discipline',
  description: 'Concentrate guards at system boundaries.',
  source: 'bundled',
  skillPath:
    '/app/vendor/bundled-cursor-skills/plugins/pstack/skills/principle-boundary-discipline/SKILL.md',
  externalLinks: [],
}

const PROJECT_SKILL: SkillSummary = {
  name: 'demo-skill',
  description: '',
  source: 'project',
  skillPath: '/workspace/.cursor/skills/demo-skill/SKILL.md',
  externalLinks: [],
}

async function openSkillsList(skills: SkillSummary[]): Promise<HTMLElement> {
  document.body.innerHTML = ''
  mountSettingsDialog(createStore(), stubApi(skills))
  const sourcesBtn = document.querySelector<HTMLButtonElement>(
    '.settings-nav-btn[data-section="sources"]',
  )
  assert.ok(sourcesBtn)
  sourcesBtn.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const list = document.getElementById('sources-skills-list')
  assert.ok(list)
  return list
}

describe('settings sources → skills list', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the empty state when no skills are discovered', async () => {
    const list = await openSkillsList([])
    assert.match(list.textContent, /No skills discovered\./)
    assert.equal(list.querySelectorAll('.sources-row').length, 0)
  })

  it('renders source badge, description, and hover-only path origin', async () => {
    const list = await openSkillsList([BUNDLED_SKILL])
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    assert.equal(row.querySelector('.sources-row-title')?.textContent, BUNDLED_SKILL.name)
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'bundled')
    assert.equal(row.querySelector('.sources-row-detail')?.textContent, BUNDLED_SKILL.description)
    const hover = row.querySelector('.sources-row-hover-detail')
    assert.ok(hover)
    assert.equal(hover.textContent, BUNDLED_SKILL.skillPath)
    assert.equal(row.title, BUNDLED_SKILL.skillPath)
  })

  it('still exposes the path on hover when a skill has no description', async () => {
    const list = await openSkillsList([PROJECT_SKILL])
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'project')
    assert.ok(row.querySelector('.sources-badge-project'))
    assert.equal(row.querySelector('.sources-row-detail'), null)
    assert.equal(
      row.querySelector('.sources-row-hover-detail')?.textContent,
      PROJECT_SKILL.skillPath,
    )
    assert.equal(row.title, PROJECT_SKILL.skillPath)
  })
})
