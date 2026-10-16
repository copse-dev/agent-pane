import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { API_PROTOCOL_VERSION } from '../../src/shared/api-protocol.mts'
import { isRecord } from '../../src/shared/unknown-value.mts'
import {
  API_PROTOCOL_MANIFEST_PATH,
  analyzePreloadSource,
  compareApiProtocol,
  generateApiProtocol,
  linkRefNodeModules,
  manifestOf,
  parseApiProtocol,
  parseApiProtocolManifest,
  protocolVersionProblem,
  serializeApiProtocol,
  serializeApiProtocolManifest,
  type ApiProtocolDiff,
  type ApiProtocolDocument,
  type JsonSchema,
} from './api-protocol.mts'

/**
 * Invariants for the renderer ↔ main API protocol (issue #2312, step 1).
 *
 * The committed `schemas/api-protocol.manifest.json` is the frozen surface.
 * These tests make it change only deliberately: the manifest must equal what
 * the sources generate, every facade method must be bound to a channel that
 * follows the naming convention, and every channel must have a real
 * main-process endpoint. The invariants run over the freshly generated document, which
 * carries the types the manifest leaves out.
 */
const ROOT = resolve('.')
const generated = generateApiProtocol({ version: API_PROTOCOL_VERSION })
const committed = generated
const manifestOnDisk = readFileSync(resolve(ROOT, API_PROTOCOL_MANIFEST_PATH), 'utf8')

/** `suggestFollowUps` → `suggest-follow-ups`. */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Facade namespaces whose channels live under a differently named area, as a
 * whole. Their members still follow the convention for the second half, so a
 * new member needs no new exception — only the area mapping is unusual.
 */
const NAMESPACE_AREAS: Record<string, string> = {
  windowState: 'main-window',
}

/**
 * The channel a facade member is expected to bind: `namespace:method`, or for
 * a subscription `namespace:event` with the handler's `on` prefix dropped,
 * both halves kebab-cased.
 */
function conventionalChannel(ns: string, method: string, kind: string): string {
  const name = kind === 'subscribe' && /^on[A-Z]/.test(method) ? method.slice(2) : method
  return `${NAMESPACE_AREAS[ns] ?? kebab(ns)}:${kebab(name)}`
}

/**
 * Individual bindings under a different area than their facade namespace,
 * where the rest of that namespace is conventional. Unlike NAMESPACE_AREAS
 * these are per-member, so each is a candidate for a later move and the list
 * may only shrink.
 */
const CHANNEL_NAME_EXCEPTIONS: Record<string, string> = {
  'browser.onPluginTabRequest': 'plugins:browser-tab-request',
  'closeConfirm.onRequest': 'app:close-confirm-request',
  'diff.onShowDiff': 'agent:show-diff',
  'panes.onSwitchMode': 'popout:switch-mode',
  'sshPrompt.onRequest': 'ssh:prompt-request',
  'sshWorkspace.onConnectionChanged': 'ssh:connection-changed',
  'updatePrompt.onDevNotice': 'update:dev-notice',
  'updatePrompt.onRequest': 'update:prompt-request',
  'workspace.createNewProject': 'workspace:create-project',
  'workspace.unsandboxedProjectHooks': 'hooks:unsandboxed-project-hooks',
}

function mainProcessSources(): string {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        chunks.push(readFileSync(path, 'utf8'))
      }
    }
  }
  walk(resolve(ROOT, 'src/main'))
  return chunks.join('\n')
}

