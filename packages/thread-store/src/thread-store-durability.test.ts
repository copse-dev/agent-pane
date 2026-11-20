import assert from 'node:assert/strict'
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import type { Message, Thread } from './thread-types.ts'
import { SPINE_SCHEMA_VERSION, type SpineHookRunLine } from './spine-schema.ts'
import {
  appendHookRun,
  appendMessage,
  createThread,
  loadProjectThreads,
  loadThreadMessages,
  readHookRun,
  recordThreadCommitProduction,
  getThreadMeta,
  saveProjectThread,
  saveProjectThreads,
} from './thread-store.ts'

function thread(id: string, messages: Message[] = []): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function userMsg(id: string, content = `content of ${id}`): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1 }
}

const hookRun: SpineHookRunLine = {
  v: SPINE_SCHEMA_VERSION,
  type: 'hook_run',
  id: 'run-1',
  event: 'beforeShellExecution',
  hookId: './audit.sh',
  executor: 'command',
  startedAt: 1,
  durationMs: 1,
  exitCode: 0,
  parseOk: true,
  decision: {},
  stdout: { ref: 'blobs/run-1.stdout.txt', sha256: 'unchecked' },
}

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

describe('thread store durability', () => {
  let root: string
  let previousRoot: string | undefined
  let eventsPath: string

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-durability-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    eventsPath = join(root, 'proj', 't1', 'events.jsonl')
  })

  afterEach(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  const loadedIds = async (): Promise<string[]> =>
    (await loadThreadMessages('proj', 't1')).map((message) => message.id)

  it('starts a new spine line after an append that failed part-way', async () => {
    await createThread('proj', thread('t1'))
    await appendMessage('proj', 't1', userMsg('u1'))
    const realAppend = fsPromises.appendFile.bind(fsPromises)
    let tear = true
    mock.method(
      fsPromises,
      'appendFile',
      async (
        path: Parameters<typeof fsPromises.appendFile>[0],
        data: Parameters<typeof fsPromises.appendFile>[1],
        options?: Parameters<typeof fsPromises.appendFile>[2],
      ) => {
        if (path === eventsPath && tear && typeof data === 'string') {
          tear = false
          // A full disk: part of the line lands, then the write rejects.
          await realAppend(path, data.slice(0, 24), options)
          throw fsError('ENOSPC')
        }
        await realAppend(path, data, options)
      },
    )
    await assert.rejects(appendMessage('proj', 't1', userMsg('u2')), /ENOSPC/)
    mock.restoreAll()
    assert.equal(readFileSync(eventsPath, 'utf8').endsWith('\n'), false)

    await appendMessage('proj', 't1', userMsg('u2'))
    await appendMessage('proj', 't1', userMsg('u3'))
    assert.deepEqual(await loadedIds(), ['u1', 'u2', 'u3'])
  })

  it('fails a whole-thread save rather than treat an unreadable spine as empty', async () => {
    await createThread('proj', thread('t1', [userMsg('u1')]))
    await appendHookRun('proj', 't1', hookRun, [{ ref: 'blobs/run-1.stdout.txt', contents: 'out' }])
    await recordThreadCommitProduction('proj', 't1', {
      repository: 'github.com/acme/project',
      sha: 'a'.repeat(40),
      eventId: 'commit-1',
      source: 'git-commit',
      createdAt: 1,
    })
    const spineBefore = readFileSync(eventsPath, 'utf8')
    const realOpen = fs.openSync
    for (const unreadable of ['events.jsonl', 'meta.json']) {
      const path = join(root, 'proj', 't1', unreadable)
      mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === path) throw fsError('EMFILE')
        return realOpen(...args)
      })
      syncBuiltinESMExports()
      try {
        await assert.rejects(saveProjectThread('proj', thread('t1', [userMsg('u1')])), /EMFILE/)
      } finally {
        mock.restoreAll()
        syncBuiltinESMExports()
      }
    }
    assert.equal(readFileSync(eventsPath, 'utf8'), spineBefore)
    assert.equal((await readHookRun('proj', 't1', 'run-1'))?.stdout?.text, 'out')
    assert.equal((await getThreadMeta('proj', 't1'))?.commitProductions?.length, 1)

    // The same save succeeds, and still preserves both, once the file is readable.
    await saveProjectThread('proj', thread('t1', [userMsg('u1')]))
    assert.equal((await readHookRun('proj', 't1', 'run-1'))?.stdout?.text, 'out')
    assert.equal((await getThreadMeta('proj', 't1'))?.commitProductions?.length, 1)
  })

  for (const seeded of [true, false]) {
    it(`fails a re-finalized message rather than rewrite an unreadable spine (id cache ${seeded ? 'warm' : 'cold'})`, async () => {
      await createThread('proj', thread('t1', [userMsg('u1'), userMsg('u2')]))
      await appendHookRun('proj', 't1', hookRun, [
        { ref: 'blobs/run-1.stdout.txt', contents: 'out' },
      ])
      if (seeded) await appendMessage('proj', 't1', userMsg('u3'))
      const spineBefore = readFileSync(eventsPath, 'utf8')
      const realOpen = fsPromises.open.bind(fsPromises)
      mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
        if (args[0] === eventsPath) throw fsError('EMFILE')
        return realOpen(...args)
      })
      await assert.rejects(appendMessage('proj', 't1', userMsg('u1', 'edited')), /EMFILE/)
      mock.restoreAll()
      assert.equal(readFileSync(eventsPath, 'utf8'), spineBefore)

      await appendMessage('proj', 't1', userMsg('u1', 'edited'))
      const messages = await loadThreadMessages('proj', 't1')
      assert.deepEqual(
        messages.map((message) => [message.id, message.content]),
        [['u1', 'edited'], ['u2', 'content of u2'], ...(seeded ? [['u3', 'content of u3']] : [])],
      )
      assert.ok(await readHookRun('proj', 't1', 'run-1'))
    })
  }

  it('bounds open files across a whole-project load, not per thread', async () => {
    const count = 34
    for (let t = 0; t < count; t++) {
      const id = `t${String(t)}`
      await saveProjectThread(
        'proj',
        thread(
          id,
          Array.from({ length: count }, (_, m) => userMsg(`${id}-m${String(m)}`)),
        ),
      )
    }
    const realOpen = fsPromises.open.bind(fsPromises)
    let open = 0
    let peak = 0
    mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
      open += 1
      peak = Math.max(peak, open)
      let handle: Awaited<ReturnType<typeof fsPromises.open>>
      try {
        handle = await realOpen(...args)
      } catch (error) {
        open -= 1
        throw error
      }
      const realClose = handle.close.bind(handle)
      handle.close = async (): Promise<void> => {
        await realClose()
        open -= 1
      }
      return handle
    })
    const loaded = await loadProjectThreads('proj')
    mock.restoreAll()
    assert.equal(loaded.length, count)
    assert.ok(loaded.every((entry) => entry.messages.length === count))
    // 34 threads x 34 message files used to hold ~1000 descriptors at once.
    assert.ok(peak <= 32, `expected at most 32 files open at once, saw ${String(peak)}`)
  })

  it('saveProjectThreads leaves reserved non-thread directories alone', async () => {
    await saveProjectThreads('proj', [thread('t1'), thread('t2')])
    const task = join(root, 'proj', 'tasks', 'task-1', 'meta.json')
    const history = join(root, 'proj', 'task-history', 'task-0.json')
    const receipt = join(root, 'proj', 'event-inbox', 'abc.json')
    for (const path of [task, history, receipt]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '{}\n')
    }
    await saveProjectThreads('proj', [thread('t1')])
    assert.ok(!existsSync(join(root, 'proj', 't2')))
    for (const path of [task, history, receipt]) assert.ok(existsSync(path), path)
    assert.deepEqual(
      (await loadProjectThreads('proj')).map((entry) => entry.id),
      ['t1'],
    )
  })
})
