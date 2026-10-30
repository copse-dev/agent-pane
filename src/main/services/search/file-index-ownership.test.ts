import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import {
  buildIndex,
  getIndex,
  getReadyFileIndex,
  resolveFileIndexTarget,
  getIndexAgeMs,
  getIndexMemoryBytes,
  getIndexStats,
  invalidateIndex,
  setIndexForTest,
  whenFileIndexReady,
} from './file-index.ts'
import {
  flushScheduledIndexRebuild,
  scheduleIndexRebuild,
  stopWorkspaceIndexWatcher,
} from './workspace-index-watcher.ts'
import {
  resetWorkspaceIndexingForTest,
  setWorkspaceIndexPolicyOverrideForTest,
  startWorkspaceIndexing,
  startExecutionRootIndexing,
  stopExecutionRootIndexing,
} from './workspace-indexing.ts'
import { resolveFileReferences } from './file-reference-resolver.ts'
import { findFilesTool } from '../../tools/search-tools.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { REMOTE_PGID_PREFIX } from '../ssh-workspace/remote-env.ts'
import { setRgAvailableForTest } from '../tool-availability.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

const HOSTS: SshWorkspaceHost[] = [
  { id: 'a', label: 'A', host: 'index-host-a' },
  { id: 'b', label: 'B', host: 'index-host-b' },
]