describe('API protocol manifest (schemas/api-protocol.manifest.json)', () => {
  it('matches what the sources generate (no drift)', () => {
    // Regenerate with `pnpm run gen:api-protocol` after changing ApiClient or
    // the preload, and read the diff: a removed or renamed channel is a
    // breaking change and needs API_PROTOCOL_VERSION bumped
    // (docs/api-protocol.md). Shape changes to a channel's types do not show
    // here; `gen-api-protocol --compare-ref` classifies those.
    assert.equal(
      manifestOnDisk,
      serializeApiProtocolManifest(manifestOf(generated)),
      `${API_PROTOCOL_MANIFEST_PATH} is stale — run \`pnpm run gen:api-protocol\` and commit`,
    )
  })

  it('is stamped with the protocol version the runtime exchanges', () => {
    assert.equal(parseApiProtocolManifest(manifestOnDisk).version, API_PROTOCOL_VERSION)
    assert.equal(committed.version, API_PROTOCOL_VERSION)
    assert.equal(committed.$schema, 'https://json-schema.org/draft/2020-12/schema')
  })

  it('carries every channel with its binding member and arity', () => {
    const manifest = manifestOf(committed)
    for (const kind of ['invoke', 'send', 'event'] as const) {
      assert.deepEqual(
        Object.keys(manifest.channels[kind]),
        Object.keys(committed.channels[kind]),
        `${kind} channels differ between the manifest and the schema`,
      )
      for (const [channel, entry] of Object.entries(manifest.channels[kind])) {
        const full = committed.channels[kind][channel]
        assert.equal(entry.api, full?.['x-api'])
        assert.equal(entry.args[0], full?.args['minItems'])
        assert.equal(entry.args[1], full?.args['maxItems'] ?? null)
      }
    }
    assert.deepEqual(
      parseApiProtocolManifest(serializeApiProtocolManifest(manifest)),
      manifest,
      'manifest does not round-trip',
    )
    assert.throws(() => parseApiProtocolManifest('{"version":2}'), /not an API protocol manifest/)
  })

  it('binds every ApiClient method to exactly one namespaced channel', () => {
    const seen = new Map<string, string>()
    for (const [ns, methods] of Object.entries(committed.client)) {
      for (const [name, method] of Object.entries(methods)) {
        const api = `${ns}.${name}`
        assert.ok(method.channel, `${api} is not bound to an IPC channel in the preload`)
        assert.match(
          method.channel,
          /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/,
          `${api} channel "${method.channel}" is not kebab-case "<area>:<name>"`,
        )
        // Subscriptions may share an event channel only if they are the same
        // member; two invoke methods on one channel would be an ambiguity the
        // main process cannot resolve.
        const owner = seen.get(`${method.kind}:${method.channel}`)
        assert.ok(
          owner === undefined || method.kind === 'subscribe',
          `${api} and ${owner ?? ''} both invoke ${method.channel}`,
        )
        seen.set(`${method.kind}:${method.channel}`, api)
        assert.ok(
          !method['x-args-transformed'],
          `${api} reshapes its arguments in the preload; the wire schema cannot be derived`,
        )
      }
    }
  })

  it('names every channel after its ApiClient member', () => {
    // The convention: `namespace:method` for invokes and sends, and
    // `namespace:event` (the handler name without its `on` prefix) for
    // subscriptions, kebab-cased. A channel is then derivable from `ApiClient` alone, which
    // is what lets the preload become generated rather than hand-written.
    // The exceptions below are the bindings that still live under a different
    // area than their facade namespace; each is a candidate for a later move,
    // and the list may only shrink.
    for (const [ns, methods] of Object.entries(committed.client)) {
      for (const [name, method] of Object.entries(methods)) {
        const api = `${ns}.${name}`
        if (!method.channel) continue
        const exception = CHANNEL_NAME_EXCEPTIONS[api]
        if (exception !== undefined) {
          assert.equal(method.channel, exception, `${api} exception is stale`)
          continue
        }
        assert.equal(
          method.channel,
          conventionalChannel(ns, name, method.kind),
          `${api} is bound to "${method.channel}" instead of the conventional channel name`,
        )
      }
    }
    for (const api of Object.keys(CHANNEL_NAME_EXCEPTIONS)) {
      const [ns, name] = api.split('.')
      assert.ok(committed.client[ns ?? '']?.[name ?? ''], `exception ${api} no longer exists`)
    }
  })

  it('every invoke and send channel has a literal main-process handler', () => {
    const main = mainProcessSources()
    for (const kind of ['invoke', 'send'] as const) {
      for (const channel of Object.keys(committed.channels[kind])) {
        assert.ok(
          main.includes(`'${channel}'`),
          `${kind} channel ${channel} has no ipcMain.handle/on literal under src/main`,
        )
      }
    }
  })

  it('every event channel is emitted somewhere in the main process', () => {
    const main = mainProcessSources()
    for (const channel of Object.keys(committed.channels.event)) {
      assert.ok(main.includes(`'${channel}'`), `event channel ${channel} is never sent by src/main`)
    }
  })

  it('channels and client entries agree with each other', () => {
    const fromClient = {
      invoke: new Set<string>(),
      send: new Set<string>(),
      event: new Set<string>(),
    }
    for (const methods of Object.values(committed.client)) {
      for (const method of Object.values(methods)) {
        if (!method.channel) continue
        if (method.kind === 'subscribe') fromClient.event.add(method.channel)
        else if (method.kind === 'send') fromClient.send.add(method.channel)
        else fromClient.invoke.add(method.channel)
      }
    }
    for (const kind of ['invoke', 'send', 'event'] as const) {
      assert.deepEqual([...fromClient[kind]].sort(), Object.keys(committed.channels[kind]).sort())
      for (const [channel, entry] of Object.entries(committed.channels[kind])) {
        const [ns, name] = entry['x-api'].split('.')
        assert.equal(committed.client[ns ?? '']?.[name ?? '']?.channel, channel)
      }
    }
  })

  it('publishes every referenced named type', () => {
    const refs = new Set<string>()
    JSON.stringify(committed, (_key, value: unknown) => {
      if (typeof value === 'string' && value.startsWith('#/$defs/')) {
        refs.add(value.slice('#/$defs/'.length))
      }
      return value
    })
    for (const name of refs) assert.ok(name in committed.$defs, `dangling $ref to ${name}`)
    const text = JSON.stringify(committed)
    assert.ok(!text.includes('"x-pending"'), 'a def was left half-expanded')
    assert.ok(!text.includes('"x-truncated"'), 'a type exceeded the expansion depth')
  })
})

