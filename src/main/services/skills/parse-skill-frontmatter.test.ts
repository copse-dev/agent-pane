import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import {
  parseSkillFrontmatter,
  validateSkillFrontmatter,
  splitSkillMarkdown,
  folderNameMatchesSkill,
  toSkillMetadata,
} from './parse-skill-frontmatter.ts'
import { adaptBundledSkill } from './bundled-skill-compatibility.ts'

const header = (extra = ''): string => `name: demo-skill\ndescription: Demo\n${extra}`

describe('Agent Skills frontmatter conformance', () => {
  it('loads the standard metadata fixture and round-trips descriptive values', () => {
    const result = validateSkillFrontmatter(
      `name: pdf-processing\ndescription: Process PDF files.\nlicense: Apache-2.0\ncompatibility: Requires Python 3.11\nmetadata:\n  author: Example\n  version: "1.0"\nallowed-tools: Bash(python:*) Read\nuser-invocable: false\ndisable-model-invocation: false`,
    )
    assert.ok(result.skill)
    assert.deepEqual(toSkillMetadata(result.skill, '/skills/pdf-processing/SKILL.md', 'project'), {
      name: 'pdf-processing',
      description: 'Process PDF files.',
      license: 'Apache-2.0',
      compatibility: 'Requires Python 3.11',
      metadata: { author: 'Example', version: '1.0' },
      allowedTools: 'Bash(python:*) Read',
      userInvocable: false,
      disableModelInvocation: false,
      paths: [],
      source: 'project',
      skillPath: '/skills/pdf-processing/SKILL.md',
      skillRoot: '/skills/pdf-processing',
      externalLinks: [],
      missingReferences: [],
    })
    assert.deepEqual(result.warnings, [])
  })

  it('decodes YAML comments, quoted strings, folded/literal blocks and flow maps', () => {
    assert.equal(
      parseSkillFrontmatter('name: demo-skill # comment\ndescription: "A # literal"')?.description,
      'A # literal',
    )
    assert.equal(
      parseSkillFrontmatter('name: demo-skill\ndescription: >\n  One\n  two')?.description,
      'One two',
    )
    assert.equal(
      parseSkillFrontmatter('name: demo-skill\ndescription: |\n  One\n  two')?.description,
      'One\ntwo',
    )
    assert.deepEqual(
      parseSkillFrontmatter(header('metadata: {author: "Example", version: "1"}'))?.metadata,
      { author: 'Example', version: '1' },
    )
    assert.equal(
      parseSkillFrontmatter("name: demo-skill\ndescription: 'it''s a skill'")?.description,
      "it's a skill",
    )
  })

  it('enforces inclusive field limits with character rather than UTF-16 counting', () => {
    assert.ok(
      parseSkillFrontmatter(
        `name: ${'a'.repeat(64)}\ndescription: ${'🔧'.repeat(1024)}\ncompatibility: ${'a'.repeat(500)}`,
      ),
    )
    for (const yaml of [
      `name: ${'a'.repeat(65)}\ndescription: Demo`,
      `name: demo\ndescription: ${'🔧'.repeat(1025)}`,
      header(`compatibility: ${'a'.repeat(501)}`),
    ])
      assert.equal(parseSkillFrontmatter(yaml), null)
  })

  it('rejects invalid names, absent/blank descriptions and malformed optional values', () => {
    for (const name of [
      'Uppercase',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has_space',
      'two words',
      '" padded "',
    ])
      assert.equal(parseSkillFrontmatter(`name: ${name}\ndescription: Demo`), null, name)
    for (const yaml of [
      'description: Demo',
      'name: demo',
      'name: ""\ndescription: Demo',
      'name: demo\ndescription: " "',
      'name: demo\ndescription: |\n',
    ])
      assert.equal(parseSkillFrontmatter(yaml), null, yaml)
    for (const extra of [
      'metadata: []',
      'metadata: {version: 1}',
      'license: 42',
      'compatibility: false',
      'allowed-tools: [Read, Write]',
      'user-invocable: "false"',
      'disable-model-invocation: yes',
      'paths: [42]',
    ]) {
      const result = validateSkillFrontmatter(header(extra))
      assert.equal(result.skill, null, extra)
      assert.ok(result.reason.startsWith('frontmatter '), extra)
      assert.deepEqual(validateSkillFrontmatter(header(extra)), result, 'diagnostics are stable')
    }
  })

  it('rejects duplicate keys, aliases, executable tags, deep maps and oversized headers', () => {
    for (const extra of [
      'name: other',
      'metadata: &ref {a: "value"}\nlicense: *ref',
      'license: !!js/function "function() {}"',
      `metadata: ${'{a: '.repeat(12)}"x"${'}'.repeat(12)}`,
      `license: ${'x'.repeat(65536)}`,
    ])
      assert.equal(parseSkillFrontmatter(header(extra)), null, extra.slice(0, 80))
  })

  it('preserves prototype-shaped metadata as inert own strings without pollution', () => {
    const result = parseSkillFrontmatter(
      header('metadata:\n  __proto__: inert\n  constructor: descriptive\n  prototype: text'),
    )
    assert.ok(result?.metadata)
    assert.equal(Object.hasOwn(result.metadata, '__proto__'), true)
    assert.equal(result.metadata['__proto__'], 'inert')
    assert.equal(result.metadata['constructor'], 'descriptive')
    assert.equal(Object.getPrototypeOf(result.metadata), Object.prototype)
    assert.equal(Object.hasOwn({}, 'inert'), false)
  })

  it('reports ignored unsupported fields and preserves existing paths extension', () => {
    const result = validateSkillFrontmatter(
      header('unknown: value\npermissions: {shell: true}\npaths: src/**, references'),
    )
    assert.ok(result.skill)
    assert.deepEqual(result.skill.paths, ['src/**', 'references'])
    assert.deepEqual(result.warnings, [
      'Unsupported field "permissions" is ignored',
      'Unsupported field "unknown" is ignored',
    ])
    assert.deepEqual(parseSkillFrontmatter(header('paths:\n  - src/**\n  - "test/**"'))?.paths, [
      'src/**',
      'test/**',
    ])
  })

  it('splits CRLF markdown only at standalone frontmatter fences', () => {
    const result = splitSkillMarkdown(
      '---\r\nname: demo-skill\r\ndescription: Demo\r\n---\r\n\r\n```\r\n---\r\n```',
    )
    assert.ok(result)
    assert.ok(parseSkillFrontmatter(result.frontmatter))
    assert.equal(result.body, '```\n---\n```')
    assert.equal(splitSkillMarkdown('# No header'), null)
  })

  it('checks the immediate parent directory across path separators', () => {
    assert.equal(folderNameMatchesSkill('/skills/demo-skill/SKILL.md', 'demo-skill'), true)
    assert.equal(folderNameMatchesSkill('C:\\skills\\demo-skill\\SKILL.md', 'demo-skill'), true)
    assert.equal(folderNameMatchesSkill('/skills/renamed/SKILL.md', 'demo-skill'), false)
  })

  it('loads every immutable bundled skill through exact-byte compatibility adapters', () => {
    const files = globSync([
      'assets/skills/**/SKILL.md',
      'vendor/bundled-cursor-skills/**/SKILL.md',
      '.cursor/skills/**/SKILL.md',
    ])
    assert.ok(files.length > 0)
    let adapted = 0
    for (const file of files.sort()) {
      const raw = readFileSync(file, 'utf8')
      const normalized = adaptBundledSkill(raw, file)
      if (normalized.reason) {
        adapted++
        assert.equal(
          parseSkillFrontmatter(splitSkillMarkdown(raw)?.frontmatter ?? ''),
          null,
          'strict input rejects the original nonconforming header',
        )
        assert.equal(
          adaptBundledSkill(`${raw}\n`, file).reason,
          undefined,
          'adapter accepts only the reviewed immutable bytes',
        )
        assert.equal(
          adaptBundledSkill(raw, '/other/skills/skill/SKILL.md').reason,
          undefined,
          'adapter requires the reviewed vendor layout as well as bytes',
        )
        assert.equal(
          splitSkillMarkdown(normalized.raw)?.body,
          splitSkillMarkdown(raw)?.body,
          'instruction bodies stay intact',
        )
      }
      const split = splitSkillMarkdown(normalized.raw)
      assert.ok(split, file)
      const result = validateSkillFrontmatter(split.frontmatter)
      assert.ok(result.skill, `${file}: ${result.reason ?? ''}`)
      assert.equal(folderNameMatchesSkill(file, result.skill.name), true, file)
      assert.ok(Array.from(result.skill.description).length <= 1024)
    }
    assert.equal(adapted, 2)
  })
})
