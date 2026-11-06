import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { instructionContextPathsForTool } from './instruction-context-paths.ts'

describe('instruction context paths', () => {
  it('keeps both sides of a rename and ignores malformed path values', () => {
    assert.deepEqual(
      instructionContextPathsForTool('rename_file', { from: 'old/a.ts', to: 'new/a.ts' }),
      ['old/a.ts', 'new/a.ts'],
    )
    assert.deepEqual(instructionContextPathsForTool('write_file', { path: 17 }), [])
    assert.deepEqual(instructionContextPathsForTool('read_file', { path: '   ' }), [])
  })

  it('uses the patch parser to include every changed and moved path', () => {
    assert.deepEqual(
      instructionContextPathsForTool('apply_patch', {
        input:
          '*** Begin Patch\n*** Update File: old/a.ts\n*** Move to: new/a.ts\n@@\n-before\n+after\n*** Add File: other/b.ts\n+new\n*** End Patch',
      }),
      ['old/a.ts', 'new/a.ts', 'other/b.ts'],
    )
  })

  it('does not assign file authority to unknown tools or inherited object properties', () => {
    for (const name of ['mcp__files__write', 'constructor', '__proto__']) {
      assert.deepEqual(instructionContextPathsForTool(name, { path: 'nested/file.ts' }), [])
    }
  })
})
