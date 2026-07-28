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

const FAKE_WORKER = String.raw`
let buffer = '';
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
      send({ type: 'response', id: req.id, ok: true, result: { answer: req.input.prompt } });
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
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      },
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
    assert.deepEqual(await host.invoke('personal_judge', { prompt: 'review this' }), {
      answer: 'review this',
    })
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
