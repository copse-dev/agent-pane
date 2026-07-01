import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { unwrapInlineCode } from './session-update-adapter.ts'

/**
 * External ACP agents label tool calls with Markdown inline code; Copse renders
 * those titles as plain text, so the backticks must be stripped before display.
 */
describe('unwrapInlineCode', () => {
  it('strips a single backtick pair wrapping the whole title', () => {
    assert.equal(unwrapInlineCode('`cd /repo && git diff --stat`'), 'cd /repo && git diff --stat')
  })

  it('strips a double-backtick pair (used when the content has a backtick)', () => {
    assert.equal(unwrapInlineCode('``git log --format=`%h` ``'), 'git log --format=`%h`')
  })

  it('unwraps a fenced code block, dropping the info string', () => {
    assert.equal(unwrapInlineCode('```sh\nnpm test\n```'), 'npm test')
  })

  it('leaves titles with only mid-string code untouched', () => {
    assert.equal(unwrapInlineCode('run `git diff` now'), 'run `git diff` now')
  })

  it('leaves plain titles untouched and trims whitespace', () => {
    assert.equal(unwrapInlineCode('  read_file  '), 'read_file')
    assert.equal(unwrapInlineCode('git status'), 'git status')
  })

  it('does not strip an empty inline pair', () => {
    assert.equal(unwrapInlineCode('``'), '``')
  })
})
