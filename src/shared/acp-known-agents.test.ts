import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_ACP_AGENTS } from './acp-known-agents.ts'

describe('KNOWN_ACP_AGENTS', () => {
  it('launches Gemini CLI with the canonical --acp flag, not the deprecated alias', () => {
    // `--acp` landed in @google/gemini-cli 0.33.0 and is what the ACP registry
    // lists for agent id `gemini`. `--experimental-acp` still works as a
    // deprecated alias, so a regression here fails silently at runtime rather
    // than erroring — pin the spelling instead.
    const gemini = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'gemini-cli')
    assert.ok(gemini, 'gemini-cli entry is missing from the catalog')
    assert.deepEqual(gemini.args, ['--acp'])
  })

  it('gives every entry a unique id and a command', () => {
    const ids = KNOWN_ACP_AGENTS.map((agent) => agent.id)
    assert.deepEqual([...new Set(ids)], ids, 'duplicate agent ids in the catalog')
    for (const agent of KNOWN_ACP_AGENTS) {
      assert.ok(agent.command, `${agent.id} has no command`)
      assert.ok(agent.title, `${agent.id} has no title`)
    }
  })
})
