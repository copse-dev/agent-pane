import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AgentPluginMcpError,
  expandPluginPlaceholders,
  isLoopbackUrlHost,
  parseAgentPluginMcp,
  resolveStdioServer,
} from './agent-plugin-mcp.ts'

const VARS = { pluginRoot: '/plugins/acme', pluginData: '/plugins/.data/acme' }

function mcp(servers: Record<string, unknown>): Record<string, unknown> {
  return { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID, mcpServers: servers }
}

describe('expandPluginPlaceholders', () => {
  it('expands both recognized placeholders', () => {
    assert.equal(
      expandPluginPlaceholders('${PLUGIN_ROOT}/bin:${PLUGIN_DATA}/cache', VARS),
      '/plugins/acme/bin:/plugins/.data/acme/cache',
    )
  })

  it('leaves unrecognized placeholder-like text literal', () => {
    assert.equal(expandPluginPlaceholders('${HOME}/${PATH}', VARS), '${HOME}/${PATH}')
  })

  it('does not rescan text introduced by a replacement', () => {
    // A root that itself contains a placeholder must not expand a second time.
    const vars = { pluginRoot: '${PLUGIN_DATA}', pluginData: '/data' }
    assert.equal(expandPluginPlaceholders('${PLUGIN_ROOT}', vars), '${PLUGIN_DATA}')
  })
})

describe('isLoopbackUrlHost', () => {
  it('accepts localhost and loopback literals', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
      assert.equal(isLoopbackUrlHost(host), true, host)
    }
  })

  it('rejects non-loopback hosts and lookalikes', () => {
    for (const host of ['example.com', '128.0.0.1', 'localhost.evil.com', '10.0.0.1', '999.0.0.1']) {
      assert.equal(isLoopbackUrlHost(host), false, host)
    }
  })
})

describe('parseAgentPluginMcp — file level', () => {
  it('accepts an empty server map', () => {
    const { servers, warnings } = parseAgentPluginMcp(mcp({}))
    assert.equal(servers.size, 0)
    assert.deepEqual(warnings, [])
  })

  it('throws on an unsupported $schema or an extra top-level field', () => {
    assert.throws(
      () => parseAgentPluginMcp({ $schema: 'https://example.com/mcp.json', mcpServers: {} }),
      AgentPluginMcpError,
    )
    assert.throws(() => parseAgentPluginMcp({ ...mcp({}), extra: true }), AgentPluginMcpError)
  })
})

describe('parseAgentPluginMcp — stdio (§7.2.1)', () => {
  it('accepts a bare command and a plugin-relative command', () => {
    const { servers } = parseAgentPluginMcp(
      mcp({
        bare: { type: 'stdio', command: 'npx' },
        bundled: { type: 'stdio', command: './bin/validator' },
      }),
    )
    assert.equal(servers.size, 2)
  })

  it('skips a command that escapes the plugin root or expands a placeholder', () => {
    const { servers, warnings } = parseAgentPluginMcp(
      mcp({
        escaping: { type: 'stdio', command: '../bin/server' },
        interpolated: { type: 'stdio', command: '${PLUGIN_ROOT}/bin/server' },
      }),
    )
    assert.equal(servers.size, 0)
    assert.equal(warnings.length, 2)
  })

  it('skips an entry whose env sets a reserved variable', () => {
    const { servers, warnings } = parseAgentPluginMcp(
      mcp({ sneaky: { type: 'stdio', command: 'npx', env: { PLUGIN_ROOT: '/elsewhere' } } }),
    )
    assert.equal(servers.size, 0)
    assert.ok(warnings[0]?.includes('PLUGIN_ROOT'))
  })

  it('accepts the three legal cwd forms and rejects everything else', () => {
    const { servers } = parseAgentPluginMcp(
      mcp({
        a: { type: 'stdio', command: 'x', cwd: './data' },
        b: { type: 'stdio', command: 'x', cwd: '${PLUGIN_ROOT}' },
        c: { type: 'stdio', command: 'x', cwd: '${PLUGIN_DATA}/state' },
      }),
    )
    assert.equal(servers.size, 3)

    const { servers: rejected } = parseAgentPluginMcp(
      mcp({
        bare: { type: 'stdio', command: 'x', cwd: 'data' },
        climbing: { type: 'stdio', command: 'x', cwd: './a/../../b' },
        escaping: { type: 'stdio', command: 'x', cwd: '${PLUGIN_DATA}/../elsewhere' },
      }),
    )
    assert.equal(rejected.size, 0)
  })

  it('skips one bad entry without affecting its neighbours (§7.2.2 rule 3)', () => {
    const { servers, warnings } = parseAgentPluginMcp(
      mcp({
        good: { type: 'stdio', command: 'npx' },
        unknownField: { type: 'stdio', command: 'npx', shell: true },
        unknownType: { type: 'websocket', url: 'wss://example.com' },
      }),
    )
    assert.deepEqual([...servers.keys()], ['good'])
    assert.equal(warnings.length, 2)
  })
})

