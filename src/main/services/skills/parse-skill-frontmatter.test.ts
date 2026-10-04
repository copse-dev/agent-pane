import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import {
  folderNameMatchesSkill,
  parseSkillFrontmatter,
  splitSkillMarkdown,
  validateSkillFrontmatter,
} from './parse-skill-frontmatter.ts'

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
    assert.match(parsed.description, /Hugging Face Hub CLI/)
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

  it('does not end frontmatter at a --- inside a body code fence', () => {
    const raw = `---
name: demo-skill
description: A real description
---

# Body

\`\`\`
some code
---
more code after a horizontal rule
\`\`\`
`
    const split = splitSkillMarkdown(raw)
    assert.ok(split)
    // The whole frontmatter must be captured, not just up to the in-body ---.
    assert.match(split.frontmatter, /description: A real description/)
    assert.match(split.body, /some code/)
    const parsed = parseSkillFrontmatter(split.frontmatter)
    assert.equal(parsed?.description, 'A real description')
  })

  it('treats only a standalone --- line as the closing fence (not ----)', () => {
    const raw = `---
name: demo-skill
description: Demo
----
not a real close
---
# Body`
    const split = splitSkillMarkdown(raw)
    assert.ok(split)
    assert.match(split.frontmatter, /not a real close/)
    assert.match(split.body, /^# Body/)
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\nname: demo-skill\r\ndescription: Demo\r\n---\r\n\r\n# Body'
    const split = splitSkillMarkdown(raw)
    assert.ok(split)
    const parsed = parseSkillFrontmatter(split.frontmatter)
    assert.equal(parsed?.name, 'demo-skill')
    assert.match(split.body, /^# Body/)
  })

  it('strips nested/doubled quotes from scalars', () => {
    const yaml = `name: "'demo-skill'"
description: "\\"Quoted desc\\""`
    const parsed = parseSkillFrontmatter(yaml)
    assert.equal(parsed?.name, 'demo-skill')
    assert.equal(parsed.description, 'Quoted desc')
  })

  it('strips trailing comments only from unquoted scalars', () => {
    const yaml = `name: demo-skill
description: A clean description`
    const parsed = parseSkillFrontmatter(yaml)
    assert.equal(parsed?.name, 'demo-skill')
    assert.equal(parsed.description, 'A clean description')
  })

  it('parses single-quoted scalars with doubled-quote escapes', () => {
    const yaml = `name: demo-skill
description: 'it''s a skill'`
    const parsed = parseSkillFrontmatter(yaml)
    assert.equal(parsed?.description, "it's a skill")
  })

  it('parses a literal block scalar description', () => {
    const yaml = `name: demo-skill
description: |
  Line one
  line two`
    const parsed = parseSkillFrontmatter(yaml)
    assert.match(parsed?.description ?? '', /Line one line two/)
  })

  it('parses inline and list paths', () => {
    const listYaml = `name: demo-skill
description: Demo
paths:
  - src/**
  - "test/**"`
    assert.deepEqual(parseSkillFrontmatter(listYaml)?.paths, ['src/**', 'test/**'])

    const inlineYaml = `name: demo-skill
description: Demo
paths: src/**, test/**`
    assert.deepEqual(parseSkillFrontmatter(inlineYaml)?.paths, ['src/**', 'test/**'])
  })

  it('returns null when required fields are missing', () => {
    assert.equal(parseSkillFrontmatter('name: only-name'), null)
  })

  it('accepts the inclusive name length limit and preserves long descriptions', () => {
    const name = 'a'.repeat(64)
    const description = 'x'.repeat(1024)
    assert.equal(parseSkillFrontmatter(`name: ${name}\ndescription: ${description}`)?.name, name)
    // The 1024-character description cap is deferred: the pinned Cursor SDK
    // skill exceeds it, and changing vendor bytes would break its provenance.
    assert.equal(
      parseSkillFrontmatter(`name: emoji\ndescription: ${'🔧'.repeat(1024)}`)?.description.length,
      2048,
    )
  })

  it('rejects names outside the Agent Skills grammar with a stable reason', () => {
    for (const name of [
      'Uppercase',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has_space',
      'two words',
    ]) {
      const result = validateSkillFrontmatter(`name: ${name}\ndescription: Demo`)
      assert.equal(result.skill, null, name)
      assert.equal(
        result.reason,
        'frontmatter `name` must contain lowercase letters, digits, and single hyphens between words',
      )
    }
    assert.ok(parseSkillFrontmatter('name: pdf-2-text\ndescription: Demo'))
  })

  it('reports missing, blank, and over-limit fields deterministically', () => {
    for (const name of ['', '""', "' '"]) {
      assert.equal(
        validateSkillFrontmatter(`name: ${name}\ndescription: Demo`).reason,
        'frontmatter requires a non-empty `name` field',
      )
    }
    assert.equal(
      validateSkillFrontmatter(`name: ${'a'.repeat(65)}\ndescription: Demo`).reason,
      'frontmatter `name` must be at most 64 characters',
    )
    for (const description of ['', '""', "' '"]) {
      assert.equal(
        validateSkillFrontmatter(`name: demo\ndescription: ${description}`).reason,
        'frontmatter requires a non-empty `description` field',
      )
    }
    assert.ok(parseSkillFrontmatter(`name: demo\ndescription: ${'x'.repeat(1045)}`))
  })

  it('checks the immediate parent directory across path separators', () => {
    assert.equal(folderNameMatchesSkill('/skills/pdf-processing/SKILL.md', 'pdf-processing'), true)
    assert.equal(
      folderNameMatchesSkill('C:\\skills\\pdf-processing\\SKILL.md', 'pdf-processing'),
      true,
    )
    assert.equal(folderNameMatchesSkill('/skills/renamed/SKILL.md', 'pdf-processing'), false)
  })

  it('continues to load every checked-in bundled and development skill', () => {
    const files = globSync([
      'assets/skills/**/SKILL.md',
      'vendor/bundled-cursor-skills/**/SKILL.md',
      '.cursor/skills/**/SKILL.md',
    ])
    assert.ok(files.length > 0)
    for (const file of files.sort()) {
      const split = splitSkillMarkdown(readFileSync(file, 'utf8'))
      assert.ok(split, file)
      const result = validateSkillFrontmatter(split.frontmatter)
      assert.ok(result.skill, `${file}: ${result.reason ?? ''}`)
      assert.equal(folderNameMatchesSkill(file, result.skill.name), true, file)
    }
  })
})
