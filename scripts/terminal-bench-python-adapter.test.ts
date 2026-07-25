import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const source = readFileSync(resolve('benchmarks/terminal_bench/copse_agent.py'), 'utf8')

describe('Terminal-Bench Python adapter', () => {
  it('raises the subprocess JSONL limit above asyncio readline defaults', () => {
    assert.match(source, /_BRIDGE_STREAM_LIMIT_BYTES = 8 \* 1024 \* 1024/)
    assert.match(source, /create_subprocess_exec\([\s\S]+limit=_BRIDGE_STREAM_LIMIT_BYTES/)
  })

  it('sends the discovered workspace root to the agent bridge', () => {
    assert.match(source, /"workspaceRoot": workspace_root/)
    assert.match(source, /COPSE_TERMINAL_PROFILE_VERSIONED_ID/)
  })
})
