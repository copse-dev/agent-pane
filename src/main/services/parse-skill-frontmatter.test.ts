import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillFrontmatter, splitSkillMarkdown } from './parse-skill-frontmatter.ts'

describe('parseSkillFrontmatter', () => {
  it('parses inline frontmatter fields', () => {
    const yaml = `name: demo-skill
description: Short demo description
disable-model-invocation: true`
    assert.deepEqual(parseSkillFrontmatter(yaml), {
      name: 'demo-skill',
      description: 'Short demo description',
      disableModelInvocation: true,
      paths: [],
    })
  })

  it('parses block scalar descriptions', () => {
    const yaml = `name: hf-cli
description: >
  Hugging Face Hub CLI for downloading and uploading models.
disable-model-invocation: false`
    const parsed = parseSkillFrontmatter(yaml)
    assert.equal(parsed?.name, 'hf-cli')
    assert.match(parsed?.description ?? '', /Hugging Face Hub CLI/)
  })

  it('splits markdown frontmatter from body', () => {
    const raw = `---
name: demo-skill
description: Demo
---

# Body`
    const split = splitSkillMarkdown(raw)
    assert.ok(split)
    assert.match(split.body, /^# Body/)
  })
})
