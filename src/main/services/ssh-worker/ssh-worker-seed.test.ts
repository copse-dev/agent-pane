import { SshThreadRefused } from '@shared/ssh-thread-refused.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import type { SshConnection } from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import {
  isThreadHistoryPath,
  pullThreadMirror,
  seedSshWorker,
  workerStores,
} from './ssh-worker-seed.ts'
import { remoteThreadDir, userDataDir, type RemoteNode } from './ssh-worker-remote.ts'

const scratch = mkdtempSync(join(tmpdir(), 'copse-ssh-worker-seed-'))
const previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
process.env['COPSE_WORKSPACE_DIR'] = join(scratch, 'workspace')
after(() => {
  if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
  else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
  rmSync(scratch, { recursive: true, force: true })
})

function node(home: string): RemoteNode {
  return { version: process.versions.node, execPath: process.execPath, home: join(scratch, home) }
}

/** A thread's `meta.json` as the store writes one. */
function meta(id: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    title: 'Thread',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...fields,
  })
}

/** The app's copy of a thread, with these files. */
function localThread(threadId: string, files: Record<string, string>): string {
  const dir = threadDirectoryPath('p1', threadId)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const PROJECT = { id: 'p1', name: 'Site', path: '/srv/site' }

/** A "host" that is this machine: each argv runs here, with its stdin. */
function localHost(): { connection: SshConnection; ran: string[] } {
  const ran: string[] = []
  const transport = new FakeSshTransport()
  return {
    ran,
    connection: {
      host: { id: 'dev', label: 'Dev Server', host: 'dev.example' },
      transport,
      execArgv: (argv, options): Promise<SshExecResult> => {
        const [command = '', ...args] = argv
        ran.push(command === process.execPath ? 'node' : command)
        const result = spawnSync(command, args, { input: options?.stdin, encoding: 'utf8' })
        return Promise.resolve({
          code: result.status ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
        })
      },
      execShell: () => Promise.reject(new Error('not used')),
    },
  }
}

describe('what the worker on an SSH host is given', () => {
  it('gets the project as its own, and only settings with nothing secret', () => {
    const stores = workerStores(
      {
        model: 'claude-sonnet-4-6',
        'apiKey.anthropic': 'sk-secret',
        apiKey: { anthropic: 'sk-secret' },
        chatgptPlanCredentials: { token: 'x' },
        'mcpOAuth.abc': { token: 'y' },
        sshWorkspaceEnabled: true,
        sshWorkspaceHosts: [{ id: 'other' }],
        registeredAcpAgents: [{ env: { TOKEN: 'x' } }],
        defaultReadonlyMode: true,
        notAKnownSetting: 'kept out',
      },
      PROJECT,
    )
    assert.deepEqual(stores.settings, { model: 'claude-sonnet-4-6', defaultReadonlyMode: true })
    assert.deepEqual(stores.config, {
      projects: [{ id: 'p1', name: 'Site', path: '/srv/site' }],
      activeProjectId: 'p1',
      workspaceRoot: '/srv/site',
    })
  })

  it("copies a thread's history, not its leases or indexes", () => {
    for (const path of [
      'meta.json',
      'events.jsonl',
      'agent-history.json',
      'messages/a.md',
      'blobs/b',
    ])
      assert.ok(isThreadHistoryPath(path), path)
    for (const path of ['writer.lease.3', 'host-dispatch.json', '.thread-index.sqlite'])
      assert.ok(!isThreadHistoryPath(path), path)
  })

  it("writes the stores and gives the host this computer's copy of the thread", async () => {
    const host = node('home')
    localThread('t1', {
      'meta.json': meta('t1'),
      'events.jsonl': '{"n":1}\n',
      'messages/m1.md': 'Hello',
      'writer.lease.1': 'held here',
    })
    // The worker keeps its own files in user-data, and its lease and record
    // beside the thread: seeding leaves them.
    mkdirSync(userDataDir(host), { recursive: true })
    writeFileSync(join(userDataDir(host), 'worker-own.json'), '{}')
    const remote = remoteThreadDir(host, 'p1', 't1')
    mkdirSync(join(remote, 'messages'), { recursive: true })
    writeFileSync(join(remote, 'host-dispatch.json'), '{}')
    writeFileSync(join(remote, 'messages', 'stale.md'), 'gone')

    const { connection } = localHost()
    const input = {
      settings: { model: 'm', 'apiKey.openai': 'sk' },
      project: PROJECT,
      threadId: 't1',
    }
    await seedSshWorker(connection, host, input)

    const userData = userDataDir(host)
    assert.deepEqual(readdirSync(userData).sort(), [
      'config.json',
      'settings.json',
      'worker-own.json',
    ])
    assert.deepEqual(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')), {
      model: 'm',
    })
    assert.deepEqual(readdirSync(remote).sort(), [
      'events.jsonl',
      'host-dispatch.json',
      'messages',
      'meta.json',
    ])
    assert.deepEqual(readdirSync(join(remote, 'messages')), ['m1.md'])
  })

  it("takes the host's copy first when the host has more of the thread", async () => {
    const host = node('home-ahead')
    const local = localThread('t4', { 'meta.json': meta('t4'), 'events.jsonl': '{"n":1}\n' })
    const remote = remoteThreadDir(host, 'p1', 't4')
    mkdirSync(remote, { recursive: true })
    writeFileSync(join(remote, 'meta.json'), meta('t4'))
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n{"n":2}\n')

    await seedSshWorker(localHost().connection, host, {
      settings: {},
      project: PROJECT,
      threadId: 't4',
    })
    assert.equal(readFileSync(join(local, 'events.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n')
    assert.equal(readFileSync(join(remote, 'events.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n')
  })

  it("keeps a turn the app ran meanwhile when the host's copy is behind", async () => {
    const host = node('home-behind')
    localThread('t5', { 'meta.json': meta('t5'), 'events.jsonl': '{"n":1}\n{"n":2}\n' })
    const remote = remoteThreadDir(host, 'p1', 't5')
    mkdirSync(remote, { recursive: true })
    writeFileSync(join(remote, 'meta.json'), meta('t5'))
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n')

    await seedSshWorker(localHost().connection, host, {
      settings: {},
      project: PROJECT,
      threadId: 't5',
    })
    assert.equal(readFileSync(join(remote, 'events.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n')
  })

  it('starts a thread with no history here empty there', async () => {
    const host = node('home-new')
    await seedSshWorker(localHost().connection, host, {
      settings: {},
      project: PROJECT,
      threadId: 't2',
    })
    assert.ok(!existsSync(join(remoteThreadDir(host, 'p1', 't2'), 'meta.json')))
  })

  it("keeps the app's copy of a thread up to the host's", async () => {
    const host = node('home-mirror')
    const remote = remoteThreadDir(host, 'p1', 't3')
    mkdirSync(join(remote, 'messages'), { recursive: true })
    writeFileSync(join(remote, 'meta.json'), meta('t3'))
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n{"n":2}\n')
    writeFileSync(join(remote, 'messages', 'm2.md'), 'Done')
    writeFileSync(join(remote, 'host-dispatch.json'), '{}')
    const local = localThread('t3', { 'events.jsonl': '{"n":1}\n', '.thread-index.sqlite': 'kept' })

    const { connection } = localHost()
    assert.equal(await pullThreadMirror(connection, host, 'p1', 't3'), true)
    assert.deepEqual(readdirSync(local).sort(), [
      '.thread-index.sqlite',
      'events.jsonl',
      'messages',
      'meta.json',
      'ssh-host-sync.json',
    ])
    assert.equal(readFileSync(join(local, 'events.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n')
    assert.equal(readFileSync(join(local, 'messages', 'm2.md'), 'utf8'), 'Done')

    // A thread the host does not have leaves the app's copy alone.
    assert.equal(await pullThreadMirror(connection, host, 'p1', 'nope'), false)
  })

  it('refuses a thread a turn holds on the host, or one that went on in both places', async () => {
    const host = node('home-held')
    localThread('t7', { 'meta.json': meta('t7'), 'events.jsonl': '{"n":1}\n' })
    const remote = remoteThreadDir(host, 'p1', 't7')
    mkdirSync(remote, { recursive: true })
    writeFileSync(join(remote, 'meta.json'), meta('t7'))
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n')
    const lease = {
      releasedAt: undefined,
      heartbeatAt: Date.now(),
      ttlMs: 30_000,
      pid: process.pid,
    }
    writeFileSync(join(remote, 'writer.lease.1'), JSON.stringify(lease))
    const input = { settings: {}, project: PROJECT, threadId: 't7' }
    await assert.rejects(seedSshWorker(localHost().connection, host, input), SshThreadRefused)

    writeFileSync(join(remote, 'writer.lease.1'), JSON.stringify({ ...lease, releasedAt: 1 }))
    writeFileSync(join(remote, 'events.jsonl'), '{"n":"there"}\n')
    await assert.rejects(seedSshWorker(localHost().connection, host, input), /went on both/)
  })

  it('lets the side that alone changed since the last sync win, even by a rewrite', async () => {
    const host = node('home-rewind')
    const local = localThread('t9', {
      'meta.json': meta('t9'),
      'events.jsonl': '{"n":1}\n{"n":2}\n',
    })
    const input = { settings: {}, project: PROJECT, threadId: 't9' }
    const { connection } = localHost()
    await seedSshWorker(connection, host, input)
    const remote = remoteThreadDir(host, 'p1', 't9')

    // A rewind here rewrites the events: the host's unchanged copy gives way.
    writeFileSync(join(local, 'events.jsonl'), '{"n":1}\n{"n":"edited"}\n')
    await seedSshWorker(connection, host, input)
    assert.equal(readFileSync(join(remote, 'events.jsonl'), 'utf8'), '{"n":1}\n{"n":"edited"}\n')

    // A turn there, unmirrored: the host's copy comes here first.
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n{"n":"edited"}\n{"n":3}\n')
    await seedSshWorker(connection, host, input)
    assert.equal(
      readFileSync(join(local, 'events.jsonl'), 'utf8'),
      '{"n":1}\n{"n":"edited"}\n{"n":3}\n',
    )

    // Both moved: refused.
    writeFileSync(join(remote, 'events.jsonl'), '{"n":"host"}\n')
    writeFileSync(join(local, 'events.jsonl'), '{"n":"laptop"}\n')
    await assert.rejects(seedSshWorker(connection, host, input), /went on both/)
  })

  it("keeps what is this computer's in the thread's meta when it comes back", async () => {
    const host = node('home-meta')
    const remote = remoteThreadDir(host, 'p1', 't8')
    mkdirSync(remote, { recursive: true })
    // The host's file names another thread, and plants a worktree here.
    writeFileSync(
      join(remote, 'meta.json'),
      meta('t-other', {
        title: 'Auto',
        worktree: { path: '/planted' },
        updatedAt: 2,
        // It picks a model, and winds back what the thread used.
        model: 'pricey',
        continuationUsed: -1000,
        crossThreadPromptCounts: { a: 0, b: 3 },
      }),
    )
    writeFileSync(join(remote, 'events.jsonl'), '{"n":1}\n')
    const local = localThread('t8', {
      'meta.json': meta('t8', {
        title: 'Renamed',
        status: 'running',
        draftPrompt: 'hi',
        model: 'm',
        crossThreadPromptCounts: { a: 2 },
      }),
    })
    await pullThreadMirror(localHost().connection, host, 'p1', 't8', { title: 'Before' })
    assert.deepEqual(
      JSON.parse(readFileSync(join(local, 'meta.json'), 'utf8')),
      JSON.parse(
        meta('t8', {
          title: 'Renamed',
          draftPrompt: 'hi',
          updatedAt: 2,
          model: 'm',
          continuationUsed: 0,
          crossThreadPromptCounts: { a: 2, b: 3 },
        }),
      ),
    )

    // A meta the store could not read is not taken.
    writeFileSync(join(remote, 'meta.json'), JSON.stringify({ id: 't8' }))
    await assert.rejects(pullThreadMirror(localHost().connection, host, 'p1', 't8'), /cannot read/)
  })

  it('refuses a copy cut short on its way back', async () => {
    const cut: SshConnection = {
      ...localHost().connection,
      execArgv: () => Promise.resolve({ code: 0, stdout: 'eyJwYXRoIjoi', stderr: '' }),
    }
    await assert.rejects(pullThreadMirror(cut, node('home-cut'), 'p1', 't6'), /cut short/)
  })
})
