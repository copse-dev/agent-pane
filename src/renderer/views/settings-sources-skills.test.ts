// Sources → Skills: source badge + hover-only filesystem path (skill origin).
import '../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { SkillSummary } from '@shared/types/skills.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountSettingsDialog } from './settings-dialog.ts'

function stubApi(skills: SkillSummary[]): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    instructions: { ...base.instructions, list: () => Promise.resolve([]) },
    cursorRules: { ...base.cursorRules, list: () => Promise.resolve([]) },
    skills: { ...base.skills, list: () => Promise.resolve(skills) },
    plugins: { ...base.plugins, list: () => Promise.resolve([]) },
    hooks: {
      ...base.hooks,
      list: () => Promise.resolve({ hooks: [], warnings: [] }),
    },
  }
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

  it('renders source badge, description, and hover-only path in the header', async () => {
    const list = await openSkillsList([BUNDLED_SKILL])
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    const header = row.querySelector('.sources-row-header')
    assert.ok(header)
    assert.equal(row.querySelector('.sources-row-title')?.textContent, BUNDLED_SKILL.name)
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'bundled')
    assert.equal(row.querySelector('.sources-row-detail')?.textContent, BUNDLED_SKILL.description)
    const hover = row.querySelector('.sources-row-hover-detail')
    assert.ok(hover)
    assert.ok(header.contains(hover), 'path belongs in the header gutter')
    assert.ok(
      row.querySelector('.sources-row-primary')?.contains(hover),
      'path lives in the primary title slot',
    )
    assert.equal(hover.textContent, BUNDLED_SKILL.skillPath)
    assert.ok(hover.querySelector('bdi'), 'bdi keeps the path LTR under rtl elision')
    assert.equal(row.title, BUNDLED_SKILL.skillPath)
  })

  it('still exposes the path on hover when a skill has no description', async () => {
    const list = await openSkillsList([PROJECT_SKILL])
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    assert.equal(row.querySelector('.sources-badge')?.textContent, 'project')
    assert.ok(row.querySelector('.sources-badge-project'))
    assert.equal(row.querySelector('.sources-row-detail'), null)
    const hover = row.querySelector('.sources-row-hover-detail')
    assert.ok(hover)
    assert.ok(row.querySelector('.sources-row-header')?.contains(hover))
    assert.ok(
      row.querySelector('.sources-row-primary')?.contains(hover),
      'path lives in the primary title slot',
    )
    assert.equal(hover.textContent, PROJECT_SKILL.skillPath)
    assert.equal(row.title, PROJECT_SKILL.skillPath)
  })

  it('wraps title and hover path in a primary slot for containment', async () => {
    const longPath =
      '/Users/jonathankingston/.cursor/plugins/cache/cursor-public/very-long-plugin-id/' +
      'skills/ai-writing-signs-report/SKILL.md'
    const list = await openSkillsList([
      {
        name: 'ai-writing-signs-report',
        description: 'Analyze text for signs of AI writing.',
        source: 'bundled',
        skillPath: longPath,
        externalLinks: [],
      },
    ])
    const row = list.querySelector<HTMLElement>('.sources-row')
    assert.ok(row)
    const primary = row.querySelector('.sources-row-primary')
    const title = row.querySelector('.sources-row-title')
    const hover = row.querySelector('.sources-row-hover-detail')
    const badge = row.querySelector('.sources-badge')
    assert.ok(primary)
    assert.ok(title)
    assert.ok(hover)
    assert.ok(badge)
    assert.ok(primary.contains(title))
    assert.ok(primary.contains(hover))
    assert.equal(primary.contains(badge), false, 'badge stays outside the primary slot')
    assert.equal(hover.textContent, longPath)
    assert.ok(hover.querySelector('bdi'))
  })
})
