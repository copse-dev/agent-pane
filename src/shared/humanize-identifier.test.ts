import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { humanizeIdentifier } from './humanize-identifier.ts'

describe('humanizeIdentifier', () => {
  it('sentence-cases snake, kebab, and camel identifiers', () => {
    assert.equal(humanizeIdentifier('read_skill'), 'Read skill')
    assert.equal(humanizeIdentifier('browser-show'), 'Browser show')
    assert.equal(humanizeIdentifier('getFileContents'), 'Get file contents')
    assert.equal(humanizeIdentifier('Create_Issue'), 'Create issue')
  })

  it('keeps acronyms and product names in their canonical spelling', () => {
    assert.equal(humanizeIdentifier('launch_gui_app'), 'Launch GUI app')
    assert.equal(humanizeIdentifier('render_html_artefact'), 'Render HTML artefact')
    assert.equal(humanizeIdentifier('gh_pr_create'), 'GitHub PR create')
    assert.equal(humanizeIdentifier('get_ci_failure_logs'), 'Get CI failure logs')
    assert.equal(humanizeIdentifier('mcp-ui-canvas'), 'MCP UI canvas')
    assert.equal(humanizeIdentifier('api_key_ids'), 'API key IDs')
    assert.equal(humanizeIdentifier('devtools-shortcut'), 'DevTools shortcut')
    assert.equal(humanizeIdentifier('ci-investigator'), 'CI investigator')
  })

  it('keeps prose compounds hyphenated', () => {
    assert.equal(humanizeIdentifier('post-turn-review'), 'Post-turn review')
    assert.equal(humanizeIdentifier('long-horizon-tasks'), 'Long-horizon tasks')
    assert.equal(humanizeIdentifier('dark-factory'), 'Dark factory')
  })

  it('reads a trailing md as the Markdown file it names', () => {
    assert.equal(humanizeIdentifier('agents-md'), 'AGENTS.md')
    assert.equal(humanizeIdentifier('claude-md'), 'CLAUDE.md')
    assert.equal(humanizeIdentifier('read_agents_md'), 'Read AGENTS.md')
    assert.equal(humanizeIdentifier('md'), 'Md')
  })

  it('returns an identifier with no words unchanged', () => {
    assert.equal(humanizeIdentifier('__'), '__')
    assert.equal(humanizeIdentifier(''), '')
  })
})
