import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { build } from 'esbuild'
import { PluginToolHost } from './plugin-tool-host.ts'
import { discoverPluginToolSource } from './plugin-tool-source.ts'
import type { PluginHookRegistration } from './plugin-tool-protocol.ts'

const hooks: PluginHookRegistration[] = [
  { id: 'inspect', event: 'turnStart' },
  { id: 'wait', event: 'stop' },
  { id: 'fail', event: 'afterToolUse' },
  { id: 'invalid', event: 'stop' },
]
const moduleSource = `export function activate(api) {
  api.registerHook({ id: 'inspect', event: 'turnStart' }, (input, context) => ({
    input, event: context.event, capabilities: Object.keys(context).sort()
  }));
  api.registerHook({ id: 'wait', event: 'stop' }, (_input, { signal }) => new Promise(resolve => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener('abort', () => resolve(null), { once: true });
  }));
  api.registerHook({ id: 'fail', event: 'afterToolUse' }, () => { throw new Error('hook failed'); });
  api.registerHook({ id: 'invalid', event: 'stop' }, () => 1n);
}`

let root = ''
const hosts: PluginToolHost[] = []
let fixtureIndex = 0

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-hook-worker-'))
  await build({
    entryPoints: [resolve('packages/plugin-sdk/src/plugin-tool-worker.ts')],
    outfile: join(root, 'worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
})
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function start(
  declarations: readonly PluginHookRegistration[] = hooks,
): Promise<PluginToolHost> {
  const pluginRoot = join(root, `plugin-${String(fixtureIndex++)}`)
  await mkdir(pluginRoot)
  await writeFile(join(pluginRoot, 'index.mjs'), moduleSource)
  await writeFile(
    join(pluginRoot, 'copse-plugin.json'),
    JSON.stringify({
      name: 'personal.hook-test',
      runtime: { entrypoint: 'index.mjs', apiVersion: 1, hooks: declarations },
    }),
  )
  const candidate = await discoverPluginToolSource(pluginRoot)
  // Exercise the real SDK, worker, framing and host. OS containment is a separate
  // platform test; this injected spawn keeps this protocol test portable.
  const host = await PluginToolHost.start(candidate, {
    sandboxAvailable: () => true,
    materialize: async (value) => value,
    spawn: async () => spawn(process.execPath, [join(root, 'worker.mjs')], { stdio: 'pipe' }),
    browserService: null,
  })
  hosts.push(host)
  return host
}

describe('external hook worker round trip', () => {
  it('registers a hook-only module and invokes the requested event without host capabilities', async () => {
    const host = await start()
    assert.deepEqual(host.registrations, { tools: [], models: [], hooks })
    assert.deepEqual(await host.invokeHook('inspect', 'turnStart', { userText: 'hello' }), {
      input: { userText: 'hello' },
      event: 'turnStart',
      capabilities: ['event', 'signal'],
    })
    await assert.rejects(host.invokeHook('inspect', 'stop', {}), /event mismatch/)
    await assert.rejects(host.invokeHook('missing', 'stop', {}), /Unknown plugin hook/)
  })

  it('propagates cancellation and failures, rejects unserializable results, and stays usable', async () => {
    const host = await start()
    const controller = new AbortController()
    const pending = host.invokeHook('wait', 'stop', {}, controller.signal)
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    await assert.rejects(host.invokeHook('fail', 'afterToolUse', {}), /hook failed/)
    await assert.rejects(host.invokeHook('invalid', 'stop', {}), /non-serializable/)
    assert.ok(await host.invokeHook('inspect', 'turnStart', {}))
    await host.stop()
    await assert.rejects(host.invokeHook('inspect', 'turnStart', {}), /not running/)
  })

  it('fails startup when the worker adds, omits, or changes a declared hook', async () => {
    await assert.rejects(start([{ id: 'inspect', event: 'turnStart' }]), /hooks not declared/)
    await assert.rejects(start([...hooks, { id: 'missing', event: 'stop' }]), /hooks not declared/)
    await assert.rejects(start(hooks.map((h) => ({ ...h, event: 'stop' }))), /hooks not declared/)
  })
})
