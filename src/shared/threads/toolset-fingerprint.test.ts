import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { LLMTool } from '@shared/types'
import { fingerprintToolset } from './toolset-fingerprint.ts'

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

const readFile: LLMTool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

const runShell: LLMTool = {
  name: 'run_shell',
  description: 'Run a command',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
}

describe('toolset fingerprint (decision 6)', () => {
  it('is stable across tool ordering', () => {
    const a = fingerprintToolset([readFile, runShell], sha256)
    const b = fingerprintToolset([runShell, readFile], sha256)
    assert.equal(a.hash, b.hash)
    assert.equal(a.contents, b.contents)
  })

  it('is stable across schema key ordering', () => {
    const reordered: LLMTool = {
      name: 'read_file',
      description: 'Read a file',
      parameters: { properties: { path: { type: 'string' } }, type: 'object' },
    }
    assert.equal(
      fingerprintToolset([readFile], sha256).hash,
      fingerprintToolset([reordered], sha256).hash,
    )
  })

  it('changes when a tool schema changes', () => {
    const widened: LLMTool = {
      ...readFile,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start_line: { type: 'number' } },
      },
    }
    assert.notEqual(
      fingerprintToolset([readFile], sha256).hash,
      fingerprintToolset([widened], sha256).hash,
    )
  })

  it('changes when a tool is added or removed', () => {
    assert.notEqual(
      fingerprintToolset([readFile], sha256).hash,
      fingerprintToolset([readFile, runShell], sha256).hash,
    )
  })

  it('lists sorted tool names with per-tool schema hashes in the blob body', () => {
    const { contents, hash } = fingerprintToolset([runShell, readFile], sha256)
    const parsed = JSON.parse(contents) as {
      v: number
      tools: { name: string; schemaHash: string }[]
    }
    assert.equal(parsed.v, 1)
    assert.deepEqual(
      parsed.tools.map((t) => t.name),
      ['read_file', 'run_shell'],
    )
    for (const tool of parsed.tools) assert.match(tool.schemaHash, /^[0-9a-f]{64}$/)
    // Content-addressed: the hash is the hash of the blob body itself.
    assert.equal(hash, sha256(contents))
  })
})
