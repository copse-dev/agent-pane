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

  it('stops reading stdout at the result message and bounds the exit wait', () => {
    assert.match(source, /if message_type == "result":[\s\S]+?break/)
    assert.match(source, /wait_for\(process\.wait\(\), timeout=_EXIT_GRACE_SECONDS\)/)
    assert.match(source, /forced_stop = True\s+process\.terminate\(\)/)
  })

  it('sends the discovered workspace root to the agent bridge', () => {
    assert.match(source, /"workspaceRoot": workspace_root/)
    assert.match(source, /COPSE_TERMINAL_PROFILE_VERSIONED_ID/)
  })

  it('retains the runtime settings the agent reports for comparison gating', () => {
    assert.match(
      source,
      /context\.metadata\["runtime_configuration"\] = result_message\[\s*"runtimeConfiguration"\s*\]/,
    )
  })
})