describe('analyzePreloadSource', () => {
  const source = (body: string): string =>
    `const api: ApiClient = {\n${body}\n}\ncontextBridge.exposeInMainWorld('api', api)\n`

  it('reads invoke, send, and on bindings and whether arguments pass through', () => {
    const api = analyzePreloadSource(
      source(`
  fs: {
    readFile: (projectId: string, path: string) => ipcRenderer.invoke('fs:read-file', projectId, path),
    write(projectId: string, path: string) {
      return ipcRenderer.invoke('fs:write-file', path, projectId)
    },
    ping: (id: string) => ipcRenderer.send('fs:ping', id),
    onChanged: (handler: (path: string, content: string | null) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, path: string, content: string | null): void => {
        handler(path, content)
      }
      ipcRenderer.on('fs:changed', listener)
      return (): void => {
        ipcRenderer.off('fs:changed', listener)
      }
    },
    onReshaped: (handler: (path: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { path: string }): void => {
        handler(payload.path)
      }
      ipcRenderer.on('fs:reshaped', listener)
      return (): void => {
        ipcRenderer.off('fs:reshaped', listener)
      }
    },
  },`),
    )
    assert.deepEqual(api.get('fs.readFile')?.bindings, [
      { op: 'invoke', channel: 'fs:read-file', passThrough: true },
    ])
    // Arguments reordered: the wire tuple is not the facade's parameter list.
    assert.deepEqual(api.get('fs.write')?.bindings, [
      { op: 'invoke', channel: 'fs:write-file', passThrough: false },
    ])
    assert.deepEqual(api.get('fs.ping')?.bindings, [
      { op: 'send', channel: 'fs:ping', passThrough: true },
    ])
    assert.equal(api.get('fs.onChanged')?.listenerPassThrough, true)
    assert.deepEqual(api.get('fs.onChanged')?.bindings, [
      { op: 'on', channel: 'fs:changed', passThrough: true },
    ])
    assert.equal(api.get('fs.onReshaped')?.listenerPassThrough, false)
  })

  it('also reads the object when it is passed inline', () => {
    const api = analyzePreloadSource(
      `contextBridge.exposeInMainWorld('api', {\n  a: { b: (c: string) => ipcRenderer.invoke('a:b', c) },\n} satisfies ApiClient)`,
    )
    assert.deepEqual(api.get('a.b')?.bindings, [
      { op: 'invoke', channel: 'a:b', passThrough: true },
    ])
  })

  it('refuses a computed channel name', () => {
    assert.throws(
      () => analyzePreloadSource(source(`a: { b: (c: string) => ipcRenderer.invoke(c) }`)),
      /non-literal ipcRenderer\.invoke/,
    )
  })

  it('needs the api object literal to exist', () => {
    assert.throws(() => analyzePreloadSource('const x = 1'), /could not find exposeInMainWorld/)
  })
})

