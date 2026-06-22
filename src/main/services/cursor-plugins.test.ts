import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverCursorPluginRoots,
  resolvePluginSkillsDir,
  resolvePluginMcpConfigPath,
  listCursorPlugins,
  isCursorPluginMcpSource,
  cursorPluginsRoot,
} from './cursor-plugins.ts'

describe('cursor-plugins', () => {
  let tempRoot = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-cursor-plugins-'))
    originalHome = process.env.HOME
    process.env.HOME = tempRoot
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    await rm(tempRoot, { recursive: true, force: true })
  })

  async function writePlugin(
    relativeRoot: string,
    manifest: Record<string, unknown>,
    opts?: { skills?: boolean; mcp?: Record<string, unknown> },
  ): Promise<string> {
    const pluginRoot = join(cursorPluginsRoot(), 'local', relativeRoot)
    await mkdir(join(pluginRoot, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify(manifest),
      'utf-8',
    )
    if (opts?.skills !== false) {
      await mkdir(join(pluginRoot, 'skills', 'demo-skill'), { recursive: true })
      await writeFile(
        join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo\n---\n',
        'utf-8',
      )
    }
    if (opts?.mcp) {
      await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify(opts.mcp), 'utf-8')
    }
    return pluginRoot
  }

  it('discovers plugin roots under ~/.cursor/plugins/local and cache', async () => {
    const localRoot = await writePlugin('my-plugin', { name: 'my-plugin', skills: 'skills' })
    const cacheRoot = join(cursorPluginsRoot(), 'cache', 'market', 'id', 'sha')
    await mkdir(join(cacheRoot, '.cursor-plugin'), { recursive: true })
    await writeFile(
      join(cacheRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cached-plugin' }),
      'utf-8',
    )

    const roots = await discoverCursorPluginRoots()
    assert.deepEqual(roots.sort(), [cacheRoot, localRoot].sort())
  })

  it('resolves skills and MCP paths from plugin.json', async () => {
    const pluginRoot = await writePlugin(
      'hf-skills',
      { name: 'hf-skills', skills: 'skills', mcpServers: '.mcp.json' },
      {
        mcp: {
          mcpServers: {
            hf: { url: 'https://example.test/mcp' },
          },
        },
      },
    )

    assert.equal(await resolvePluginSkillsDir(pluginRoot), join(pluginRoot, 'skills'))
    assert.equal(await resolvePluginMcpConfigPath(pluginRoot), join(pluginRoot, '.mcp.json'))
  })

  it('defaults skills dir to ./skills/ when manifest omits skills', async () => {
    const pluginRoot = await writePlugin('minimal', { name: 'minimal' })
    assert.equal(await resolvePluginSkillsDir(pluginRoot), join(pluginRoot, 'skills'))
    assert.equal(await resolvePluginMcpConfigPath(pluginRoot), null)
  })

  it('lists plugin summaries with capabilities', async () => {
    await writePlugin(
      'with-mcp',
      { name: 'with-mcp', description: 'Has MCP', version: '1.0.0', mcpServers: '.mcp.json' },
      { mcp: { mcpServers: { s: { command: 'node' } } } },
    )
    await writePlugin('skills-only', { name: 'skills-only' })

    const plugins = await listCursorPlugins()
    assert.equal(plugins.length, 2)
    const withMcp = plugins.find((p) => p.name === 'with-mcp')
    assert.ok(withMcp?.skillsDir)
    assert.ok(withMcp?.mcpConfigPath)
    assert.equal(withMcp?.description, 'Has MCP')
    assert.equal(withMcp?.version, '1.0.0')
  })

  it('detects plugin MCP config paths for env interpolation trust', () => {
    const pluginMcp = join(cursorPluginsRoot(), 'cache', 'slug', 'id', 'sha', '.mcp.json')
    assert.equal(isCursorPluginMcpSource(pluginMcp), true)
    assert.equal(isCursorPluginMcpSource('/tmp/.mcp.json'), false)
  })
})
