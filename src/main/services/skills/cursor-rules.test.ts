import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildAgentRequestedRulesCatalog,
  classifyCursorRule,
  contextMatchesGlobs,
  discoverCursorRules,
  extractContextPathsFromText,
  isRuleMentioned,
  loadCursorRuleSources,
  parseRuleDescription,
  parseRuleGlobs,
  selectInjectableCursorRules,
  type CursorRuleSource,
} from './cursor-rules.ts'

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
      sources.map((s) => ({ name: s.name, content: s.content, kind: s.kind })),
      [
        {
          name: join('.cursor', 'rules', 'style.mdc'),
          content: 'Use tabs, not spaces.',
          kind: 'always',
        },
      ],
    )
  })

  it('skips non-always rules when no turn context is provided', async () => {
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

  it('classifies Always / Auto / Agent / Manual from frontmatter', () => {
    assert.equal(classifyCursorRule('alwaysApply: true\n').kind, 'always')
    assert.equal(classifyCursorRule('globs: ["*.ts"]\nalwaysApply: false\n').kind, 'auto')
    assert.equal(
      classifyCursorRule('description: RPC conventions\nalwaysApply: false\n').kind,
      'agent',
    )
    assert.equal(classifyCursorRule('alwaysApply: false\n').kind, 'manual')
  })

  it('parses description and globs forms', () => {
    assert.equal(parseRuleDescription('description: "Hello world"\n'), 'Hello world')
    assert.deepEqual(parseRuleGlobs('globs: src/**/*.tsx\n'), ['src/**/*.tsx'])
    assert.deepEqual(parseRuleGlobs('globs: docs/**/*.md, docs/**/*.mdx\n'), [
      'docs/**/*.md',
      'docs/**/*.mdx',
    ])
    assert.deepEqual(parseRuleGlobs('globs: ["*.ts", "src/**/*.tsx"]\n'), ['*.ts', 'src/**/*.tsx'])
  })

  it('matches auto-attach globs against context paths', () => {
    assert.equal(contextMatchesGlobs(['src/main/index.ts'], ['src/**/*.ts']), true)
    assert.equal(contextMatchesGlobs(['src/main/index.ts'], ['*.ts']), true)
    assert.equal(contextMatchesGlobs(['README.md'], ['*.ts']), false)
  })

  it('extracts context paths from user text and attachment fences', () => {
    const paths = extractContextPathsFromText(
      'Please fix src/main/index.ts\n\n```\n// packages/app/src/button.ts\nexport {}\n```',
    )
    assert.ok(paths.includes('src/main/index.ts'))
    assert.ok(paths.includes('packages/app/src/button.ts'))
  })

  it('auto-attaches glob rules when a matching path is in context', async () => {
    await writeRule(
      '.cursor/rules/ts.mdc',
      '---\nglobs: ["**/*.ts"]\nalwaysApply: false\n---\nTS-only conventions.',
    )
    await writeRule(
      '.cursor/rules/css.mdc',
      '---\nglobs: ["**/*.css"]\nalwaysApply: false\n---\nCSS-only.',
    )
    const sources = await loadCursorRuleSources(root, {
      contextPaths: ['src/foo.ts'],
      userText: 'edit src/foo.ts',
    })
    assert.deepEqual(
      sources.map((s) => s.name),
      [join('.cursor', 'rules', 'ts.mdc')],
    )
  })

  it('injects manual rules when @-mentioned', async () => {
    await writeRule('.cursor/rules/migration.mdc', '---\nalwaysApply: false\n---\nMigration rules.')
    const sources = await loadCursorRuleSources(root, {
      userText: 'Follow @migration for this change',
    })
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.kind, 'manual')
  })

  it('isRuleMentioned accepts basename and relative path forms', () => {
    const rule: CursorRuleSource = {
      path: '/x/.cursor/rules/migration.mdc',
      name: join('.cursor', 'rules', 'migration.mdc'),
      content: 'body',
      kind: 'manual',
    }
    assert.equal(isRuleMentioned(rule, 'see @migration'), true)
    assert.equal(isRuleMentioned(rule, 'see @migration.mdc'), true)
    assert.equal(isRuleMentioned(rule, 'unrelated'), false)
  })

  it('discovers all kinds and catalogs agent-requested rules', async () => {
    await writeRule('.cursor/rules/always.mdc', '---\nalwaysApply: true\n---\nAlways body.')
    await writeRule(
      '.cursor/rules/rpc.mdc',
      '---\ndescription: RPC service conventions\nalwaysApply: false\n---\nRPC body.',
    )
    const all = await discoverCursorRules(root)
    assert.deepEqual(all.map((r) => r.kind).sort(), ['agent', 'always'])
    const catalog = buildAgentRequestedRulesCatalog(all)
    assert.match(catalog, /available_cursor_rules/)
    assert.match(catalog, /RPC service conventions/)
    assert.match(catalog, /read_file/)
    assert.equal(
      selectInjectableCursorRules(all)
        .map((r) => r.kind)
        .join(','),
      'always',
    )
  })
})