describe('parseAgentPluginMcp — remote transports', () => {
  it('accepts HTTPS and loopback HTTP, rejecting non-loopback HTTP', () => {
    const { servers, warnings } = parseAgentPluginMcp(
      mcp({
        remote: { type: 'streamable-http', url: 'https://deploy.example.com/mcp' },
        local: { type: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' },
        insecure: { type: 'streamable-http', url: 'http://deploy.example.com/mcp' },
      }),
    )
    assert.deepEqual([...servers.keys()].sort(), ['local', 'remote'])
    assert.ok(warnings[0]?.includes('loopback'))
  })

  it('rejects user information and fragments in the URL', () => {
    const { servers } = parseAgentPluginMcp(
      mcp({
        creds: { type: 'sse', url: 'https://user:pw@example.com/mcp' },
        fragment: { type: 'sse', url: 'https://example.com/mcp#section' },
      }),
    )
    assert.equal(servers.size, 0)
  })

  it('rejects a header name repeated under different casing', () => {
    const { servers, warnings } = parseAgentPluginMcp(
      mcp({
        dup: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { 'X-Tenant': 'a', 'x-tenant': 'b' },
        },
      }),
    )
    assert.equal(servers.size, 0)
    assert.ok(warnings[0]?.includes('casing'))
  })
})

describe('resolveStdioServer', () => {
  it('expands args, env values, and cwd — but never the command', () => {
    const { servers } = parseAgentPluginMcp(
      mcp({
        s: {
          type: 'stdio',
          command: 'npx',
          args: ['--data', '${PLUGIN_DATA}/validator'],
          env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          cwd: '${PLUGIN_ROOT}',
        },
      }),
    )
    const server = servers.get('s')
    assert.ok(server && server.type === 'stdio')
    const resolved = resolveStdioServer(server, VARS)
    assert.equal(resolved.command, 'npx')
    assert.deepEqual(resolved.args, ['--data', '/plugins/.data/acme/validator'])
    assert.equal(resolved.env['CONFIG'], '/plugins/acme/config.json')
    assert.equal(resolved.cwd, '/plugins/acme')
  })

  it('defaults cwd to the plugin root and always supplies the reserved variables', () => {
    const { servers } = parseAgentPluginMcp(mcp({ s: { type: 'stdio', command: 'npx' } }))
    const server = servers.get('s')
    assert.ok(server && server.type === 'stdio')
    const resolved = resolveStdioServer(server, VARS)
    assert.equal(resolved.cwd, '/plugins/acme')
    assert.equal(resolved.env['PLUGIN_ROOT'], '/plugins/acme')
    assert.equal(resolved.env['PLUGIN_DATA'], '/plugins/.data/acme')
  })

  it('resolves a plugin-relative cwd against the plugin root', () => {
    const { servers } = parseAgentPluginMcp(
      mcp({ s: { type: 'stdio', command: 'npx', cwd: './data' } }),
    )
    const server = servers.get('s')
    assert.ok(server && server.type === 'stdio')
    assert.equal(resolveStdioServer(server, VARS).cwd, '/plugins/acme/data')
  })
})
