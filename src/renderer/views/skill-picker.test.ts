import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountComposerEditor } from './composer-editor.ts'
import { findSkillTriggerIndex, initSkillPicker } from './skill-picker.ts'

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('skill picker', () => {
  it('filters slash commands and inserts the selected skill into the composer', async () => {
    const inputBar = document.createElement('div')
    const input = mountComposerEditor()
    inputBar.append(input.el)
    document.body.append(inputBar)
    initSkillPicker({
      input,
      inputBar,
      listSkills: async () => [
        {
          name: 'demo-skill',
          description: 'Validate skills support',
          source: 'project',
          skillPath: '/repo/.agents/skills/demo-skill/SKILL.md',
          externalLinks: [],
        },
        {
          name: 'release-notes',
          description: 'Draft a release summary',
          source: 'project',
          skillPath: '/repo/.agents/skills/release-notes/SKILL.md',
          externalLinks: [],
        },
      ],
    })

    input.value = '/demo'
    input.setSelectionRange(input.value.length, input.value.length)
    input.el.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    const picker = inputBar.querySelector<HTMLElement>('.skill-picker')
    assert.ok(picker)
    assert.equal(picker.hidden, false)
    const items = picker.querySelectorAll('.skill-item')
    assert.equal(items.length, 1)
    const item = items.item(0)
    assert.ok(item)
    assert.equal(item.querySelector('.skill-item-name')?.textContent, '/demo-skill')
    assert.equal(item.querySelector('.skill-item-desc')?.textContent, 'Validate skills support')

    input.el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(input.value, '/demo-skill ')
    assert.equal(picker.hidden, true)
  })

  it('ranks name-prefix matches ahead of description-only hits for Enter', async () => {
    const inputBar = document.createElement('div')
    const input = mountComposerEditor()
    inputBar.append(input.el)
    document.body.append(inputBar)
    initSkillPicker({
      input,
      inputBar,
      listSkills: async () => [
        {
          // Alphabetically first, and description contains the query — without
          // name-prefix ranking, Enter would insert this instead of `/checkup`.
          name: 'agent-run-eval',
          description: 'Drive checkup-style regression evals',
          source: 'project',
          skillPath: '/repo/.cursor/skills/agent-run-eval/SKILL.md',
          externalLinks: [],
        },
        {
          name: 'checkup',
          description: 'Run a Copse setup health check',
          source: 'bundled',
          skillPath: '/app/assets/skills/checkup/SKILL.md',
          externalLinks: [],
        },
      ],
    })

    input.value = '/checkup'
    input.setSelectionRange(input.value.length, input.value.length)
    input.el.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    const picker = inputBar.querySelector<HTMLElement>('.skill-picker')
    assert.ok(picker)
    assert.equal(picker.hidden, false)
    const names = [...picker.querySelectorAll('.skill-item-name')].map((el) => el.textContent)
    assert.deepEqual(names, ['/checkup', '/agent-run-eval'])

    input.el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(input.value, '/checkup ')
  })

  it('only triggers on a slash that starts a word', () => {
    // Start of input, and after whitespace or a newline — the boundaries
    // `resolveSkillInvocation` accepts.
    assert.equal(findSkillTriggerIndex('/demo', 5), 0)
    assert.equal(findSkillTriggerIndex('run /demo', 9), 4)
    assert.equal(findSkillTriggerIndex('run\n/demo', 9), 4)

    // Mid-word slashes are path separators, not slash commands.
    assert.equal(findSkillTriggerIndex('do a grep ~/.blah', 17), -1)
    assert.equal(findSkillTriggerIndex('src/index.ts', 12), -1)
    assert.equal(findSkillTriggerIndex('do a grep ~/', 12), -1)

    // `/x/y/z` anchors on its first slash rather than restarting at each
    // segment, so the query stays `x/y/z` and matches nothing.
    assert.equal(findSkillTriggerIndex('/x/y/z', 6), 0)

    // A bare `/` still opens the full list; a completed token does not.
    assert.equal(findSkillTriggerIndex('/', 1), 0)
    assert.equal(findSkillTriggerIndex('/demo ', 6), -1)
  })

  it('leaves the picker closed for a path like ~/.blah', async () => {
    const inputBar = document.createElement('div')
    const input = mountComposerEditor()
    inputBar.append(input.el)
    document.body.append(inputBar)
    initSkillPicker({
      input,
      inputBar,
      listSkills: async () => [
        {
          name: 'blah-skill',
          description: 'Would have matched the path tail',
          source: 'project',
          skillPath: '/repo/.agents/skills/blah-skill/SKILL.md',
          externalLinks: [],
        },
      ],
    })

    input.value = 'do a grep ~/.blah'
    input.setSelectionRange(input.value.length, input.value.length)
    input.el.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    const picker = inputBar.querySelector<HTMLElement>('.skill-picker')
    assert.ok(picker)
    assert.equal(picker.hidden, true)
  })
})
