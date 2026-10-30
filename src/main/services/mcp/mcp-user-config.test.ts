import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMcpConfig } from './mcp-config.ts'
import {
  listUserMcpServers,
  mcpUserServerInputSchema,
  removeUserMcpServer,
  saveUserMcpServer,
} from './mcp-user-config.ts'

let dir = ''
let path = ''
const noTaken = new Map<string, string>()

async function readJson(): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

describe('Copse user mcp.json editing', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'copse-mcp-user-'))
    path = join(dir, 'mcp.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds a stdio server the registry parser reads back, in a private file', async () => {
    const result = await saveUserMcpServer(
      {
        transport: 'stdio',
        name: 'docs',
        command: ' npx ',
        args: ['-y', '', 'docs-server'],
        env: [{ key: 'API_KEY', value: 'secret-1' }],
      },
      { takenNames: noTaken, path },
    )
    assert.equal(result.ok, true)
    const parsed = parseMcpConfig(await readFile(path, 'utf-8'), path)
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.servers, [
      {
        name: 'docs',
        transport: 'stdio',
        disabled: false,
        source: path,
        command: 'npx',
        args: ['-y', 'docs-server'],
        env: { API_KEY: 'secret-1' },
      },
    ])
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
  })

  it('lists env and header keys without their values', async () => {
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['s.js'], env: { TOKEN: 'abc' } },
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        },
      }),
    )
    const list = await listUserMcpServers(path)
    assert.deepEqual(list.servers, [
      {
        transport: 'stdio',
        name: 'local',
        command: 'node',
        args: ['s.js'],
        env: [{ key: 'TOKEN' }],
      },
      {
        transport: 'http',
        name: 'remote',
        url: 'https://example.com/mcp',
        headers: [{ key: 'Authorization' }],
      },
    ])
    assert.doesNotMatch(JSON.stringify(list), /abc|Bearer/)
  })

  it('keeps a stored secret when an edit omits its value, and renames in place', async () => {
    await writeFile(
      path,
      JSON.stringify({
        keep: 'me',
        mcpServers: {
          first: { command: 'a' },
          old: { command: 'node', env: { TOKEN: 'abc', DROP: 'x' }, disabled: true },
          last: { command: 'z' },
        },
      }),
    )
    const result = await saveUserMcpServer(
      {
        transport: 'stdio',
        name: 'renamed',
        command: 'node',
        args: [],
        env: [{ key: 'TOKEN' }, { key: 'NEW', value: '1' }],
      },
      { previousName: 'old', takenNames: noTaken, path },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(await readJson(), {
      keep: 'me',
      mcpServers: {
        first: { command: 'a' },
        renamed: { disabled: true, command: 'node', args: [], env: { TOKEN: 'abc', NEW: '1' } },
        last: { command: 'z' },
      },
    })
  })

  it('drops stored header values when the URL changes', async () => {
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: { r: { url: 'https://a.example/mcp', headers: { Authorization: 'Bearer x' } } },
      }),
    )
    const result = await saveUserMcpServer(
      {
        transport: 'http',
        name: 'r',
        url: 'https://b.example/mcp',
        headers: [{ key: 'Authorization' }],
      },
      { previousName: 'r', takenNames: noTaken, path },
    )
    assert.deepEqual(result, {
      ok: false,
      field: 'headers',
      message: 'Enter a value for Authorization.',
    })
  })

  it('rejects bad names, taken names, bad URLs and missing commands without writing', async () => {
    const cases = [
      [{ transport: 'stdio', name: 'a__b', command: 'x', args: [], env: [] }, 'name'],
      [{ transport: 'stdio', name: 'bad name', command: 'x', args: [], env: [] }, 'name'],
      [{ transport: 'stdio', name: 'mdn', command: 'x', args: [], env: [] }, 'name'],
      [{ transport: 'stdio', name: 'ok', command: '  ', args: [], env: [] }, 'command'],
      [{ transport: 'http', name: 'ok', url: 'file:///etc/passwd', headers: [] }, 'url'],
      [
        {
          transport: 'stdio',
          name: 'ok',
          command: 'x',
          args: [],
          env: [{ key: '1X', value: 'v' }],
        },
        'env',
      ],
      [
        { transport: 'http', name: 'ok', url: 'https://x.example', headers: [{ key: 'A' }] },
        'headers',
      ],
    ] as const
    for (const [raw, field] of cases) {
      const input = mcpUserServerInputSchema.parse(raw)
      const result = await saveUserMcpServer(input, {
        takenNames: new Map([['mdn', 'a Copse reviewed server']]),
        path,
      })
      assert.equal(result.ok ? 'saved' : result.field, field, JSON.stringify(raw))
    }
    await assert.rejects(readFile(path, 'utf-8'), { code: 'ENOENT' })
  })

  it('refuses to rewrite a file it cannot parse or a legacy servers list', async () => {
    for (const text of ['{ not json', JSON.stringify({ servers: [{ name: 'x', command: 'y' }] })]) {
      await writeFile(path, text)
      const result = await saveUserMcpServer(
        { transport: 'stdio', name: 'n', command: 'c', args: [], env: [] },
        { takenNames: noTaken, path },
      )
      assert.equal(result.ok, false)
      assert.equal(await readFile(path, 'utf-8'), text)
      assert.ok((await listUserMcpServers(path)).error)
    }
  })

  it('removes one server and leaves the rest', async () => {
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }),
    )
    const result = await removeUserMcpServer('a', path)
    assert.equal(result.ok, true)
    assert.deepEqual(await readJson(), { mcpServers: { b: { command: 'b' } } })
  })

  it('serializes concurrent adds so neither is lost', async () => {
    await Promise.all(
      ['one', 'two', 'three'].map((name) =>
        saveUserMcpServer(
          { transport: 'stdio', name, command: 'c', args: [], env: [] },
          { takenNames: noTaken, path },
        ),
      ),
    )
    const list = await listUserMcpServers(path)
    assert.deepEqual(list.servers.map((s) => s.name).sort(), ['one', 'three', 'two'])
  })
})
