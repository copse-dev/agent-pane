import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENTS_MD_INSTRUCTION_FILES_SETTING_ID,
  AGENTS_MD_INSTRUCTION_SOURCE,
  AGENTS_MD_PLUGIN_ID,
  DEFAULT_AGENTS_MD_INSTRUCTION_FILES_MODE,
  agentsMdPlugin,
  normalizeAgentsMdInstructionFilesMode,
  resolveInstructionSourceSelection,
  type InstructionSourceSelection,
} from './agents-md-plugin.ts'
import { CLAUDE_MD_INSTRUCTION_SOURCE, CLAUDE_MD_PLUGIN_ID } from './claude-md-plugin.ts'
import { CURSOR_RULES_INSTRUCTION_SOURCE, CURSOR_RULES_PLUGIN_ID } from './cursor-rules-plugin.ts'
import { createFirstPartyPluginRegistry, FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

describe('instruction source plugins', () => {
  it('registers the three first-party source families', () => {
    assert.equal(FIRST_PARTY_PLUGINS.includes(agentsMdPlugin), true)
    const registry = createFirstPartyPluginRegistry()
    assert.deepEqual(
      registry.activeInstructionSources().map((source) => source.name),
      [CLAUDE_MD_INSTRUCTION_SOURCE, AGENTS_MD_INSTRUCTION_SOURCE, CURSOR_RULES_INSTRUCTION_SOURCE],
    )
    assert.equal(registry.isEnabled(CLAUDE_MD_PLUGIN_ID), true)
    assert.equal(registry.isEnabled(AGENTS_MD_PLUGIN_ID), true)
    assert.equal(registry.isEnabled(CURSOR_RULES_PLUGIN_ID), true)
  })

  it('declares the Claude-compatible four-mode setting with fallback as the default', () => {
    const setting = agentsMdPlugin.manifest.settings?.[AGENTS_MD_INSTRUCTION_FILES_SETTING_ID]
    assert.ok(setting)
    assert.equal(setting.kind, 'enum')
    assert.equal(setting.default, DEFAULT_AGENTS_MD_INSTRUCTION_FILES_MODE)
    assert.deepEqual(setting.options, [
      'claude-md',
      'claude-md-or-agents-md',
      'claude-md-and-agents-md',
      'managed-only',
    ])
    assert.equal(normalizeAgentsMdInstructionFilesMode('unknown'), 'claude-md-or-agents-md')
  })

  it('pins the four source-selection modes', () => {
    const select = (
      instructionFiles: string,
      hasProjectClaudeMd = false,
    ): InstructionSourceSelection =>
      resolveInstructionSourceSelection({
        agentsMdPluginEnabled: true,
        claudeMdPluginEnabled: true,
        instructionFiles,
        hasProjectClaudeMd,
      })

    assert.deepEqual(select('claude-md'), {
      claudeMd: true,
      agentsMd: false,
      managedOnly: false,
      mode: 'claude-md',
    })
    assert.deepEqual(select('claude-md-or-agents-md'), {
      claudeMd: true,
      agentsMd: true,
      managedOnly: false,
      mode: 'claude-md-or-agents-md',
    })
    assert.deepEqual(select('claude-md-or-agents-md', true), {
      claudeMd: true,
      agentsMd: false,
      managedOnly: false,
      mode: 'claude-md-or-agents-md',
    })
    assert.deepEqual(select('claude-md-and-agents-md', true), {
      claudeMd: true,
      agentsMd: true,
      managedOnly: false,
      mode: 'claude-md-and-agents-md',
    })
    assert.deepEqual(select('managed-only'), {
      claudeMd: false,
      agentsMd: false,
      managedOnly: true,
      mode: 'managed-only',
    })
  })

  it('restores CLAUDE.md-only behavior when the AGENTS.md plugin is disabled', () => {
    assert.deepEqual(
      resolveInstructionSourceSelection({
        agentsMdPluginEnabled: false,
        claudeMdPluginEnabled: true,
        instructionFiles: 'managed-only',
        hasProjectClaudeMd: false,
      }),
      {
        claudeMd: true,
        agentsMd: false,
        managedOnly: false,
        mode: 'claude-md',
      },
    )
  })

  it('does not let a disabled CLAUDE.md provider suppress AGENTS.md fallback', () => {
    assert.deepEqual(
      resolveInstructionSourceSelection({
        agentsMdPluginEnabled: true,
        claudeMdPluginEnabled: false,
        instructionFiles: 'claude-md-or-agents-md',
        hasProjectClaudeMd: true,
      }),
      {
        claudeMd: false,
        agentsMd: true,
        managedOnly: false,
        mode: 'claude-md-or-agents-md',
      },
    )
  })
})
