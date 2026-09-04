import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { API_PROTOCOL_VERSION } from '../../src/shared/api-protocol.mts'
import {
  API_PROTOCOL_MANIFEST_PATH,
  analyzePreloadSource,
  compareApiProtocol,
  generateApiProtocol,
  manifestOf,
  parseApiProtocol,
  parseApiProtocolManifest,
  serializeApiProtocol,
  serializeApiProtocolManifest,
  type ApiProtocolDocument,
  type JsonSchema,
} from './api-protocol.mts'

/**
 * Invariants for the renderer ↔ main API protocol (issue #2312, step 1).
 *
 * The committed `schemas/api-protocol.manifest.json` is the frozen surface.
 * These tests make it change only deliberately: the manifest must equal what
 * the sources generate, every facade method must be bound to a channel that
 * follows the naming convention, every channel must have a real main-process
 * endpoint, and the hand-written `src/shared/types/ipc.ts` maps (a partial,
 * older description of the same surface) must not name channels the protocol
 * does not have. The invariants run over the freshly generated document, which
 * carries the types the manifest leaves out.
 */
const ROOT = resolve('.')
const generated = generateApiProtocol({ version: API_PROTOCOL_VERSION })
const committed = generated
const manifestOnDisk = readFileSync(resolve(ROOT, API_PROTOCOL_MANIFEST_PATH), 'utf8')

/**
 * The channel a facade member is expected to bind: `namespace:method`, or for
 * a subscription `namespace:event` with the handler's `on` prefix dropped.
 */
function conventionalChannel(ns: string, method: string, kind: string): string {
  if (kind === 'subscribe' && /^on[A-Z]/.test(method)) {
    const event = method.slice(2)
    return `${ns}:${event.charAt(0).toLowerCase()}${event.slice(1)}`
  }
  return `${ns}:${method}`
}

/** Bindings still under a different area than their facade namespace. */
const CHANNEL_NAME_EXCEPTIONS: Record<string, string> = {
  'browser.onPluginTabRequest': 'plugins:browser-tab-request',
  'closeConfirm.onRequest': 'app:close_confirm_request',
  'diff.onShowDiff': 'agent:show_diff',
  'panes.onSwitchMode': 'popout:switch-mode',
  'sshPrompt.onRequest': 'ssh:prompt_request',
  'sshWorkspace.onConnectionChanged': 'ssh:connection_changed',
  'updatePrompt.onDevNotice': 'update:dev_notice',
  'updatePrompt.onRequest': 'update:prompt_request',
  'windowState.getNavigation': 'mainWindow:getNavigation',
  'windowState.setNavigation': 'mainWindow:setNavigation',
  'workspace.createNewProject': 'workspace:createProject',
  'workspace.unsandboxedProjectHooks': 'hooks:unsandboxedProjectHooks',
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
          /^[a-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9_-]*$/,
          `${api} channel "${method.channel}" is not "<area>:<name>"`,
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
    // subscriptions. A channel is then derivable from `ApiClient` alone, which
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

  it('src/shared/types/ipc.ts only names channels the protocol has', () => {
    // ipc.ts is a hand-written, partial map of the same surface. Until it is
    // retired in favour of the generated schema it must not describe channels
    // that no longer exist (or never did).
    const ipc = readFileSync(resolve(ROOT, 'src/shared/types/ipc.ts'), 'utf8')
    const eventStart = ipc.indexOf('export interface IpcEventMap')
    assert.ok(eventStart > 0)
    const declared = (text: string): string[] =>
      [...text.matchAll(/^ {2}'([^']+)':/gm)].map((match) => match[1] ?? '')
    const known = new Set([
      ...Object.keys(committed.channels.invoke),
      ...Object.keys(committed.channels.send),
    ])
    for (const channel of declared(ipc.slice(0, eventStart))) {
      assert.ok(known.has(channel), `ipc.ts IpcInvokeMap names unknown channel ${channel}`)
    }
    const events = new Set(Object.keys(committed.channels.event))
    for (const channel of declared(ipc.slice(eventStart))) {
      assert.ok(events.has(channel), `ipc.ts IpcEventMap names unknown channel ${channel}`)
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
    readFile: (projectId: string, path: string) => ipcRenderer.invoke('fs:readFile', projectId, path),
    write(projectId: string, path: string) {
      return ipcRenderer.invoke('fs:writeFile', path, projectId)
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
      { op: 'invoke', channel: 'fs:readFile', passThrough: true },
    ])
    // Arguments reordered: the wire tuple is not the facade's parameter list.
    assert.deepEqual(api.get('fs.write')?.bindings, [
      { op: 'invoke', channel: 'fs:writeFile', passThrough: false },
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
  const tuple = (...items: JsonSchema[]): JsonSchema => ({
    type: 'array',
    prefixItems: items,
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
        'channels.invoke.a:get: shape changed',
        'client.ns.del: removed',
        'client.ns.get: shape changed',
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
      'channels.invoke.a:get: shape changed',
      'client.ns.get: shape changed',
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

  it('parses only documents that carry the fields the tooling reads', () => {
    assert.throws(() => parseApiProtocol('{"version":1}'), /not an API protocol document/)
    assert.equal(parseApiProtocol(serializeApiProtocol(doc({}))).version, 1)
  })
})