describe('file-index execution ownership', () => {
  let root = ''
  let bin = ''
  let commandLog = ''
  let restoreWorkspace: (() => void) | undefined
  let previousPath: string | undefined
  let previousProjects: unknown
  let previousActiveProject: unknown
  let previousHosts: SshWorkspaceHost[]
  let previousSshEnabled: boolean
  let connectGate: { entered: () => void; release: Promise<void> } | null

  function inProject<T>(projectId: string, fn: () => T): T {
    return threadExecutionContextStorage.run(
      {
        projectId,
        threadId: `thread-${projectId}`,
        root,
        projectRoot: root,
        checkoutMode: 'shared',
        branch: null,
      },
      fn,
    )
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-index-owner-root-'))
    bin = await mkdtemp(join(tmpdir(), 'copse-index-owner-bin-'))
    commandLog = join(bin, 'commands.jsonl')
    await writeFile(join(root, 'local.ts'), 'local\n')
    // Exercise the real command runner and SSH spawn boundary without a host or
    // network. The child identifies which SSH host the production argv chose.
    await writeFile(
      join(bin, 'ssh'),
      `#!${process.execPath}\n` +
        `const fs = require('node:fs');\n` +
        `fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
        `const host = process.argv.find(arg => arg === 'index-host-a' || arg === 'index-host-b');\n` +
        `if (!host) process.exit(1);\n` +
        `process.stdout.write(${JSON.stringify(REMOTE_PGID_PREFIX)} + process.pid + '\\n' + ${JSON.stringify(root)} + '/' + host + '.ts\\n');\n`,
      { mode: 0o755 },
    )
    previousPath = process.env['PATH']
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`
    previousProjects = storageGet('projects')
    previousActiveProject = storageGet('activeProjectId')
    previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
    previousSshEnabled = getSetting<boolean>('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', HOSTS)
    storageSet('projects', [
      { id: 'local', path: root },
      { id: 'a', path: root, sshHost: 'a' },
      { id: 'b', path: root, sshHost: 'b' },
    ])
    storageSet('activeProjectId', 'local')
    restoreWorkspace = setWorkspaceRootForTest(root)
    invalidateIndex()
    resetSshConnectionManagerForTests()
    connectGate = null
    setSshTransportFactory((host) => {
      const gate = host.id === 'a' ? connectGate : null
      return new (class extends FakeSshTransport {
        override async connect(): Promise<void> {
          gate?.entered()
          await gate?.release
          await super.connect()
        }
      })([
        { when: /^uname -s$/, stdout: 'Linux\n' },
        { when: /^uname -m$/, stdout: 'x86_64\n' },
        { when: /printf %s "\$SHELL"/, stdout: '/bin/sh' },
        { when: /command -v git$/, stdout: '/usr/bin/git\n' },
        {
          when: /command -v rg$/,
          stdout: host.id === 'a' ? '/usr/bin/rg\n' : '',
          code: host.id === 'a' ? 0 : 1,
        },
      ])
    })
    setRgAvailableForTest(false)
  })

  afterEach(async () => {
    stopWorkspaceIndexWatcher()
    resetWorkspaceIndexingForTest()
    invalidateIndex()
    resetSshConnectionManagerForTests()
    restoreWorkspace?.()
    storageSet('projects', previousProjects)
    storageSet('activeProjectId', previousActiveProject)
    await setSetting('sshWorkspaceHosts', previousHosts)
    await setSetting('sshWorkspaceEnabled', previousSshEnabled)
    setRgAvailableForTest(null)
    if (previousPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = previousPath
    await rm(bin, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it(
    'keeps identical roots on local and two SSH hosts independent, including in-flight builds',
    { timeout: 10_000 },
    async () => {
      await inProject('local', () => buildIndex(root))
      const localIndex = inProject('local', () => getIndex(root))
      await getSshConnectionManager().disconnect('a')
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      connectGate = {
        entered: (): void => {
          entered.resolve(undefined)
        },
        release: release.promise,
      }
      storageSet('activeProjectId', 'a')
      const a = inProject('a', () => buildIndex(root))
      await entered.promise
      const b = inProject('b', () => buildIndex(root))
      release.resolve(undefined)
      await Promise.all([a, b])

      assert.equal(
        inProject('local', () => getIndex(root)),
        localIndex,
      )
      assert.deepEqual(
        inProject('local', () => getIndex(root)?.paths),
        ['local.ts'],
      )
      assert.deepEqual(
        inProject('a', () => getIndex(root)?.paths),
        ['index-host-a.ts'],
      )
      assert.deepEqual(
        inProject('b', () => getIndex(root)?.paths),
        ['index-host-b.ts'],
      )
      assert.equal(
        await inProject('a', () =>
          findFilesTool.execute({ pattern: '*.ts', max_results: 50 }, new AbortController().signal),
        ),
        'index-host-a.ts',
      )
      assert.equal(
        await inProject('b', () =>
          findFilesTool.execute({ pattern: '*.ts', max_results: 50 }, new AbortController().signal),
        ),
        'index-host-b.ts',
      )
      const commands = await readFile(commandLog, 'utf-8')
      assert.match(commands, /rg/)
      assert.match(commands, /find/)
      inProject('a', () => {
        invalidateIndex(root)
      })
      assert.equal(
        inProject('a', () => getIndex(root)),
        null,
      )
      assert.equal(
        inProject('a', () => getIndexStats(root)),
        null,
      )
      assert.equal(
        inProject('a', () => getIndexAgeMs(root)),
        null,
      )
      assert.equal(
        inProject('a', () => getIndexMemoryBytes(root)),
        null,
      )
      assert.ok(inProject('b', () => getIndex(root)))
      assert.equal(
        inProject('b', () => getIndexStats(root)?.pathCount),
        1,
      )
      assert.ok(inProject('b', () => getIndexAgeMs(root)) !== null)
      assert.ok((inProject('b', () => getIndexMemoryBytes(root)) ?? 0) > 0)
    },
  )

  it(
    'keeps a UI-triggered build on its captured host when selection changes during connect',
    { timeout: 10_000 },
    async () => {
      storageSet('activeProjectId', 'a')
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      connectGate = {
        entered: (): void => {
          entered.resolve(undefined)
        },
        release: release.promise,
      }
      const target = resolveFileIndexTarget()
      const building = buildIndex(root)
      const ready = getReadyFileIndex(root)
      await entered.promise
      storageSet('activeProjectId', 'b')
      release.resolve(undefined)
      await building
      assert.deepEqual((await ready)?.paths, ['index-host-a.ts'])
      assert.equal(getIndex(root), null, 'A completion must not publish an index for selected B')
      assert.deepEqual(
        await resolveFileReferences(
          ['index-host-a.ts', 'index-host-b.ts'],
          root,
          undefined,
          target,
        ),
        [{ candidate: 'index-host-a.ts', path: 'index-host-a.ts', kind: 'file' }],
      )
      storageSet('activeProjectId', 'a')
      await whenFileIndexReady(root)
      assert.deepEqual(getIndex(root)?.paths, ['index-host-a.ts'])
      assert.doesNotMatch(await readFile(commandLog, 'utf-8'), /index-host-b/)
    },
  )

  it('starts, rebuilds, and retires a local worktree while an SSH project is selected', async () => {
    class Watcher extends EventEmitter {
      close(): void {
        this.emit('close')
      }
      ref(): this {
        return this
      }
      unref(): this {
        return this
      }
    }
    let changed: fs.WatchListener<string> | undefined
    const watcher = new Watcher()
    let closed = false
    watcher.on('close', () => {
      closed = true
    })
    mock.method(
      fs,
      'watch',
      (_filename: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
        changed = listener
        return watcher
      },
    )
    syncBuiltinESMExports()
    try {
      await inProject('local', () => buildIndex(root))
      storageSet('activeProjectId', 'a')
      startExecutionRootIndexing(root)
      await writeFile(join(root, 'added.ts'), 'added\n')
      assert.ok(changed)
      changed('rename', 'added.ts')
      await inProject('local', () => flushScheduledIndexRebuild(root))
      assert.ok(inProject('local', () => getIndex(root)?.paths.includes('added.ts')))
      assert.equal(
        inProject('a', () => getIndex(root)),
        null,
      )
      await assert.rejects(readFile(commandLog), { code: 'ENOENT' })
      stopExecutionRootIndexing(root)
      assert.equal(
        inProject('local', () => getIndex(root)),
        null,
      )
      assert.equal(closed, true)
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
    }
  })

  it('keeps delayed remote rebuilds separate when two hosts share a root', async () => {
    inProject('a', () => {
      scheduleIndexRebuild(root)
    })
    inProject('b', () => {
      scheduleIndexRebuild(root)
    })
    storageSet('activeProjectId', 'local')
    await Promise.all([
      inProject('a', () => flushScheduledIndexRebuild(root)),
      inProject('b', () => flushScheduledIndexRebuild(root)),
    ])
    assert.deepEqual(
      inProject('a', () => getIndex(root)?.paths),
      ['index-host-a.ts'],
    )
    assert.deepEqual(
      inProject('b', () => getIndex(root)?.paths),
      ['index-host-b.ts'],
    )
    assert.equal(
      inProject('local', () => getIndex(root)),
      null,
    )
  })

  it('evicts the outgoing local snapshot rather than the selected remote host at the same path', () => {
    setWorkspaceIndexPolicyOverrideForTest('never')
    // One oversized retained string is enough to exceed the dormant budget;
    // no large checkout, process output, or extra allocation per path is needed.
    inProject('local', () => {
      setIndexForTest(['x'.repeat(17 * 1024 * 1024)], root)
    })
    inProject('local', () => {
      startWorkspaceIndexing(root)
    })
    inProject('a', () => {
      setIndexForTest(['index-host-a.ts'], root)
    })
    const remote = inProject('a', () => getIndex(root))
    storageSet('activeProjectId', 'a')
    inProject('a', () => {
      startWorkspaceIndexing(root)
    })
    assert.equal(
      inProject('local', () => getIndex(root)),
      null,
    )
    assert.equal(
      inProject('a', () => getIndex(root)),
      remote,
    )
  })

  it('honors a captured local target when a remote project shares the root', async () => {
    storageSet('activeProjectId', 'a')
    setRgAvailableForTest(true)
    // A tiny rg stand-in makes the local branch independent of host tooling.
    await writeFile(join(bin, 'rg'), `#!/bin/sh\nprintf '%s\\n' '${root}/local.ts'\n`, {
      mode: 0o755,
    })
    await inProject('local', () => buildIndex(root))
    assert.deepEqual(
      inProject('local', () => getIndex(root)?.paths),
      ['local.ts'],
    )
    assert.equal(
      inProject('a', () => getIndex(root)),
      null,
    )
    await assert.rejects(readFile(commandLog), { code: 'ENOENT' })
  })
})
