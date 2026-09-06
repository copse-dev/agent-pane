import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTAINER_ACP_AGENTS,
  containerAcpAgent,
  containerAcpAgentSpecs,
  containerAcpAgentTitles,
  containerAcpAvailability,
} from './container-acp-agents.ts'
import { KNOWN_ACP_AGENTS } from './acp-known-agents.ts'

describe('container ACP agents', () => {
  it('names only catalogue agents, each with a pinned package and a key path', () => {
    for (const agent of CONTAINER_ACP_AGENTS) {
      const known = KNOWN_ACP_AGENTS.find((candidate) => candidate.id === agent.id)
      assert.ok(known, `${agent.id} is not in the catalogue`)
      assert.match(agent.version, /^\d+\.\d+\.\d+$/)
      // The key the agent reads is one the catalogue documents for it.
      assert.ok(known.envHints?.includes(agent.keyEnv), `${agent.id} does not read ${agent.keyEnv}`)
    }
    assert.deepEqual(
      containerAcpAgentSpecs(),
      CONTAINER_ACP_AGENTS.map((agent) => `${agent.npmPackage}@${agent.version}`),
    )
  })

  it('never bakes an agent whose only sign-in is a browser', () => {
    assert.equal(containerAcpAgent('cursor'), null)
  })

  it('resolves the retired spelling of an agent to its current entry', () => {
    assert.equal(containerAcpAgent('claude-code-acp')?.id, 'claude-acp')
  })

  it('runs a key-capable agent only when its key is configured, and says which key', () => {
    assert.deepEqual(containerAcpAvailability('claude-acp', { anthropic: true }), {
      runnable: true,
      reason: null,
    })
    assert.deepEqual(containerAcpAvailability('claude-acp', { anthropic: false }), {
      runnable: false,
      reason: 'needs an Anthropic API key in Settings',
    })
    assert.equal(
      containerAcpAvailability('gemini', {}).reason,
      'needs a Gemini API key in Settings',
    )
    assert.equal(containerAcpAvailability('codex-acp', { openai: true }).runnable, true)
  })

  it('gives the browser-login agent and a custom agent their own reasons', () => {
    assert.equal(
      containerAcpAvailability('cursor', { cursor: true }).reason,
      'signs in through a browser; no API-key path',
    )
    assert.equal(
      containerAcpAvailability('my-own-agent', {}).reason,
      'not carried by the worker image',
    )
  })

  it('names the runnable agents by their catalogue titles', () => {
    assert.deepEqual(containerAcpAgentTitles(), ['Claude', 'Codex', 'Gemini CLI'])
  })
})
