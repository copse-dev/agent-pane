import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSkillTool } from './read-skill-tool.ts'
import { setSkillsForTest } from '../services/skills/skills-registry.ts'
import { normalizeToolExecuteResult, type ToolExecuteResult } from '@shared/types'
import type { SkillMetadata } from '@shared/types/skills.ts'

function toolText(result: ToolExecuteResult): string {
  return normalizeToolExecuteResult(result).result
}

describe('readSkillTool', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-read-skill-tool-'))
  })

  afterEach(async () => {
    setSkillsForTest([])
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  function seedMetadata(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
    const metadata: SkillMetadata = {
      name: 'linky-refs',
      description: 'References a file that is not in the bundle',
      source: 'project',
      skillPath: join(tempRoot, 'SKILL.md'),
      skillRoot: tempRoot,
      disableModelInvocation: false,
      paths: [],
      externalLinks: [],
      missingReferences: [],
      ...overrides,
    }
    setSkillsForTest([metadata])
    return metadata
  }

  it('reads a skill with no broken references without any note', async () => {
    await writeFile(join(tempRoot, 'SKILL.md'), '# Body', 'utf-8')
    seedMetadata()
    const result = toolText(
      await readSkillTool.execute({ name: 'linky-refs' }, new AbortController().signal),
    )
    assert.doesNotMatch(result, /not present in the bundle/)
    assert.match(result, /# Body/)
  })

  it('appends a note when the skill references a missing bundle file', async () => {
    await writeFile(join(tempRoot, 'SKILL.md'), '# Body', 'utf-8')
    seedMetadata({ missingReferences: ['references/patterns.md'] })
    const result = toolText(
      await readSkillTool.execute({ name: 'linky-refs' }, new AbortController().signal),
    )
    assert.match(
      result,
      /Note: this skill references `references\/patterns\.md`, which is not present in the bundle/,
    )
    assert.match(result, /# Body/)
  })

  it('pluralizes the note for more than one missing reference', async () => {
    await writeFile(join(tempRoot, 'SKILL.md'), '# Body', 'utf-8')
    seedMetadata({ missingReferences: ['references/patterns.md', 'scripts/setup.sh'] })
    const result = toolText(
      await readSkillTool.execute({ name: 'linky-refs' }, new AbortController().signal),
    )
    assert.match(
      result,
      /Note: this skill references `references\/patterns\.md`, `scripts\/setup\.sh`, which are not present in the bundle/,
    )
  })

  it('surfaces the enhanced unknown-skill error for an unrecognized name', async () => {
    setSkillsForTest([])
    await assert.rejects(
      async () => readSkillTool.execute({ name: 'pstack' }, new AbortController().signal),
      /Unknown skill "pstack"\. No skills are currently available\./,
    )
  })
})
