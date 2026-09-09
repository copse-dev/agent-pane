import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTAINER_ACP_AGENTS,
  containerAcpAgent,
  containerAcpAgentSpecs,
  containerAcpAgentTitles,
  containerAcpAvailability,
  containerAcpLoginFiles,
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
      credential: 'key',
      loginOffered: false,
    })
    // Claude keeps its OAuth in the macOS Keychain: no sign-in to carry, so
    // the missing key is the whole story.
    assert.deepEqual(containerAcpAvailability('claude-acp', { anthropic: false }), {
      runnable: false,
      reason: 'needs an Anthropic API key in Settings',
      credential: null,
      loginOffered: false,
    })
    assert.equal(containerAcpAvailability('codex-acp', { openai: true }).credential, 'key')
  })

  it('offers the sign-in for Codex and Gemini without a key, and runs on it only when opted in', () => {
    const offered = containerAcpAvailability('gemini', {})
    assert.equal(offered.runnable, false)
    assert.equal(offered.loginOffered, true)
    assert.equal(
      offered.reason,
      'needs a Gemini API key in Settings, or your Gemini CLI sign-in (opt in below)',
    )
    assert.deepEqual(containerAcpAvailability('codex-acp', {}, { useLogin: true }), {
      runnable: true,
      reason: null,
      credential: 'login',
      loginOffered: false,
    })
    // A key always wins over the sign-in, opted in or not.
    assert.equal(
      containerAcpAvailability('codex-acp', { openai: true }, { useLogin: true }).credential,
      'key',
    )
    // The opt-in changes nothing for an agent with no sign-in to carry.
    assert.equal(containerAcpAvailability('claude-acp', {}, { useLogin: true }).runnable, false)
    assert.deepEqual(containerAcpLoginFiles('codex-acp'), ['.codex/auth.json'])
    assert.deepEqual(containerAcpLoginFiles('gemini'), [
      '.gemini/oauth_creds.json',
      '.gemini/google_accounts.json',
      '.gemini/settings.json',
    ])
    assert.equal(containerAcpLoginFiles('claude-acp'), null)
    assert.equal(containerAcpLoginFiles('cursor'), null)
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

  it('lists each key slug the runnable agents draw on once', () => {})

  it('names the runnable agents by their catalogue titles', () => {
    assert.deepEqual(containerAcpAgentTitles(), ['Claude', 'Codex', 'Gemini CLI'])
  })
})
