import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalAcpAgentId,
  LEGACY_ACP_AGENT_IDS,
  RETIRED_ACP_AGENTS,
  KNOWN_ACP_AGENTS,
} from './acp-known-agents.ts'

describe('KNOWN_ACP_AGENTS', () => {
  it('offers Qwen Code using its registry id and provider configuration guidance', () => {
    const qwen = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'qwen-code')
    assert.ok(qwen)
    assert.equal(qwen.command, 'qwen')
    assert.deepEqual(qwen.args, ['--acp'])
    assert.equal(qwen.installPackage, '@qwen-code/qwen-code')
    assert.equal(qwen.autoInstall, true)
    assert.equal(qwen.setup, 'qwen')
    assert.equal(qwen.reauth, 'qwen')
    assert.deepEqual(qwen.envHints, ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'])
    assert.ok(qwen.sandbox)
    assert.deepEqual(qwen.sandbox.homeDirs, ['.qwen'])
    assert.deepEqual(qwen.sandbox.allowedDomains, [])
    assert.match(qwen.note ?? '', /OAuth.*free tier has ended/)
  })
  it('launches Gemini CLI with the canonical --acp flag, not the deprecated alias', () => {
    // `--acp` landed in @google/gemini-cli 0.33.0 and is what the ACP registry
    // lists for agent id `gemini`. `--experimental-acp` still works as a
    // deprecated alias, so a regression here fails silently at runtime rather
    // than erroring — pin the spelling instead.
    const gemini = KNOWN_ACP_AGENTS.find((agent) => agent.id === 'gemini')
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

describe('registry-id alignment', () => {
  it('maps every legacy id onto an agent that still exists', () => {
    for (const [legacy, current] of Object.entries(LEGACY_ACP_AGENT_IDS)) {
      assert.equal(canonicalAcpAgentId(legacy), current)
      assert.ok(
        KNOWN_ACP_AGENTS.some((agent) => agent.id === current),
        `${legacy} aliases ${current}, which is not an offered agent`,
      )
    }
  })

  it('leaves unknown and already-current ids alone', () => {
    assert.equal(canonicalAcpAgentId('cursor'), 'cursor')
    assert.equal(canonicalAcpAgentId('my-custom-agent'), 'my-custom-agent')
  })

  it('never aliases a retired agent onto its replacement', () => {
    // A retirement is not a rename: redirecting `claude-code-acp` to the current
    // Claude adapter would make old threads claim they ran something else.
    for (const retired of RETIRED_ACP_AGENTS) {
      assert.equal(canonicalAcpAgentId(retired.id), retired.id)
    }
  })
})
