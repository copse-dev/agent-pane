import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  LocalNativePackHost,
  LocalNativePackHostUnavailable,
  localNativePackSandboxOverlay,
  type LocalNativePackHostDependencies,
} from './local-native-pack-host.ts'
import {
  createLocalNativePackTrustRecord,
  discoverLocalNativePack,
  type LocalNativePackCandidate,
} from './local-native-pack.ts'

const FAKE_WORKER = String.raw`
let buffer = '';
let invokeId = 0;
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
      }});
    } else if (req.op === 'invoke') {
      invokeId = req.id;
      send({ type: 'host-call', id: 41, capability: 'native-tools', method: 'fixture', args: req.input });
    } else if (req.op === 'host-call-result') {
      send({ type: 'response', id: invokeId, ok: req.ok, result: req.result, error: req.error });
    } else if (req.op === 'shutdown') {
      send({ type: 'response', id: req.id, ok: true });
    }
    nl = buffer.indexOf('\n');
  }
});
`

const tempRoots: string[] = []

async function fixture(): Promise<LocalNativePackCandidate> {
  const root = await mkdtemp(join(tmpdir(), 'copse-local-native-host-'))
  tempRoots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export async function activate() {}\n')
  await writeFile(
    join(root, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.host-test',
      version: '0.1.0',
      localNative: {
        entrypoint: 'dist/index.mjs',
        sdkVersion: 1,
        capabilities: ['native-tools'],
      },
    }),
  )
  return discoverLocalNativePack(root)
}

const fakeDependencies: LocalNativePackHostDependencies = {
  sandboxAvailable: () => true,
  materialize: (candidate) => Promise.resolve(candidate),
  spawn: () => Promise.resolve(spawn(process.execPath, ['-e', FAKE_WORKER], { stdio: 'pipe' })),
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local native pack host', () => {
  it('fails closed before spawning when the OS sandbox is unavailable', async () => {
    const candidate = await fixture()
    let spawned = false
    await assert.rejects(
      LocalNativePackHost.start(
        candidate,
        createLocalNativePackTrustRecord(candidate),
        () => Promise.resolve(null),
        {
          sandboxAvailable: () => false,
          materialize: (value) => Promise.resolve(value),
          spawn: () => {
            spawned = true
            return fakeDependencies.spawn(candidate, 'unused')
          },
        },
      ),
      (error: unknown) =>
        error instanceof LocalNativePackHostUnavailable && /failed closed/i.test(error.message),
    )
    assert.equal(spawned, false)
  })

  it('re-hashes approval, registers contributions, and re-checks host calls', async () => {
    const candidate = await fixture()
    const calls: unknown[] = []
    const host = await LocalNativePackHost.start(
      candidate,
      createLocalNativePackTrustRecord(candidate),
      (call) => {
        calls.push(call)
        return Promise.resolve({ answer: 'ok' })
      },
      fakeDependencies,
    )

    assert.deepEqual(
      host.registrations.tools.map((tool) => tool.name),
      ['personal_judge'],
    )
    assert.deepEqual(await host.invoke('tool', 'personal_judge', { prompt: 'review this' }), {
      answer: 'ok',
    })
    assert.deepEqual(calls, [
      {
        packId: 'personal.host-test',
        capability: 'native-tools',
        method: 'fixture',
        args: { prompt: 'review this' },
      },
    ])
    await host.stop()
  })

  it('invalidates approval before spawn when source bytes change', async () => {
    const candidate = await fixture()
    const trust = createLocalNativePackTrustRecord(candidate)
    await writeFile(
      join(candidate.sourcePath, 'dist', 'index.mjs'),
      'export const changed = true\n',
    )
    await assert.rejects(
      LocalNativePackHost.start(candidate, trust, () => Promise.resolve(null), fakeDependencies),
      /changed after approval/i,
    )
  })

  it('denies direct network and writes while allowing only pack/worker reads', () => {
    const overlay = localNativePackSandboxOverlay(
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
