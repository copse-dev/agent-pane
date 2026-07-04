import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCursorRuleSources } from './cursor-rules.ts'

describe('cursor-rules', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-panel-cursor-rules-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeRule(rel: string, contents: string): Promise<void> {
    const full = join(root, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }

  it('returns nothing when no rules exist', async () => {
    assert.deepEqual(await loadCursorRuleSources(root), [])
  })

  it('loads alwaysApply .mdc rules, stripping frontmatter', async () => {
    await writeRule(
      '.cursor/rules/style.mdc',
      '---\ndescription: Style\nalwaysApply: true\n---\nUse tabs, not spaces.',
    )
    const sources = await loadCursorRuleSources(root)
    assert.deepEqual(
      sources.map((s) => ({ name: s.name, content: s.content })),
      [{ name: join('.cursor', 'rules', 'style.mdc'), content: 'Use tabs, not spaces.' }],
    )
  })

  it('skips .mdc rules that are not alwaysApply', async () => {
    await writeRule(
      '.cursor/rules/auto.mdc',
      '---\nglobs: ["*.ts"]\nalwaysApply: false\n---\nOnly for TS files.',
    )
    await writeRule('.cursor/rules/manual.mdc', '---\ndescription: Manual\n---\nAgent-requested.')
    assert.deepEqual(await loadCursorRuleSources(root), [])
  })

  it('loads legacy .cursorrules and sorts .mdc deterministically', async () => {
    await writeRule('.cursor/rules/b.mdc', '---\nalwaysApply: true\n---\nB rule')
    await writeRule('.cursor/rules/a.mdc', '---\nalwaysApply: true\n---\nA rule')
    await writeFile(join(root, '.cursorrules'), 'Legacy rules.')
    const names = (await loadCursorRuleSources(root)).map((s) => s.name)
    assert.deepEqual(names, [
      join('.cursor', 'rules', 'a.mdc'),
      join('.cursor', 'rules', 'b.mdc'),
      '.cursorrules',
    ])
  })

  it('discovers nested .mdc rules', async () => {
    await writeRule('.cursor/rules/frontend/react.mdc', '---\nalwaysApply: true\n---\nUse hooks.')
    const sources = await loadCursorRuleSources(root)
    assert.equal(sources[0]?.name, join('.cursor', 'rules', 'frontend', 'react.mdc'))
  })

  it('skips an alwaysApply rule with an empty body', async () => {
    await writeRule('.cursor/rules/empty.mdc', '---\nalwaysApply: true\n---\n   \n')
    assert.deepEqual(await loadCursorRuleSources(root), [])
  })
})
