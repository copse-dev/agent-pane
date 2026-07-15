import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getReadonlyToolBlockReason,
  isToolAllowedInReadonlyMode,
  isMcpToolAllowedInReadonlyMode,
  READONLY_MODE_BLOCK_MESSAGE,
} from './readonly-tools.ts'

describe('readonly-tools', () => {
  it('allows read/search/git/explore and staged-diff inspection tools', () => {
    for (const name of [
      'read_file',
      'list_dir',
      'search_code',
      'search_codebase',
      'semantic_search',
      'find_files',
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'staged_diffs',
      'read_staged_diff',
      'read_skill',
      'explore',
      'ask_user',
      'read_terminal',
    ]) {
      assert.equal(getReadonlyToolBlockReason(name), null, name)
      assert.equal(isToolAllowedInReadonlyMode(name), true, name)
    }
  })

  it('default-denies mutating and network built-in tools (even unlisted ones)', () => {
    for (const name of [
      'write_file',
      'str_replace',
      'delete_file',
      'rename_file',
      'make_directory',
      'run_shell',
      'update_todos',
      'fetch_url',
      'web_search',
      'some_future_tool',
    ]) {
      assert.equal(isToolAllowedInReadonlyMode(name), false, name)
      const reason = getReadonlyToolBlockReason(name)
      assert.ok(reason, name)
      assert.match(reason, new RegExp(READONLY_MODE_BLOCK_MESSAGE), name)
    }
  })

  it('allows MCP tools flagged read-only and non-destructive', () => {
    assert.equal(isMcpToolAllowedInReadonlyMode({ readOnlyHint: true }), true)
    assert.equal(
      getReadonlyToolBlockReason('mcp__server__tool', {
        mcpAnnotations: { readOnlyHint: true },
      }),
      null,
    )
  })

  it('blocks MCP tools without a read-only hint or with a destructive hint', () => {
    assert.ok(getReadonlyToolBlockReason('mcp__server__tool'))
    assert.ok(
      getReadonlyToolBlockReason('mcp__server__tool', {
        mcpAnnotations: { readOnlyHint: true, destructiveHint: true },
      }),
    )
    assert.equal(
      isMcpToolAllowedInReadonlyMode({ readOnlyHint: true, destructiveHint: true }),
      false,
    )
  })
})
