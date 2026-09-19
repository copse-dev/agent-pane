import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_PLUGIN_SCHEMA_ID } from '@copse/agent/plugins/agent-plugin-manifest.ts'
import {
  COPSE_PLUGINS_DIR_ENV,
  loadUserPlugin,
  userPluginDataDir,
} from './discover-user-plugins.ts'
import {
  agentPluginMcpServerName,
  prepareAgentPluginMcpConfigs,
} from './agent-plugin-mcp-runtime.ts'

describe('prepareAgentPluginMcpConfigs', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-agent-plugin-mcp-'))
    process.env[COPSE_PLUGINS_DIR_ENV] = root
  })

  afterEach(async () => {
    process.env[COPSE_PLUGINS_DIR_ENV] = ''
    await rm(root, { recursive: true, force: true })
  })

  async function writePlugin(name: string, servers: Record<string, unknown>): Promise<string> {
    const pluginRoot = join(root, name)
    await fsp.mkdir(pluginRoot, { recursive: true })
    await fsp.writeFile(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID, name }),
    )
    await fsp.writeFile(
      join(pluginRoot, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: servers,
      }),
    )
    return pluginRoot
  }

  it('maps plugin-local server names to stable provider-safe native names', () => {
    const first = agentPluginMcpServerName('acme.reviewer', 'server / with unicode 🧪')
    assert.match(first, /^[A-Za-z0-9_-]{1,64}$/)
    assert.equal(first, agentPluginMcpServerName('acme.reviewer', 'server / with unicode 🧪'))
    assert.notEqual(first, agentPluginMcpServerName('other.reviewer', 'server / with unicode 🧪'))
  })

  it('prepares stdio with contained paths, portable expansion, and persistent data', async () => {
    const pluginRoot = await writePlugin('acme.runtime', {
      local: {
        type: 'stdio',
        command: './bin/server',
        args: ['--root', '${PLUGIN_ROOT}', '--literal', '${HOME}'],
        env: { CACHE: '${PLUGIN_DATA}/cache', LITERAL: '${HOME}' },
        cwd: '${PLUGIN_DATA}',
      },
    })
    await fsp.mkdir(join(pluginRoot, 'bin'))
    await fsp.writeFile(join(pluginRoot, 'bin', 'server'), '#!/bin/sh\n')

    const candidate = await loadUserPlugin(pluginRoot)
    const prepared = await prepareAgentPluginMcpConfigs(candidate)
    const pluginData = await fsp.realpath(userPluginDataDir('acme.runtime'))

    assert.deepEqual(prepared.warnings, [])
    assert.equal(prepared.configs.length, 1)
    const config = prepared.configs[0]
    assert.ok(config)
    assert.equal(config.name, agentPluginMcpServerName('acme.runtime', 'local'))
    assert.equal(config.command, join(candidate.pluginRoot, 'bin', 'server'))
    assert.deepEqual(config.args, ['--root', candidate.pluginRoot, '--literal', '${HOME}'])
    assert.ok(config.env)
    assert.equal(config.env['PLUGIN_ROOT'], candidate.pluginRoot)
    assert.equal(config.env['PLUGIN_DATA'], pluginData)
    assert.equal(config.env['CACHE'], `${pluginData}/cache`)
    assert.equal(config.env['LITERAL'], '${HOME}')
    assert.equal(config.cwd, pluginData)
    assert.equal((await fsp.stat(userPluginDataDir('acme.runtime'))).isDirectory(), true)
  })

  it('isolates escaping package paths and unsupported SSE from valid siblings', async () => {
    const pluginRoot = await writePlugin('acme.boundaries', {
      escaping: { type: 'stdio', command: './bin/server' },
      docs: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-A': '1' },
      },
      legacy: { type: 'sse', url: 'https://example.com/events' },
    })
    const outside = join(root, 'outside-server')
    await fsp.writeFile(outside, '#!/bin/sh\n')
    await fsp.mkdir(join(pluginRoot, 'bin'))
    await fsp.symlink(outside, join(pluginRoot, 'bin', 'server'))

    const candidate = await loadUserPlugin(pluginRoot)
    const prepared = await prepareAgentPluginMcpConfigs(candidate)

    assert.deepEqual(
      prepared.configs.map((config) => config.name),
      [agentPluginMcpServerName('acme.boundaries', 'docs')],
    )
    assert.ok(prepared.warnings.some((warning) => warning.includes('escaping')))
    assert.ok(prepared.warnings.some((warning) => warning.includes('legacy')))
  })
})
