import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateToolNames } from './translate-tool-names.ts'

describe('translateToolNames', () => {
  it('maps Claude Code names to Copse names', () => {
    const { names } = translateToolNames(['Read', 'Write', 'Edit', 'Bash', 'Glob'])
    assert.deepEqual(names, ['read_file', 'write_file', 'str_replace', 'run_shell', 'find_files'])
  })

  it('expands Grep to both Copse search tools', () => {
    assert.deepEqual(translateToolNames(['Grep']).names, ['search_code', 'search_codebase'])
  })

  it('de-duplicates when two Claude names collapse onto one Copse tool', () => {
    assert.deepEqual(translateToolNames(['Edit', 'MultiEdit']).names, ['str_replace'])
  })

  it('passes MCP references through untouched', () => {
    const { names, dropped } = translateToolNames(['mcp__github', 'mcp__github__create_issue'])
    assert.deepEqual(names, ['mcp__github', 'mcp__github__create_issue'])
    assert.deepEqual(dropped, [])
  })

  it('accepts native Copse names, so a hand-written .copse definition works', () => {
    assert.deepEqual(translateToolNames(['read_file', 'run_shell']).names, [
      'read_file',
      'run_shell',
    ])
  })

  it('drops nested-delegation grants rather than half-honouring them', () => {
    const { names, dropped } = translateToolNames(['Read', 'Agent(reviewer)'])
    assert.deepEqual(names, ['read_file'])
    assert.deepEqual(dropped, ['Agent(reviewer)'])
  })

  it('reports names with no Copse equivalent', () => {
    const { names, dropped } = translateToolNames(['Read', 'NotebookEdit'])
    assert.deepEqual(names, ['read_file'])
    assert.deepEqual(dropped, ['NotebookEdit'])
  })

  it('ignores blank entries from a trailing comma', () => {
    assert.deepEqual(translateToolNames(['Read', '', '  ']).names, ['read_file'])
  })
})
