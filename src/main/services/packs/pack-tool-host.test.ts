import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  PackToolHost,
  PackToolHostUnavailable,
  packToolSandboxOverlay,
  type PackToolHostDependencies,
} from './pack-tool-host.ts'
import { discoverPackToolSource, type PackToolSourceCandidate } from './pack-tool-source.ts'
import { PackBrowserPanelService, type PackBrowserContents } from './pack-browser-panel.ts'

const FAKE_WORKER = String.raw`
let buffer = '';
let pendingModel = null;
const send = (body) => process.stdout.write(JSON.stringify(body) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const req = JSON.parse(line);
    if (req.op === 'initialize') {
      send({ type: 'response', id: req.id, ok: true, result: {
        tools: [{ name: 'personal_judge', description: 'Judge input', inputSchema: { type: 'object' } }],
        models: [{ id: 'judge' }],
      }});
    } else if (req.op === 'invoke') {
      if (req.kind === 'model') {
        pendingModel = req;
        if (req.input.prompt === 'browse') {
          send({ type: 'browser-call', id: 2, invocationId: req.id, op: 'open', url: 'https://example.test/start' });
        } else {
          send({ type: 'session-call', id: 1, invocationId: req.id, op: 'set', state: { externalId: 'chat-42' } });
        }
      } else {
        send({ type: 'response', id: req.id, ok: true, result: { answer: req.input.prompt } });
      }
    } else if (req.op === 'session-result' && pendingModel) {
      send({ type: 'response', id: pendingModel.id, ok: true, result: { text: pendingModel.input.prompt } });
      pendingModel = null;
    } else if (req.op === 'browser-result' && pendingModel) {
      send({ type: 'response', id: pendingModel.id, ok: true, result: req.result });
      pendingModel = null;
    } else if (req.op === 'shutdown') {
      send({ type: 'response', id: req.id, ok: true });
    }
    nl = buffer.indexOf('\n');
  }
});
`

const tempRoots: string[] = []

async function fixture(): Promise<PackToolSourceCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-pack-tool-host-'))
  tempRoots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export async function activate() {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.host-test',
      version: '0.1.0',
      tools: {
        provides: ['personal_judge'],
      },
      models: {
        provides: [{ id: 'judge', label: 'Judge' }],
      },
      browser: { origins: ['https://example.test'] },
      runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
    }),
  )
  return discoverPackToolSource(root)
}

const fakeDependencies: PackToolHostDependencies = {
  sandboxAvailable: () => true,
  materialize: (candidate) => Promise.resolve(candidate),
  spawn: () => Promise.resolve(spawn(process.execPath, ['-e', FAKE_WORKER], { stdio: 'pipe' })),
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pack tool host', () => {
  it('fails closed before spawning when the OS sandbox is unavailable', async () => {
    const candidate = await fixture()
    let spawned = false
    await assert.rejects(
      PackToolHost.start(candidate, {
        sandboxAvailable: () => false,
        materialize: (value) => Promise.resolve(value),
        spawn: () => {
          spawned = true
          return fakeDependencies.spawn(candidate, 'unused')
        },
      }),
      (error: unknown) =>
        error instanceof PackToolHostUnavailable && /failed closed/i.test(error.message),
    )
    assert.equal(spawned, false)
  })

  it('registers and invokes tools through the bounded worker protocol', async () => {
    const host = await PackToolHost.start(await fixture(), fakeDependencies)

    assert.deepEqual(
      host.registrations.tools.map((tool) => tool.name),
      ['personal_judge'],
    )
    assert.deepEqual(await host.invokeTool('personal_judge', { prompt: 'review this' }), {
      answer: 'review this',
    })
    await host.stop()
  })

  it('binds durable session calls to the active pack model and thread', async () => {
    const writes: unknown[] = []
    const host = await PackToolHost.start(await fixture(), {
      ...fakeDependencies,
      sessionStore: {
        get: () => Promise.resolve(null),
        set: (packId, threadId, state) => {
          writes.push({ packId, threadId, state })
          return Promise.resolve()
        },
        delete: () => Promise.resolve(),
      },
    })

    assert.deepEqual(
      await host.invokeModel('judge', {
        threadId: 'thread-7',
        prompt: 'review this',
        attachments: [],
        history: [],
      }),
      { text: 'review this' },
    )
    assert.deepEqual(writes, [
      {
        packId: 'personal.host-test',
        threadId: 'thread-7',
        state: { externalId: 'chat-42' },
      },
    ])
    await host.stop()
  })

  it('binds explicit browser calls to the declared origin and active model thread', async () => {
    let loadedUrl = 'about:blank'
    const browserService = new PackBrowserPanelService({
      ensureTab: (): Promise<{ tabId: string; webContentsId: number }> =>
        Promise.resolve({ tabId: 'visible-tab', webContentsId: 7 }),
      contentsFromId: (): PackBrowserContents => ({
        isDestroyed: (): boolean => false,
        getURL: (): string => loadedUrl,
        getTitle: (): string => 'Example',
        setAllowedOrigins: (): void => {},
        consumeBlockedUrl: (): null => null,
        loadURL: (url): Promise<void> => {
          loadedUrl = url
          return Promise.resolve()
        },
        stop: (): void => {},
        executeJavaScript: (): Promise<unknown> => Promise.resolve(true),
      }),
    })
    const host = await PackToolHost.start(await fixture(), {
      ...fakeDependencies,
      browserService,
    })

    assert.deepEqual(
      await host.invokeModel('judge', {
        threadId: 'thread-browser',
        prompt: 'browse',
        attachments: [],
        history: [],
      }),
      {
        tabId: 'visible-tab',
        title: 'Example',
        url: 'https://example.test/start',
        active: true,
      },
    )
    assert.equal(loadedUrl, 'https://example.test/start')
    await host.stop()
  })

  it('fails closed when the worker emits malformed protocol data', async () => {
    const candidate = await fixture()
    await assert.rejects(
      PackToolHost.start(candidate, {
        ...fakeDependencies,
        spawn: () =>
          Promise.resolve(
            spawn(process.execPath, ['-e', "process.stdout.write('not-json\\n')"], {
              stdio: 'pipe',
            }),
          ),
      }),
      /invalid JSON/i,
    )
  })

  it('rejects startup when the worker exits before initialization', async () => {
    const candidate = await fixture()
    await assert.rejects(
      PackToolHost.start(candidate, {
        ...fakeDependencies,
        spawn: () =>
          Promise.resolve(spawn(process.execPath, ['-e', 'process.exit(2)'], { stdio: 'pipe' })),
      }),
      /worker exited/i,
    )
  })

  it('stops before spawn when source bytes change during startup', async () => {
    const candidate = await fixture()
    await writeFile(
      join(candidate.sourcePath, 'dist', 'index.mjs'),
      'export const changed = true\n',
    )
    await assert.rejects(PackToolHost.start(candidate, fakeDependencies), /changed while/i)
  })

  it('denies direct network and writes while allowing only pack and worker reads', () => {
    const overlay = packToolSandboxOverlay(
      '/Users/me/packs/example',
      '/Applications/Copse/worker.js',
    )
    assert.deepEqual(overlay.network, {
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
    })
    const filesystem = overlay.filesystem
    assert.ok(filesystem)
    assert.ok(filesystem.allowRead)
    assert.deepEqual(filesystem.allowWrite, [])
    assert.ok(filesystem.denyRead.includes('/Users'))
    assert.ok(filesystem.allowRead.includes('/Users/me/packs/example/**'))
    assert.ok(filesystem.allowRead.includes('/Applications/Copse/**'))
  })
})
