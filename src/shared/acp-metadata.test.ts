import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACP_REGISTRY_AGENTS,
  ACP_REGISTRY_PIN,
  acpRegistryAgent,
  pinnedNpxSpec,
  suggestedCommandFromNpx,
} from './acp-metadata.ts'
import { KNOWN_ACP_AGENTS, RETIRED_ACP_AGENTS, LEGACY_ACP_AGENT_IDS } from './acp-known-agents.ts'

// The loader enforces the structural rules at import (strict schemas; curated
// ids must be registry-listed or retired; a retired id can never also be a
// legacy alias). These tests cover the cross-section facts the loader's
// per-entry checks cannot see.

describe('ACP registry pin', () => {
  it('records provenance: tag, publish date, sync date, and the 7-day cooldown', () => {
    assert.match(ACP_REGISTRY_PIN.tag, /^v\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/)
    assert.ok(Date.parse(ACP_REGISTRY_PIN.publishedAt) > 0)
    assert.equal(ACP_REGISTRY_PIN.cooldownDays, 7)
    // The pin must actually have been cooled: published at least cooldownDays
    // before it was synced (both stamps come from the sync script).
    const cooledMs = ACP_REGISTRY_PIN.cooldownDays * 24 * 60 * 60 * 1000
    assert.ok(
      Date.parse(ACP_REGISTRY_PIN.syncedAt) - Date.parse(ACP_REGISTRY_PIN.publishedAt) >= cooledMs,
      'pinned release is younger than the cooldown',
    )
  })

  it('keeps registry ids unique and sorted', () => {
    const ids = ACP_REGISTRY_AGENTS.map((agent) => agent.id)
    assert.deepEqual([...new Set(ids)], ids)
    assert.deepEqual([...ids].sort(), ids)
  })
})

describe('curated overlay against the pinned snapshot', () => {
  it('annotates every curated npm agent with the registry-pinned install spec', () => {
    for (const known of KNOWN_ACP_AGENTS) {
      if (!known.installPackage) continue
      const spec = known.installPackagePinned
      assert.ok(spec, `${known.id} has installPackage but no pinned spec from the registry`)
      assert.ok(
        spec.startsWith(`${known.installPackage}@`),
        `${known.id} pinned spec '${spec}' does not pin ${known.installPackage}`,
      )
      // The spec's version must be the snapshot's version for the same agent —
      // one pin, not two.
      const registry = acpRegistryAgent(known.id)
      assert.ok(registry)
      assert.equal(spec, `${known.installPackage}@${registry.version}`)
    }
  })

  it('spawns sandboxed and registers presets only for curated agents', () => {
    // Registry-only agents must never carry preset/autoInstall powers: those
    // come from the hand-reviewed overlay alone.
    for (const known of KNOWN_ACP_AGENTS) {
      if (known.preset) {
        assert.ok(known.sandbox, `preset '${known.id}' ships without a seatbelt profile`)
      }
      if (known.autoInstall) {
        assert.ok(known.installPackage, `autoInstall '${known.id}' has no npm package`)
      }
    }
  })

  it('keeps retired agents out of the offered set but fully profiled', () => {
    const offered = new Set(KNOWN_ACP_AGENTS.map((agent) => agent.id))
    for (const retired of RETIRED_ACP_AGENTS) {
      assert.ok(!offered.has(retired.id), `retired '${retired.id}' is still offered`)
      assert.ok(retired.reason)
      assert.ok(retired.sandbox, `retired '${retired.id}' lost its seatbelt profile`)
    }
  })

  it('points every legacy alias at an offered agent', () => {
    for (const current of Object.values(LEGACY_ACP_AGENT_IDS)) {
      assert.ok(
        KNOWN_ACP_AGENTS.some((agent) => agent.id === current),
        `legacy alias target '${current}' is not offered`,
      )
    }
  })
})

describe('pinned npx helpers', () => {
  it('resolves the pinned spec by id and null for binary-only agents', () => {
    assert.equal(pinnedNpxSpec('cursor'), null) // binary distribution
    const claude = pinnedNpxSpec('claude-acp')
    assert.ok(claude?.startsWith('@agentclientprotocol/claude-agent-acp@'))
  })

  it('suggests a PATH command from an npx spec: basename, no scope, no version', () => {
    assert.equal(
      suggestedCommandFromNpx('@agentclientprotocol/claude-agent-acp@0.69.0'),
      'claude-agent-acp',
    )
    assert.equal(suggestedCommandFromNpx('@google/gemini-cli@0.55.1'), 'gemini-cli')
    assert.equal(suggestedCommandFromNpx('opencode-ai@1.2.3'), 'opencode-ai')
    assert.equal(suggestedCommandFromNpx('plain-package'), 'plain-package')
  })
})
