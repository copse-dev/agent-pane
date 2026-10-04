import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SkillsSourcesResult } from '@shared/types/skills.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  mountSkillsSources,
  skillsSourcesMarkup,
  type SourceRowFactory,
} from './settings-sources-skills.ts'

const rowFactory: SourceRowFactory = (title, badge, detail, opts) => {
  const row = document.createElement('div')
  row.className = 'sources-row'
  row.textContent = `${title} ${badge ?? ''} ${detail ?? ''}`
  row.title = opts?.titleAttr ?? ''
  return row
}
const snapshot: SkillsSourcesResult = {
  skills: [
    {
      name: 'model-only',
      description: 'Helpful workflow',
      source: 'project',
      skillPath: '/project/.github/skills/model-only/SKILL.md',
      skillRoot: '/project/.github/skills/model-only',
      externalLinks: [],
      missingReferences: [],
      paths: [],
      userInvocable: false,
      disableModelInvocation: false,
      license: 'MIT',
      allowedTools: '<img src=x onerror=alert(1)>',
      compatibility: 'Copse',
      metadata: { author: '<script>bad()</script>' },
    },
  ],
  diagnostics: [
    {
      kind: 'invalid',
      name: 'broken',
      source: 'project',
      skillPath: '/project/broken/SKILL.md',
      reason: 'description must be at most 1024 characters',
    },
  ],
  extraRoots: ['/extra/skills'],
  reload: 'manual',
}
function mount(api = createFakeApi()): {
  root: HTMLElement
  refresh: (result: SkillsSourcesResult) => void
} {
  const root = document.createElement('div')
  root.innerHTML = skillsSourcesMarkup
  document.body.append(root)
  const owner = mountSkillsSources({ root, api, makeSourceRow: rowFactory })
  return { root, ...owner }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('skill Sources controls', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  it('shows invocation eligibility, optional metadata as text and skipped reasons', () => {
    const { root, refresh } = mount()
    refresh(snapshot)
    assert.match(root.textContent, /Manual off · Model on/)
    assert.match(root.textContent, /Declared tools \(descriptive only\)/)
    assert.match(root.textContent, /<script>bad\(\)<\/script>/)
    assert.equal(root.querySelector('script, img'), null)
    assert.match(root.querySelector('#sources-skills-diagnostics')?.textContent ?? '', /1024/)
    assert.equal(
      root.querySelector<HTMLTextAreaElement>('#sources-skill-roots')?.value,
      '/extra/skills',
    )
  })
  it('saves explicit folders and reloads without granting permissions', async () => {
    const base = createFakeApi()
    const calls: string[][] = []
    const { root } = mount({
      ...base,
      skills: {
        ...base.skills,
        setRoots: async (roots) => {
          calls.push(roots)
          return { ...snapshot, extraRoots: roots }
        },
      },
    })
    const textarea = root.querySelector<HTMLTextAreaElement>('textarea')
    assert.ok(textarea)
    textarea.value = ' /one \n\n /two '
    root.querySelector<HTMLButtonElement>('#sources-skill-roots-save')?.click()
    await tick()
    assert.deepEqual(calls, [['/one', '/two']])
    assert.match(root.querySelector('#sources-skills-status')?.textContent ?? '', /Folders saved/)
  })
  it('ignores stale results superseded by an owner refresh and detached results', async () => {
    const base = createFakeApi()
    let resolveRequest: ((result: SkillsSourcesResult) => void) | undefined
    const { root, refresh } = mount({
      ...base,
      skills: {
        ...base.skills,
        sources: () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          }),
      },
    })
    root.querySelector<HTMLButtonElement>('#sources-skills-reload')?.click()
    refresh({ ...snapshot, skills: [], extraRoots: ['/newer'] })
    resolveRequest?.(snapshot)
    await tick()
    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.value, '/newer')
    root.querySelector<HTMLButtonElement>('#sources-skills-reload')?.click()
    root.remove()
    resolveRequest?.(snapshot)
    await tick()
    assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')?.value, '/newer')
  })
  it('keeps the old catalog and exposes an actionable reload error', async () => {
    const base = createFakeApi()
    const { root, refresh } = mount({
      ...base,
      skills: { ...base.skills, sources: () => Promise.reject(new Error('Reload unavailable')) },
    })
    refresh(snapshot)
    root.querySelector<HTMLButtonElement>('#sources-skills-reload')?.click()
    await tick()
    assert.match(
      root.querySelector('#sources-skills-status')?.textContent ?? '',
      /Reload unavailable/,
    )
    assert.match(root.querySelector('#sources-skills-list')?.textContent ?? '', /model-only/)
    assert.equal(root.querySelector<HTMLButtonElement>('#sources-skills-reload')?.disabled, false)
  })
})
