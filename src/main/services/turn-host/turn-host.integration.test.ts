import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as esbuild from 'esbuild'
import { WRITER_LEASE_FILE } from '@copse/thread-store/writer-lease.ts'
import { STANDALONE_MAIN_BUNDLES } from '../../../../scripts/main-bundles.mts'
import { MAIN_EXTERNALS, MAIN_LOG_OVERRIDE } from '../../../../scripts/main-externals.mts'
import { loadThreadMessages, saveProjectThread, threadDirectoryPath } from '../thread-store.ts'
import { connectTurnHost, turnHostSocketPath, type HostToApp } from './turn-host-protocol.ts'

/**
 * H1's exit gate (`docs/plans/local-turn-worker.md`, "Every turn in a turn
 * host"): the bundled host, started as the app starts it against a temporary
 * profile and the mock provider, runs two turns on two threads to completion
 * and lets both threads go, and a repeated operation id runs nothing.
 *
 * Bundles the entry as `pnpm run build` does, so it runs on demand:
 * `COPSE_TURN_HOST_E2E=1 node scripts/run-tests.mts turn-host.integration`.
 */

const E2E = process.env['COPSE_TURN_HOST_E2E'] === '1'
const VERSION = 'turn-host-it'

let root = ''
let bundle = ''
let child: ChildProcess | null = null
const savedDir = process.env['COPSE_DIR']

async function bundleHost(outfile: string): Promise<void> {
  const entry = STANDALONE_MAIN_BUNDLES.find((b) => b.outfile.endsWith('turn-host.js'))
  if (!entry) throw new Error('the turn host is not registered in main-bundles.mts')
  await esbuild.build({
    entryPoints: [resolve(entry.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // As `pnpm run build` bundles it (`scripts/build.mts`).
    external: entry.external ?? [...MAIN_EXTERNALS],
    logOverride: { ...MAIN_LOG_OVERRIDE, ...entry.logOverride },
    alias: {
      '@shared': resolve('./src/shared'),
      ...Object.fromEntries(
        Object.entries(entry.alias ?? {}).map(([from, to]) => [from, resolve(to)]),
      ),
    },
    define: { __COPSE_TEST_SCENARIOS__: 'false' },
    logLevel: 'error',
  })
}

describe('the bundled turn host', { skip: !E2E, timeout: 120_000 }, () => {
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'turn-host-it-'))
    mkdirSync(join(root, 'ud'))
    process.env['COPSE_DIR'] = join(root, 'ws')
    // Inside the repo, so the bundle's externals resolve from its node_modules.
    bundle = resolve('dist-test', `turn-host-it-${String(process.pid)}`, 'turn-host.cjs')
    await bundleHost(bundle)
  })
  after(() => {
    child?.kill('SIGTERM')
    if (savedDir === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = savedDir
    rmSync(root, { recursive: true, force: true })
    rmSync(join(bundle, '..'), { recursive: true, force: true })
  })

  it('runs turns on two threads, once each', async () => {
    const at = Date.now()
    for (const id of ['a', 'b']) {
      await saveProjectThread('p1', {
        id,
        title: id,
        status: 'idle',
        model: 'claude-sonnet-4-6',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: at,
        updatedAt: at,
      })
    }
    const userData = join(root, 'ud')
    child = spawn(process.execPath, [bundle, '--user-data', userData, '--app-version', VERSION], {
      env: {
        ...process.env,
        COPSE_DIR: join(root, 'ws'),
        COPSE_PANEL_MOCK_LLM: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let log = ''
    let wake = (): void => undefined
    const changed = (): void => {
      wake()
    }
    /** Resolves once `check` holds, re-checked whenever the host says something. */
    const until = (check: () => boolean): Promise<void> =>
      new Promise((resolve) => {
        wake = (): void => {
          if (check()) resolve()
        }
        wake()
      })
    child.stderr?.on('data', (data: Buffer) => {
      log += data.toString()
      changed()
    })
    child.once('exit', changed)

    // The host logs that it serves once its line is open.
    await until(() => log.includes('serving ') || child?.exitCode !== null)
    const received: HostToApp[] = []
    const line = await connectTurnHost(
      turnHostSocketPath(userData),
      (message) => {
        received.push(message)
        changed()
      },
      changed,
    )
    assert.ok(line, `the host never served:\n${log}`)
    line.send({ t: 'hello', version: VERSION, protocol: 2 })
    line.send({ t: 'attach' })
    line.send({ t: 'dispatch', id: 'op-a', projectId: 'p1', threadId: 'a', payload: 'One' })
    line.send({ t: 'dispatch', id: 'op-b', projectId: 'p1', threadId: 'b', payload: 'Two' })
    await until(() =>
      ['op-a', 'op-b'].every((id) => received.some((m) => m.t === 'ended' && m.id === id)),
    )
    // The app lost the answer and sends the same operation again.
    line.send({ t: 'dispatch', id: 'op-a', projectId: 'p1', threadId: 'a', payload: 'One' })
    await until(() => received.some((m) => m.t === 'status' && m.id === 'op-a'))
    line.close()

    assert.equal(received[0]?.t, 'hello')
    assert.ok(received.some((m) => m.t === 'chunk' && m.threadId === 'a'))
    assert.ok(received.some((m) => m.t === 'chunk' && m.threadId === 'b'))
    for (const id of ['a', 'b']) {
      assert.equal((await loadThreadMessages('p1', id)).length, 1, `one reply on ${id}`)
      assert.equal(existsSync(join(threadDirectoryPath('p1', id), WRITER_LEASE_FILE)), false)
    }
  })
})
