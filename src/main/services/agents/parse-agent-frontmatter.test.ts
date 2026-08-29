import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAgentFile,
  type ParsedAgentFile,
  type RejectedAgentFile,
} from './parse-agent-frontmatter.ts'
import type { AgentContainer } from '@shared/types/agents.ts'

const CLAUDE_PATH = '/home/u/.claude/agents/reviewer.md'
const CURSOR_PATH = '/home/u/.cursor/agents/verifier.md'

function parseOk(
  raw: string,
  path = CLAUDE_PATH,
  container: AgentContainer = '.claude',
): ParsedAgentFile {
  const result = parseAgentFile(raw, path, container)
  assert.equal(result.ok, true, `expected parse to succeed: ${JSON.stringify(result)}`)
  assert.ok(result.ok)
  return result.agent
}

function parseRejected(
  raw: string,
  path = CLAUDE_PATH,
  container: AgentContainer = '.claude',
): RejectedAgentFile {
  const result = parseAgentFile(raw, path, container)
  assert.equal(result.ok, false, 'expected parse to be rejected')
  assert.ok(!result.ok)
  return result.rejected
}

describe('parseAgentFile', () => {
  it('parses a Claude Code definition, body becomes the system prompt', () => {
    const agent = parseOk(
      [
        '---',
        'name: reviewer',
        'description: Reviews code',
        'model: sonnet',
        '---',
        '',
        'You review code.',
      ].join('\n'),
    )
    assert.equal(agent.name, 'reviewer')
    assert.equal(agent.description, 'Reviews code')
    assert.equal(agent.model, 'sonnet')
    assert.equal(agent.body, 'You review code.')
    assert.equal(agent.readonly, false)
  })

  it('translates a comma-separated tool list and reports what it dropped', () => {
    const agent = parseOk(
      [
        '---',
        'name: reviewer',
        'description: d',
        'tools: Read, Grep, NotebookEdit',
        '---',
        'body',
      ].join('\n'),
    )
    assert.deepEqual(agent.tools, ['read_file', 'search_code', 'search_codebase'])
    const note = agent.unsupportedFields.find((f) => f.field === 'tools')
    assert.ok(note, 'expected a note about the dropped tool')
    assert.match(note.reason, /NotebookEdit/)
  })

  it('parses a block-sequence tool list and a disallowed list', () => {
    const agent = parseOk(
      [
        '---',
        'name: r',
        'description: d',
        'tools:',
        '  - Read',
        '  - Bash',
        'disallowedTools: Write',
        '---',
        'b',
      ].join('\n'),
    )
    assert.deepEqual(agent.tools, ['read_file', 'run_shell'])
    assert.deepEqual(agent.disallowedTools, ['write_file'])
  })

  it('maps permissionMode: plan to a read-only run', () => {
    const agent = parseOk(
      ['---', 'name: r', 'description: d', 'permissionMode: plan', '---', 'b'].join('\n'),
    )
    assert.equal(agent.readonly, true)
    assert.equal(
      agent.unsupportedFields.some((f) => f.field === 'permissionMode'),
      false,
      'plan is mapped, not unsupported',
    )
  })

  it('ignores permission-widening modes and says so', () => {
    const agent = parseOk(
      ['---', 'name: r', 'description: d', 'permissionMode: bypassPermissions', '---', 'b'].join(
        '\n',
      ),
    )
    assert.equal(agent.readonly, false)
    const note = agent.unsupportedFields.find((f) => f.field === 'permissionMode')
    assert.ok(note)
    assert.match(note.reason, /ignored/)
  })

  it('maps Cursor readonly: true to a read-only run', () => {
    const agent = parseOk(
      ['---', 'name: verifier', 'description: d', 'readonly: true', '---', 'b'].join('\n'),
      CURSOR_PATH,
      '.cursor',
    )
    assert.equal(agent.readonly, true)
  })

  it('flags isolation: worktree, because the agent will edit the real tree', () => {
    const agent = parseOk(
      ['---', 'name: r', 'description: d', 'isolation: worktree', '---', 'b'].join('\n'),
    )
    const note = agent.unsupportedFields.find((f) => f.field === 'isolation')
    assert.ok(note)
    assert.match(note.reason, /working tree/)
  })

  it('strips Cursor model options and notes it', () => {
    const agent = parseOk(
      ['---', 'name: v', 'description: d', 'model: composer-2[fast]', '---', 'b'].join('\n'),
      CURSOR_PATH,
      '.cursor',
    )
    assert.equal(agent.model, 'composer-2')
    assert.ok(agent.unsupportedFields.some((f) => f.field === 'model'))
  })

  it('defaults model to inherit', () => {
    const agent = parseOk(['---', 'name: r', 'description: d', '---', 'b'].join('\n'))
    assert.equal(agent.model, 'inherit')
  })

  it('derives name from the filename in .cursor but not in .claude', () => {
    const frontmatter = ['---', 'description: d', '---', 'b'].join('\n')
    assert.equal(parseOk(frontmatter, CURSOR_PATH, '.cursor').name, 'verifier')

    const rejected = parseRejected(frontmatter)
    assert.match(rejected.reason, /documentation/)
    assert.equal(rejected.report, false, 'documentation is skipped silently')
  })

  it('rejects reserved and malformed names, and reports them', () => {
    for (const name of ['-bad', 'plugin:scoped', 'Has Spaces']) {
      const rejected = parseRejected(
        ['---', `name: ${name}`, 'description: d', '---', 'b'].join('\n'),
      )
      assert.equal(rejected.report, true, `${name} should be reported`)
    }
  })

  it('treats a file with no frontmatter as documentation, silently', () => {
    const rejected = parseRejected('# Just a readme\n')
    assert.match(rejected.reason, /documentation/)
    assert.equal(rejected.report, false)
  })

  it('reports a frontmatter block that is never closed', () => {
    const rejected = parseRejected('---\nname: r\ndescription: d\n\nbody with no fence\n')
    assert.match(rejected.reason, /never closed/)
    assert.equal(rejected.report, true)
  })

  it('does not end frontmatter on a --- inside a fenced code block', () => {
    const agent = parseOk(
      [
        '---',
        'name: r',
        'description: d',
        '---',
        '',
        'Example:',
        '',
        '```yaml',
        '---',
        'a: b',
        '```',
      ].join('\n'),
    )
    assert.match(agent.body, /```yaml/)
    assert.equal(agent.name, 'r')
  })

  it('handles CRLF files', () => {
    const agent = parseOk(
      ['---', 'name: r', 'description: Reviews', '---', 'body text'].join('\r\n'),
    )
    assert.equal(agent.description, 'Reviews')
    assert.equal(agent.body, 'body text')
  })

  it('only accepts a positive integer maxTurns', () => {
    assert.equal(
      parseOk(['---', 'name: r', 'description: d', 'maxTurns: 5', '---', 'b'].join('\n')).maxTurns,
      5,
    )
    assert.equal(
      parseOk(['---', 'name: r', 'description: d', 'maxTurns: 0', '---', 'b'].join('\n')).maxTurns,
      null,
    )
    assert.equal(
      parseOk(['---', 'name: r', 'description: d', 'maxTurns: lots', '---', 'b'].join('\n'))
        .maxTurns,
      null,
    )
  })

  it('reports fields it recognises but does not honour', () => {
    const agent = parseOk(
      [
        '---',
        'name: r',
        'description: d',
        'memory: project',
        'hooks:',
        '  PreToolUse: []',
        '---',
        'b',
      ].join('\n'),
    )
    const fields = agent.unsupportedFields.map((f) => f.field)
    assert.ok(fields.includes('memory'))
    assert.ok(fields.includes('hooks'))
  })
})
