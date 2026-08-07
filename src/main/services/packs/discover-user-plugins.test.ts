import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_PLUGIN_SCHEMA_ID,
  COPSE_EXTENSION_NAMESPACE,
} from '@copse/agent/packs/agent-plugin-manifest.ts'
import {
  COPSE_PLUGINS_DIR_ENV,
  discoverUserPlugins,
  registeredUserPlugin,
  userPluginDataDir,
  userPluginsRoot,
} from './discover-user-plugins.ts'

let root = ''

async function writePlugin(
  dir: string,
  manifest: Record<string, unknown> | string,
  extras: { skills?: boolean; mcp?: string } = {},
): Promise<string> {
  const pluginRoot = join(root, dir)
  await fsp.mkdir(pluginRoot, { recursive: true })
  await fsp.writeFile(
    join(pluginRoot, 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  )
  if (extras.skills) {
    await fsp.mkdir(join(pluginRoot, 'skills', 'summarize'), { recursive: true })
    await fsp.writeFile(join(pluginRoot, 'skills', 'summarize', 'SKILL.md'), '# summarize')
  }
  if (extras.mcp !== undefined) await fsp.writeFile(join(pluginRoot, 'mcp.json'), extras.mcp)
  return pluginRoot
}

function manifest(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: AGENT_PLUGIN_SCHEMA_ID, name, ...extra }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-plugins-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('userPluginsRoot', () => {
  it('honours the environment override', () => {
    const previous = process.env[COPSE_PLUGINS_DIR_ENV]
    process.env[COPSE_PLUGINS_DIR_ENV] = '/tmp/somewhere-else'
    try {
      assert.equal(userPluginsRoot(), '/tmp/somewhere-else')
      // PLUGIN_DATA is a sibling of the payload, so replacing package contents
      // on update cannot take a plugin's state with it.
      assert.equal(userPluginDataDir('acme'), '/tmp/somewhere-else/.data/acme')
    } finally {
      // Assigning '' rather than deleting: the override treats blank as unset,
      // and a computed `delete` is banned by lint.
      process.env[COPSE_PLUGINS_DIR_ENV] = previous ?? ''
    }
  })
})

describe('discoverUserPlugins', () => {
  it('is inert when the root does not exist', async () => {
    const result = await discoverUserPlugins(join(root, 'no-such-directory'))
    assert.deepEqual(result.plugins, [])
    assert.deepEqual(result.failures, [])
  })

  it('discovers a plugin and locates its fixed component locations', async () => {
    await writePlugin('alpha', manifest('alpha'), {
      skills: true,
      mcp: '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{}}',
    })
    const { plugins } = await discoverUserPlugins(root)
    const alpha = plugins.find((plugin) => plugin.manifest.name === 'alpha')
    assert.ok(alpha)
    assert.ok(alpha.skillsDir?.endsWith('skills'))
    assert.ok(alpha.mcpConfigPath?.endsWith('mcp.json'))
    assert.equal(alpha.manifest.trust, 'user')
  })

  it('treats a missing component location as absent, not an error (§6.2)', async () => {
    await writePlugin('bare', manifest('bare'))
    const { plugins, failures } = await discoverUserPlugins(root)
    const bare = plugins.find((plugin) => plugin.manifest.name === 'bare')
    assert.ok(bare)
    assert.equal(bare.skillsDir, undefined)
    assert.equal(bare.mcpConfigPath, undefined)
    assert.equal(
      failures.some((failure) => failure.pluginRoot.endsWith('bare')),
      false,
    )
  })

  it('invalidates a component present as the wrong filesystem kind, keeping the plugin', async () => {
    const pluginRoot = await writePlugin('wrong-kind', manifest('wrong-kind'))
    // `skills` as a file, not a directory.
    await fsp.writeFile(join(pluginRoot, 'skills'), 'not a directory')
    const { plugins } = await discoverUserPlugins(root)
    const found = plugins.find((plugin) => plugin.manifest.name === 'wrong-kind')
    assert.ok(found)
    assert.equal(found.skillsDir, undefined)
    assert.ok(found.warnings.some((warning) => warning.includes('skills')))
  })

  it('isolates a malformed neighbour so the rest still load', async () => {
    await writePlugin('good-one', manifest('good-one'))
    await writePlugin('bad-json', '{ not json')
    await writePlugin('bad-name', manifest('Not A Valid Name'))
    await writePlugin(
      'bad-extension',
      manifest('bad-extension', {
        extensions: { [COPSE_EXTENSION_NAMESPACE]: { stability: 'nope' } },
      }),
    )

    const { plugins, failures } = await discoverUserPlugins(root)
    assert.ok(plugins.some((plugin) => plugin.manifest.name === 'good-one'))
    for (const dir of ['bad-json', 'bad-name', 'bad-extension']) {
      assert.ok(
        failures.some((failure) => failure.pluginRoot.endsWith(dir)),
        `expected a recorded failure for ${dir}`,
      )
    }
    // The Copse-extension failure names its own boundary — the file is still a
    // valid Agent Plugin, we simply decline it.
    const extensionFailure = failures.find((failure) =>
      failure.pluginRoot.endsWith('bad-extension'),
    )
    assert.ok(extensionFailure?.reason.startsWith('Copse extension'))
  })

  it('validates mcp.json without spawning, skipping only the bad entries', async () => {
    await writePlugin('with-mcp', manifest('with-mcp'), {
      mcp: JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          good: { type: 'stdio', command: './bin/server' },
          escaping: { type: 'stdio', command: '../bin/server' },
        },
      }),
    })
    const { plugins } = await discoverUserPlugins(root)
    const found = plugins.find((plugin) => plugin.manifest.name === 'with-mcp')
    assert.ok(found)
    assert.deepEqual([...found.mcpServers.keys()], ['good'])
    assert.ok(found.warnings.some((warning) => warning.includes('escaping')))
  })

  it('disables MCP for a plugin whose mcp.json is unreadable, keeping the plugin', async () => {
    await writePlugin('bad-mcp', manifest('bad-mcp'), { mcp: '{ not json' })
    const { plugins, failures } = await discoverUserPlugins(root)
    const found = plugins.find((plugin) => plugin.manifest.name === 'bad-mcp')
    assert.ok(found, 'the plugin itself must still load')
    assert.equal(found.mcpServers.size, 0)
    assert.ok(found.warnings.some((warning) => warning.startsWith('Disabling MCP')))
    assert.equal(
      failures.some((failure) => failure.pluginRoot.endsWith('bad-mcp')),
      false,
    )
  })

  it('refuses the later of two directories claiming one id', async () => {
    await writePlugin('dup-a', manifest('duplicate.id'))
    await writePlugin('dup-b', manifest('duplicate.id'))
    const { plugins, failures } = await discoverUserPlugins(root)
    assert.equal(plugins.filter((plugin) => plugin.manifest.name === 'duplicate.id').length, 1)
    assert.ok(failures.some((failure) => failure.reason.includes('Duplicate plugin id')))
  })

  it('skips a directory with no manifest without recording it as a plugin', async () => {
    await fsp.mkdir(join(root, 'empty-dir'), { recursive: true })
    const { plugins, failures } = await discoverUserPlugins(root)
    assert.equal(
      plugins.some((plugin) => plugin.pluginRoot.endsWith('empty-dir')),
      false,
    )
    assert.ok(failures.some((failure) => failure.pluginRoot.endsWith('empty-dir')))
  })
})

describe('registeredUserPlugin', () => {
  it('registers with a user trust class and no executable contributions', async () => {
    await writePlugin(
      'contributes',
      manifest('contributes', {
        extensions: {
          [COPSE_EXTENSION_NAMESPACE]: {
            hooks: [{ event: 'turn-start', command: './dev.copse/start.sh' }],
            prompt: [{ id: 'steer', text: 'hi', trust: 'trusted' }],
          },
        },
      }),
    )
    const { plugins } = await discoverUserPlugins(root)
    const candidate = plugins.find((plugin) => plugin.manifest.name === 'contributes')
    assert.ok(candidate)

    const registered = registeredUserPlugin(candidate)
    assert.equal(registered.id, 'contributes')
    assert.equal(registered.trust, 'user')
    // Discovery gives the plugin a row and a lifecycle — never live behavior.
    assert.deepEqual(registered.contributions.toolNames, [])
    assert.deepEqual(registered.contributions.blockingHooks, [])
    assert.deepEqual(registered.contributions.promptBlocks, [])
    // The declaration survives on the manifest, forced untrusted.
    assert.equal(registered.manifest.prompt?.[0]?.trust, 'untrusted')
  })
})