describe('compareApiProtocol', () => {
  const doc = (
    invoke: Record<string, { args: JsonSchema; result?: JsonSchema }>,
    defs: Record<string, JsonSchema> = {},
  ): ApiProtocolDocument => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 't',
    description: 'd',
    version: 1,
    channels: {
      invoke: Object.fromEntries(
        Object.entries(invoke).map(([channel, entry]) => [
          channel,
          { 'x-api': `ns.${channel.split(':')[1] ?? ''}`, ...entry },
        ]),
      ),
      send: {},
      event: {},
    },
    client: Object.fromEntries([
      [
        'ns',
        Object.fromEntries(
          Object.entries(invoke).map(([channel, entry]) => [
            channel.split(':')[1] ?? '',
            {
              kind: 'invoke',
              channel,
              params: entry.args,
              ...(entry.result === undefined ? {} : { result: entry.result }),
            },
          ]),
        ),
      ],
    ]),
    $defs: defs,
  })
  const str: JsonSchema = { type: 'string' }
  // As the generator writes a fixed-length tuple: no `prefixItems` when empty.
  const tuple = (...items: JsonSchema[]): JsonSchema => ({
    type: 'array',
    ...(items.length > 0 ? { prefixItems: items } : {}),
    minItems: items.length,
    maxItems: items.length,
  })

  it('reports removed and retyped entries as breaking, new ones as additive', () => {
    const before = doc({
      'a:get': { args: tuple(str), result: str },
      'a:del': { args: tuple(str) },
    })
    const after = doc({
      'a:get': { args: tuple(str, str), result: str },
      'a:new': { args: tuple() },
    })
    assert.deepEqual(compareApiProtocol(before, after), {
      breaking: [
        'channels.invoke.a:del: removed',
        'channels.invoke.a:get: shape changed (args: items added to data the client sends)',
        'client.ns.del: removed',
        'client.ns.get: shape changed (params: items added to data the client sends)',
      ],
      additive: ['channels.invoke.a:new: added', 'client.ns.new: added'],
    })
  })

  it('compares by shape, so renaming a def is not a change', () => {
    const before = doc(
      { 'a:get': { args: tuple(), result: { $ref: '#/$defs/Old' } } },
      { Old: str },
    )
    const after = doc({ 'a:get': { args: tuple(), result: { $ref: '#/$defs/New' } } }, { New: str })
    assert.deepEqual(compareApiProtocol(before, after), { breaking: [], additive: [] })
    const retyped = doc(
      { 'a:get': { args: tuple(), result: { $ref: '#/$defs/New' } } },
      { New: { type: 'number' } },
    )
    assert.deepEqual(compareApiProtocol(before, retyped).breaking, [
      'channels.invoke.a:get: shape changed (result: type changed)',
      'client.ns.get: shape changed (result: type changed)',
    ])
  })

  it('tolerates recursive defs when inlining', () => {
    const node = { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } }
    const before = doc(
      { 'a:get': { args: tuple(), result: { $ref: '#/$defs/Node' } } },
      { Node: node },
    )
    assert.deepEqual(compareApiProtocol(before, before), { breaking: [], additive: [] })
  })

  it('tells recursive shapes apart by where the cycle returns, not by def name', () => {
    const field = (name: string, def: string): JsonSchema => ({
      type: 'object',
      properties: { [name]: { $ref: `#/$defs/${def}` } },
    })
    const result = (def: string, defs: Record<string, JsonSchema>): ApiProtocolDocument =>
      doc({ 'a:get': { args: tuple(), result: { $ref: `#/$defs/${def}` } } }, defs)
    // b, c, b, c, … against b, c, c, c, …: both inlined to b.c.<cycle> by name.
    const alternating = result('X', { X: field('b', 'Y'), Y: field('c', 'X') })
    const settling = result('P', { P: field('b', 'X'), X: field('c', 'X') })
    assert.equal(compareApiProtocol(alternating, settling).breaking.length, 2)
    const renamed = result('Q', { Q: field('b', 'R'), R: field('c', 'Q') })
    assert.deepEqual(compareApiProtocol(alternating, renamed), { breaking: [], additive: [] })
  })

  describe('compatible widening', () => {
    const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
      type: 'object',
      properties,
      required,
    })
    const widened = (channel: string, method: string): ApiProtocolDiff => ({
      breaking: [],
      additive: [
        `channels.invoke.${channel}: widened compatibly`,
        `client.ns.${method}: widened compatibly`,
      ],
    })
    /** A break found at `at` (named from the channel's side: `args`, `result`). */
    const broken = (channel: string, method: string, at: string, why: string): ApiProtocolDiff => ({
      breaking: [
        `channels.invoke.${channel}: shape changed (${at}: ${why})`,
        `client.ns.${method}: shape changed (${at.replace(/^args/, 'params')}: ${why})`,
      ],
      additive: [],
    })

    it('treats an optional field the host adds to a result as additive, at any depth', () => {
      const row = (extra: Record<string, JsonSchema>): JsonSchema =>
        obj({ a: str, ...extra }, ['a'])
      const result = (
        extra: Record<string, JsonSchema>,
        nested: Record<string, JsonSchema>,
      ): JsonSchema =>
        obj(
          {
            id: str,
            rows: { type: 'array', items: row(nested) },
            byId: { type: 'object', additionalProperties: row(nested) },
            ...extra,
          },
          ['id', 'rows', 'byId'],
        )
      const before = doc({ 'a:get': { args: tuple(), result: result({}, {}) } })
      const after = doc({ 'a:get': { args: tuple(), result: result({ note: str }, { b: str }) } })
      assert.deepEqual(compareApiProtocol(before, after), widened('a:get', 'get'))
    })

    it('keeps required, newly required, and client-sent fields breaking', () => {
      const before = doc({
        'a:set': { args: tuple(obj({ a: str }, ['a'])), result: obj({ a: str }, []) },
      })
      const requiredField = doc({
        'a:set': { args: tuple(obj({ a: str }, ['a'])), result: obj({ a: str, b: str }, ['b']) },
      })
      const nowRequired = doc({
        'a:set': { args: tuple(obj({ a: str }, ['a'])), result: obj({ a: str }, ['a']) },
      })
      const clientSent = doc({
        'a:set': { args: tuple(obj({ a: str, b: str }, ['a'])), result: obj({ a: str }, []) },
      })
      assert.deepEqual(
        compareApiProtocol(before, requiredField),
        broken('a:set', 'set', 'result.b', 'added as required'),
      )
      assert.deepEqual(
        compareApiProtocol(before, nowRequired),
        broken('a:set', 'set', 'result', 'required fields changed'),
      )
      assert.deepEqual(
        compareApiProtocol(before, clientSent),
        broken('a:set', 'set', 'args[0].b', 'added to data the client sends'),
      )
    })

    it('treats a new union member or enum value as breaking, and matches members as a set', () => {
      const member = (kind: string, extra: Record<string, JsonSchema> = {}): JsonSchema =>
        obj({ kind: { const: kind }, ...extra }, ['kind'])
      const union = (...members: JsonSchema[]): JsonSchema => ({ anyOf: members })
      const before = doc({ 'a:get': { args: tuple(), result: union(member('a'), member('b')) } })
      // The widened member now serializes first, as the generator would order it.
      const reordered = doc({
        'a:get': { args: tuple(), result: union(member('b', { aa: str }), member('a')) },
      })
      assert.deepEqual(compareApiProtocol(before, reordered), widened('a:get', 'get'))
      const newMember = doc({
        'a:get': { args: tuple(), result: union(member('a'), member('b'), member('c')) },
      })
      assert.deepEqual(
        compareApiProtocol(before, newMember),
        broken('a:get', 'get', 'result', 'union members added or removed'),
      )
      const enumOf = (...values: string[]): JsonSchema => ({ type: 'string', enum: values })
      assert.deepEqual(
        compareApiProtocol(
          doc({ 'a:get': { args: tuple(), result: enumOf('x', 'y') } }),
          doc({ 'a:get': { args: tuple(), result: enumOf('x', 'y', 'z') } }),
        ),
        broken('a:get', 'get', 'result', 'enum changed'),
      )
    })

    it('keeps a member from gaining a field another union member is told apart by', () => {
      // A client narrows `Dir | File` with `'size' in entry`, so an old client
      // would take a Dir that gained `size` for a File.
      const dir = (extra: Record<string, JsonSchema> = {}): JsonSchema =>
        obj({ name: str, ...extra }, ['name'])
      const file = obj({ name: str, size: { type: 'number' } }, ['name', 'size'])
      const listing = (...members: JsonSchema[]): JsonSchema => ({
        type: 'array',
        items: { anyOf: members },
      })
      const before = doc({ 'a:list': { args: tuple(), result: listing(dir(), file) } })
      assert.deepEqual(
        compareApiProtocol(
          before,
          doc({ 'a:list': { args: tuple(), result: listing(dir({ size: str }), file) } }),
        ),
        broken(
          'a:list',
          'list',
          'result[].size',
          'added to a union member that another member has',
        ),
      )
      assert.deepEqual(
        compareApiProtocol(
          before,
          doc({ 'a:list': { args: tuple(), result: listing(dir({ note: str }), file) } }),
        ),
        widened('a:list', 'list'),
      )
    })

    it('treats any argument added to a call as breaking, since hosts check arity', () => {
      const before = doc({ 'a:get': { args: tuple(str), result: str } })
      const optionalTail = doc({
        'a:get': {
          args: { type: 'array', prefixItems: [str, str], minItems: 1, maxItems: 2 },
          result: str,
        },
      })
      assert.deepEqual(
        compareApiProtocol(before, optionalTail),
        broken('a:get', 'get', 'args', 'items added to data the client sends'),
      )
      const requiredTail = doc({ 'a:get': { args: tuple(str, str), result: str } })
      assert.deepEqual(
        compareApiProtocol(before, requiredTail),
        broken('a:get', 'get', 'args', 'items added to data the client sends'),
      )
    })

    it('keeps the qualifiers beside a $ref, so T becoming T | undefined is breaking', () => {
      const defs = { Thread: obj({ id: str }, ['id']) }
      const before = doc({ 'a:get': { args: tuple(), result: { $ref: '#/$defs/Thread' } } }, defs)
      const after = doc(
        { 'a:get': { args: tuple(), result: { $ref: '#/$defs/Thread', 'x-optional': true } } },
        defs,
      )
      assert.deepEqual(
        compareApiProtocol(before, after),
        broken('a:get', 'get', 'result', 'x-optional changed'),
      )
    })

    it('compares parameter names and fields named description or title', () => {
      // A rename cannot be told apart from two same-typed parameters swapping.
      const named = (title: string): JsonSchema => ({
        type: 'array',
        prefixItems: [{ title, ...str }],
        minItems: 1,
        maxItems: 1,
      })
      assert.deepEqual(
        compareApiProtocol(
          doc({ 'a:get': { args: named('id'), result: str } }),
          doc({ 'a:get': { args: named('threadId'), result: str } }),
        ),
        broken('a:get', 'get', 'args[0]', 'title changed'),
      )
      for (const field of ['description', 'title']) {
        assert.deepEqual(
          compareApiProtocol(
            doc({ 'a:get': { args: tuple(), result: obj({ [field]: str }, [field]) } }),
            doc({
              'a:get': { args: tuple(), result: obj({ [field]: { type: 'number' } }, [field]) },
            }),
          ),
          broken('a:get', 'get', `result.${field}`, 'type changed'),
        )
      }
    })

    it('widens an empty result object and an intersection member, but not a record', () => {
      const empty: JsonSchema = { type: 'object' }
      assert.deepEqual(
        compareApiProtocol(
          doc({ 'a:get': { args: tuple(), result: empty } }),
          doc({ 'a:get': { args: tuple(), result: obj({ note: str }, []) } }),
        ),
        widened('a:get', 'get'),
      )
      const both = (extra: Record<string, JsonSchema>): JsonSchema => ({
        allOf: [obj({ id: str }, ['id']), obj({ name: str, ...extra }, ['name'])],
      })
      assert.deepEqual(
        compareApiProtocol(
          doc({ 'a:get': { args: tuple(), result: both({}) } }),
          doc({ 'a:get': { args: tuple(), result: both({ note: str }) } }),
        ),
        widened('a:get', 'get'),
      )
      const record = (properties: Record<string, JsonSchema>): JsonSchema => ({
        type: 'object',
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        additionalProperties: { type: 'number' },
      })
      assert.deepEqual(
        compareApiProtocol(
          doc({ 'a:get': { args: tuple(), result: record({}) } }),
          doc({ 'a:get': { args: tuple(), result: record({ note: str }) } }),
        ),
        broken('a:get', 'get', 'result.note', 'added beside a record index'),
      )
    })

    it('pairs set members so each fits, whichever order the new ones come in', () => {
      // {a} may become either new member, {b} only {a, b}. First fit would give
      // {a} the {a, b} member when it comes first and leave {b} without one.
      const fields = (...names: string[]): JsonSchema =>
        obj(Object.fromEntries(names.map((name) => [name, str])), [])
      const result = (key: 'allOf' | 'anyOf', ...members: JsonSchema[]): ApiProtocolDocument =>
        doc({ 'a:get': { args: tuple(), result: { [key]: members } } })
      const before = (key: 'allOf' | 'anyOf'): ApiProtocolDocument =>
        result(key, fields('a'), fields('b'))
      for (const after of [
        [fields('a', 'b'), fields('a', 'c')],
        [fields('a', 'c'), fields('a', 'b')],
      ]) {
        assert.deepEqual(
          compareApiProtocol(before('allOf'), result('allOf', ...after)),
          widened('a:get', 'get'),
        )
        // In a union, {b} gaining `a` would let an old client mistake it for {a}.
        assert.deepEqual(
          compareApiProtocol(before('anyOf'), result('anyOf', ...after)),
          broken('a:get', 'get', 'result.a', 'added to a union member that another member has'),
        )
      }
    })

    it('treats an optional field or trailing argument added to an event as additive', () => {
      const withEvent = (args: JsonSchema): ApiProtocolDocument => {
        const base = doc({})
        return {
          ...base,
          channels: { ...base.channels, event: { 'a:changed': { 'x-api': 'ns.onChanged', args } } },
          client: {
            ns: { onChanged: { kind: 'subscribe', channel: 'a:changed', handlerParams: args } },
          },
        }
      }
      const widenedEvent = {
        breaking: [],
        additive: [
          'channels.event.a:changed: widened compatibly',
          'client.ns.onChanged: widened compatibly',
        ],
      }
      const payload = obj({ id: str }, ['id'])
      assert.deepEqual(
        compareApiProtocol(
          withEvent(tuple(payload)),
          withEvent(tuple(obj({ id: str, note: str }, ['id']))),
        ),
        widenedEvent,
      )
      assert.deepEqual(
        compareApiProtocol(
          withEvent(tuple(payload)),
          withEvent({ type: 'array', prefixItems: [payload, str], minItems: 1, maxItems: 2 }),
        ),
        widenedEvent,
      )
      // A handler that took nothing (`onSettings(() => …)`) gains an optional argument.
      assert.deepEqual(
        compareApiProtocol(
          withEvent(tuple()),
          withEvent({ type: 'array', prefixItems: [str], minItems: 0, maxItems: 1 }),
        ),
        widenedEvent,
      )
    })
  })

  it('parses only documents that carry the fields the tooling reads', () => {
    assert.throws(() => parseApiProtocol('{"version":1}'), /not an API protocol document/)
    assert.equal(parseApiProtocol(serializeApiProtocol(doc({}))).version, 1)
  })
})

