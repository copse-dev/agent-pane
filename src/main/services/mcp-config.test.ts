import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMcpConfig,
  mergeMcpConfigs,
  interpolateEnv,
  interpolateServerConfig,
  mcpToolName,
  parseMcpToolName,
  isMcpServerEffectivelyDisabled,
} from './mcp-config.ts'

describe('parseMcpConfig', () => {
  it('parses a standard mcpServers stdio entry', () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { A: '1' } },
        },
      }),
    )
    assert.equal(errors.length, 0)
    assert.equal(servers.length, 1)
    const s = servers[0]!
    assert.equal(s.name, 'fs')
    assert.equal(s.transport, 'stdio')
    assert.equal(s.command, 'npx')
    assert.deepEqual(s.args, ['-y', 'server-filesystem', '/tmp'])
    assert.deepEqual(s.env, { A: '1' })
  })

  it('parses an http entry via url', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } },
        },
      }),
    )
    assert.equal(servers[0]!.transport, 'http')
    assert.equal(servers[0]!.url, 'https://x.test/mcp')
    assert.deepEqual(servers[0]!.headers, { Authorization: 'Bearer t' })
  })

  it('honors explicit type=http even with a command-less entry', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({ mcpServers: { r: { type: 'http', url: 'https://x.test/mcp' } } }),
    )
    assert.equal(servers[0]!.transport, 'http')
  })

  it('reads the legacy { servers: [...] } shape', () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({ servers: [{ name: 'old', command: 'node', args: ['s.js'] }] }),
    )
    assert.equal(errors.length, 0)
    assert.equal(servers[0]!.name, 'old')
    assert.equal(servers[0]!.transport, 'stdio')
  })

  it('captures the disabled flag', () => {
    const { servers } = parseMcpConfig(
      JSON.stringify({ mcpServers: { s: { command: 'x', disabled: true } } }),
    )
    assert.equal(servers[0]!.disabled, true)
  })

  it('ignores an unknown "trusted" flag (no blanket auto-run)', () => {
    const { servers, errors } = parseMcpConfig(
      JSON.stringify({ mcpServers: { s: { command: 'x', trusted: true } } }),
    )
    assert.equal(errors.length, 0)
    assert.equal(servers.length, 1)
    assert.equal('trusted' in servers[0]!, false)
  })

  it('reports an error for entries with neither command nor url', () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({ mcpServers: { bad: {} } }))
    assert.equal(servers.length, 0)
    assert.equal(errors.length, 1)
  })

  it('reports invalid JSON', () => {
    const { servers, errors } = parseMcpConfig('{ not json', 'x.json')
    assert.equal(servers.length, 0)
    assert.match(errors[0]!, /Invalid JSON/)
  })

  it('flags a config with no mcpServers or servers', () => {
    const { errors } = parseMcpConfig(JSON.stringify({ somethingElse: true }))
    assert.equal(errors.length, 1)
  })
})

describe('mergeMcpConfigs', () => {
  it('lets earlier sources win on duplicate names', () => {
    const project = [{ name: 'dup', transport: 'stdio' as const, command: 'project' }]
    const global = [
      { name: 'dup', transport: 'stdio' as const, command: 'global' },
      { name: 'only-global', transport: 'stdio' as const, command: 'g' },
    ]
    const merged = mergeMcpConfigs([project, global])
    assert.equal(merged.length, 2)
    assert.equal(merged.find((m) => m.name === 'dup')!.command, 'project')
  })
})

describe('interpolateEnv', () => {
  const env = { TOKEN: 'secret', EMPTY: '' }
  it('expands ${env:VAR} (Cursor style)', () => {
    assert.equal(interpolateEnv('Bearer ${env:TOKEN}', env), 'Bearer secret')
  })
  it('expands ${VAR} (Claude Desktop style)', () => {
    assert.equal(interpolateEnv('Bearer ${TOKEN}', env), 'Bearer secret')
  })
  it('expands unknown references to empty string', () => {
    assert.equal(interpolateEnv('x${env:MISSING}y', env), 'xy')
  })
})

describe('interpolateServerConfig', () => {
  it('resolves env in env map, headers, args, and url', () => {
    const cfg = {
      name: 's',
      transport: 'http' as const,
      url: 'https://x.test/${env:PATHSEG}',
      headers: { Authorization: 'Bearer ${env:TOKEN}' },
      args: ['--key=${TOKEN}'],
      env: { K: '${env:TOKEN}' },
    }
    const out = interpolateServerConfig(cfg, { TOKEN: 'abc', PATHSEG: 'mcp' })
    assert.equal(out.url, 'https://x.test/mcp')
    assert.deepEqual(out.headers, { Authorization: 'Bearer abc' })
    assert.deepEqual(out.args, ['--key=abc'])
    assert.deepEqual(out.env, { K: 'abc' })
  })
})

describe('isMcpServerEffectivelyDisabled', () => {
  it('respects config disabled flag', () => {
    const userOff = new Set<string>()
    assert.equal(isMcpServerEffectivelyDisabled({ name: 'a', disabled: true }, userOff), true)
  })
  it('respects app-local user disabled set', () => {
    assert.equal(
      isMcpServerEffectivelyDisabled({ name: 'a', disabled: false }, new Set(['a'])),
      true,
    )
  })
  it('is enabled when neither flag applies', () => {
    assert.equal(
      isMcpServerEffectivelyDisabled({ name: 'a', disabled: false }, new Set(['b'])),
      false,
    )
  })
})

describe('mcp tool name helpers', () => {
  it('round-trips server and tool names', () => {
    const full = mcpToolName('github', 'create_issue')
    assert.equal(full, 'mcp__github__create_issue')
    assert.deepEqual(parseMcpToolName(full), { server: 'github', tool: 'create_issue' })
  })
  it('handles tool names containing double underscores', () => {
    const full = mcpToolName('srv', 'a__b')
    assert.deepEqual(parseMcpToolName(full), { server: 'srv', tool: 'a__b' })
  })
  it('returns null for non-mcp names', () => {
    assert.equal(parseMcpToolName('read_file'), null)
  })
})