describe('generateApiProtocol parameter optionality', () => {
  it('keeps `| undefined` on a required parameter, which an optional one leaves to minItems', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-protocol-params-'))
    try {
      mkdirSync(join(root, 'src/preload'), { recursive: true })
      writeFileSync(
        join(root, 'tsconfig.node.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', lib: ['ES2022'] } }),
      )
      writeFileSync(
        join(root, 'src/preload/api.d.ts'),
        [
          'export interface ApiClient {',
          '  a: {',
          '    set(id: string | undefined): Promise<void>',
          '    pick(id?: string): Promise<void>',
          '    onPair(handler: (pair: [string, number | undefined, string?]) => void): () => void',
          '  }',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(root, 'src/preload/index.ts'),
        [
          'const api: ApiClient = {',
          '  a: {',
          "    set: (id: string | undefined) => ipcRenderer.invoke('a:set', id),",
          "    pick: (id?: string) => ipcRenderer.invoke('a:pick', id),",
          '    onPair: (handler: (pair: [string, number | undefined, string?]) => void) => {',
          '      const listener = (_e: unknown, pair: [string, number | undefined, string?]): void => {',
          '        handler(pair)',
          '      }',
          "      ipcRenderer.on('a:pair', listener)",
          "      return (): void => { ipcRenderer.off('a:pair', listener) }",
          '    },',
          '  },',
          '}',
          "contextBridge.exposeInMainWorld('api', api)",
          '',
        ].join('\n'),
      )
      const generated = generateApiProtocol({ root, version: 1 })
      const items = (schema: JsonSchema | undefined): unknown[] => {
        const prefix = schema?.['prefixItems']
        return Array.isArray(prefix) ? prefix : []
      }
      assert.deepEqual(items(generated.channels.invoke['a:set']?.args)[0], {
        title: 'id',
        type: 'string',
        'x-optional': true,
      })
      assert.deepEqual(items(generated.channels.invoke['a:pick']?.args)[0], {
        title: 'id',
        type: 'string',
      })
      const pair = items(generated.channels.event['a:pair']?.args)[0]
      assert.deepEqual(items(isRecord(pair) ? pair : undefined), [
        { type: 'string' },
        { type: 'number', 'x-optional': true },
        { type: 'string' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('protocolVersionProblem', () => {
  it('lets every breaking change before the next release share one unreleased bump', () => {
    // main is at v53 and the latest release shipped v42: trunk already carries
    // an unreleased bump, so a breaking pull request leaves the version alone,
    // and two pull requests that both bumped to v54 make the same edit.
    assert.equal(protocolVersionProblem({ breaking: true, base: 53, head: 53, released: 42 }), null)
    assert.equal(protocolVersionProblem({ breaking: true, base: 53, head: 54, released: 42 }), null)
  })

  it('asks for one more than the release when trunk has no unreleased bump', () => {
    assert.match(
      protocolVersionProblem({ breaking: true, base: 42, head: 42, released: 42 }) ?? '',
      /v42 has shipped or is about to\. Set API_PROTOCOL_VERSION .* on main to 43/,
    )
    assert.equal(protocolVersionProblem({ breaking: true, base: 42, head: 43, released: 42 }), null)
    // A base that predates the release still has to clear the release.
    assert.match(
      protocolVersionProblem({ breaking: true, base: 41, head: 42, released: 42 }) ?? '',
      /to 43/,
    )
  })

  it('falls back to requiring a bump over the base when the release is unknown', () => {
    assert.match(
      protocolVersionProblem({ breaking: true, base: 53, head: 53 }) ?? '',
      /without a version bump/,
    )
    assert.equal(protocolVersionProblem({ breaking: true, base: 53, head: 54 }), null)
  })

  it('never lets the version go below the base, breaking or not', () => {
    for (const breaking of [true, false]) {
      assert.match(
        protocolVersionProblem({ breaking, base: 53, head: 52, released: 42 }) ?? '',
        /below the base's \(v53 → v52\)/,
      )
    }
    assert.equal(
      protocolVersionProblem({ breaking: false, base: 53, head: 53, released: 53 }),
      null,
    )
  })
})

describe('linkRefNodeModules', () => {
  it("resolves workspace packages from the ref's worktree and dependencies from the base", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'copse-protocol-links-')))
    try {
      const base = join(dir, 'base')
      const worktree = join(dir, 'ref')
      for (const path of [
        'base/packages/llm',
        'base/node_modules/@copse',
        'base/node_modules/.pnpm/zod/node_modules/zod',
        'ref/packages/llm',
      ]) {
        mkdirSync(join(dir, path), { recursive: true })
      }
      symlinkSync('../../packages/llm', join(base, 'node_modules/@copse/llm'))
      symlinkSync('.pnpm/zod/node_modules/zod', join(base, 'node_modules/zod'))
      symlinkSync('../../packages/removed', join(base, 'node_modules/@copse/removed'))

      // A package's own dependencies: another workspace package, and an install only it has.
      mkdirSync(join(base, 'packages/llm/node_modules/@copse'), { recursive: true })
      mkdirSync(join(base, 'packages/std'))
      mkdirSync(join(worktree, 'packages/std'))
      mkdirSync(join(base, 'packages/llm/node_modules/only-llm'))
      symlinkSync('../../../std', join(base, 'packages/llm/node_modules/@copse/std'))

      linkRefNodeModules(base, worktree)

      assert.equal(
        realpathSync(join(worktree, 'node_modules/@copse/llm')),
        join(worktree, 'packages/llm'),
      )
      assert.equal(
        realpathSync(join(worktree, 'packages/llm/node_modules/@copse/std')),
        join(worktree, 'packages/std'),
      )
      assert.equal(
        realpathSync(join(worktree, 'packages/llm/node_modules/only-llm')),
        join(base, 'packages/llm/node_modules/only-llm'),
      )
      assert.equal(
        realpathSync(join(worktree, 'node_modules/zod')),
        join(base, 'node_modules/.pnpm/zod/node_modules/zod'),
      )
      assert.deepEqual(readdirSync(join(worktree, 'node_modules/@copse')), ['llm'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gen-api-protocol --compare-ref', () => {
  const run = (
    ref: string,
    gitDir?: string,
    extra: string[] = [],
  ): { status: number | null; out: string } => {
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/gen-api-protocol.mts'), '--compare-ref', ref, ...extra],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...(gitDir ? { GIT_DIR: gitDir } : {}) },
      },
    )
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  it('passes when the ref predates the protocol, instead of failing to read it', () => {
    // CI compares against the PR base. On the PR that introduces the protocol
    // that base has no `src/shared/api-protocol.mts`, and `git show` of a path
    // that does not exist there exits 128 — which failed the whole job rather
    // than reporting "nothing to compare". There is no previous surface, so
    // every channel is new and nothing can be breaking.
    // Do not infer the first commit from this checkout: CI's shallow clone
    // presents its current tip as a root, and that tip already has a protocol.
    // A bare fixture with an empty-tree commit is independent of checkout depth
    // and never changes the developer's refs, index, or working tree.
    const gitDir = mkdtempSync(join(tmpdir(), 'copse-protocol-base-'))
    try {
      execFileSync('git', ['init', '--bare', gitDir], { stdio: 'ignore' })
      const tree = execFileSync(
        'git',
        ['-C', gitDir, 'hash-object', '-w', '-t', 'tree', '--stdin'],
        {
          input: '',
          encoding: 'utf8',
        },
      ).trim()
      const firstCommit = execFileSync(
        'git',
        [
          '-C',
          gitDir,
          '-c',
          'user.name=Protocol test',
          '-c',
          'user.email=protocol@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit-tree',
          tree,
        ],
        { input: 'Before the protocol\n', encoding: 'utf8' },
      ).trim()
      const { status, out } = run(firstCommit, gitDir)
      assert.equal(status, 0, out)
      assert.match(out, /no API protocol to compare against/)
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })

  it('fails closed when the base cannot be read at all', () => {
    // The bootstrap allowance above must not extend to a base that is missing,
    // unfetched, or misspelled: "cannot read the base" is indistinguishable
    // from "the base has no protocol" only if you stop asking, and a gate that
    // passes whenever CI cannot see the base is worse than no gate.
    for (const ref of ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'origin/no-such-branch']) {
      const { status, out } = run(ref)
      assert.equal(status, 1, `${ref} should fail closed, got:\n${out}`)
      assert.match(out, /cannot resolve/)
    }
  })

  it('fails closed when the release cannot be read', () => {
    // Reading the release can only relax the rule, so an unreadable one must
    // not pass silently either.
    const { status, out } = run('HEAD', undefined, ['--released-ref', 'origin/no-such-release'])
    assert.equal(status, 1, out)
    assert.match(out, /cannot resolve origin\/no-such-release/)
    const missing = run('HEAD', undefined, ['--released-ref'])
    assert.equal(missing.status, 2, missing.out)
    assert.match(missing.out, /--released-ref needs a git ref/)
  })

  it('refuses a release on the commit under test and a release without a comparison', () => {
    // A push to release is tagged while CI runs: that tag is this commit being
    // released, so judging against it would demand a bump the release cannot have.
    const self = run('HEAD~1', undefined, ['--released-ref', 'HEAD'])
    assert.equal(self.status, 2, self.out)
    assert.match(self.out, /is the commit under test/)
    const swallowed = run('--released-ref', undefined, ['HEAD'])
    assert.equal(swallowed.status, 2, swallowed.out)
    assert.match(swallowed.out, /--compare-ref needs a git ref/)
    const alone = spawnSync(
      process.execPath,
      [resolve(ROOT, 'scripts/gen-api-protocol.mts'), '--released-ref', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    assert.equal(alone.status, 2, `${alone.stdout}${alone.stderr}`)
    assert.match(alone.stderr, /only applies with --compare-ref/)
  })
})
