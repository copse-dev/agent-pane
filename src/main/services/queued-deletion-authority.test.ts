import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  promises as fsPromises,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { parseSpineEntries, serializeSpineEntries } from '@shared/threads/spine-schema.ts'
import {
  createThread,
  createThreadWithResult,
  appendMessage,
  acceptReviewedUserMessage,
  saveProjectThread,
  deleteQueuedMessage,
  loadThreadMessages,
  saveAgentHistory,
  updateMeta,
} from './thread-store.ts'

let root = ''
let previousRoot: string | undefined
beforeEach(() => {
  previousRoot = process.env['COPSE_WORKSPACE_DIR']
  root = mkdtempSync(join(tmpdir(), 'copse-queued-deletion-authority-'))
  process.env['COPSE_WORKSPACE_DIR'] = root
})
afterEach(() => {
  if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
  else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
  rmSync(root, { recursive: true, force: true })
})

test('renderer-writable queue membership cannot authorize deletion of an accepted message', async () => {
  const accepted: Thread = {
    id: 'accepted-thread',
    title: 'accepted',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      {
        id: 'accepted-user',
        role: 'user',
        content: 'already accepted prompt',
        toolCalls: [],
        createdAt: 1,
      },
    ],
  }
  await createThread('p', accepted)
  await saveAgentHistory('p', accepted.id, [{ role: 'user', content: 'already accepted prompt' }])
  // This is the existing renderer-writable metadata boundary, not a main-owned grant.
  await updateMeta('p', accepted.id, {
    pendingMessages: [
      { messageId: 'accepted-user', payload: { content: 'already accepted prompt' }, createdAt: 1 },
    ],
  })
  await assert.rejects(deleteQueuedMessage('p', accepted.id, 'accepted-user'))
  assert.deepEqual(
    (await loadThreadMessages('p', accepted.id)).map((message) => message.id),
    ['accepted-user'],
  )
})

function queueSnapshot(): Thread {
  return {
    id: 'queue',
    title: 'queue',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [],
    pendingMessages: [{ messageId: 'queued', payload: { content: 'unsent prompt' }, createdAt: 1 }],
  }
}
const queuedUser = {
  id: 'queued',
  role: 'user',
  content: 'unsent prompt',
  toolCalls: [],
  createdAt: 1,
} as const

function assertStoredUserUnchanged(
  events: string,
  body: string,
  spine: string,
  text: string,
): void {
  assert.equal(readFileSync(events, 'utf8'), spine)
  assert.equal(readFileSync(body, 'utf8'), text)
}

for (const role of ['assistant', 'error', 'user'] as const) {
  test(`accepted user identity rejects renderer ${role} replacement before files or receipts`, async () => {
    await persistUnaccepted()
    await acceptReviewedUserMessage('p', 'queue', { messageId: 'queued', claim: () => true })
    const events = join(root, 'p', 'queue', 'events.jsonl')
    const body = join(root, 'p', 'queue', 'messages', 'queued.md')
    const spine = readFileSync(events, 'utf8')
    const text = readFileSync(body, 'utf8')
    const minted: string[] = []
    await assert.rejects(
      appendMessage(
        'p',
        'queue',
        { ...queuedUser, role, content: 'forged accepted body', toolCalls: [] },
        {
          source: 'renderer',
          onUnacceptedCreated: (id) => {
            minted.push(id)
          },
        },
      ),
      /accepted user message cannot be replaced/,
    )
    assertStoredUserUnchanged(events, body, spine, text)
    assert.deepEqual(minted, [])
    assert.deepEqual(
      (await loadThreadMessages('p', 'queue')).map(({ role, content }) => ({ role, content })),
      [{ role: 'user', content: 'unsent prompt' }],
    )
  })

  test(`legacy user identity rejects renderer ${role} replacement after a cold load`, async () => {
    await persistUnaccepted()
    const events = join(root, 'p', 'queue', 'events.jsonl')
    writeFileSync(
      events,
      serializeSpineEntries(
        parseSpineEntries(readFileSync(events, 'utf8')).filter(
          (entry) => entry.line?.type !== 'user_message_lifecycle',
        ),
      ),
    )
    const coldRoot = join(root, 'legacy-role-cold')
    mkdirSync(join(coldRoot, 'p'), { recursive: true })
    cpSync(join(root, 'p', 'queue'), join(coldRoot, 'p', 'queue'), { recursive: true })
    process.env['COPSE_WORKSPACE_DIR'] = coldRoot
    const coldEvents = join(coldRoot, 'p', 'queue', 'events.jsonl')
    const body = join(coldRoot, 'p', 'queue', 'messages', 'queued.md')
    const spine = readFileSync(coldEvents, 'utf8')
    const text = readFileSync(body, 'utf8')
    await assert.rejects(
      appendMessage(
        'p',
        'queue',
        { ...queuedUser, role, content: 'forged legacy body', toolCalls: [] },
        { source: 'renderer' },
      ),
      /accepted user message cannot be replaced/,
    )
    assertStoredUserUnchanged(coldEvents, body, spine, text)
  })

  test(`reserved accepted identity rejects renderer ${role} creation`, async () => {
    await createThread('p', queueSnapshot())
    const id = await acceptReviewedUserMessage('p', 'queue')
    const events = join(root, 'p', 'queue', 'events.jsonl')
    const spine = readFileSync(events, 'utf8')
    await assert.rejects(
      appendMessage(
        'p',
        'queue',
        { ...queuedUser, id, role, content: 'forged reserved body', toolCalls: [] },
        { source: 'renderer' },
      ),
      /accepted user message cannot be replaced/,
    )
    assert.equal(readFileSync(events, 'utf8'), spine)
    assert.equal(existsSync(join(root, 'p', 'queue', 'messages', `${id}.md`)), false)
  })
}

for (const role of ['assistant', 'error'] as const) {
  test(`unaccepted user identity rejects renderer ${role} role switch`, async () => {
    await persistUnaccepted()
    const events = join(root, 'p', 'queue', 'events.jsonl')
    const body = join(root, 'p', 'queue', 'messages', 'queued.md')
    const spine = readFileSync(events, 'utf8')
    const text = readFileSync(body, 'utf8')
    await assert.rejects(
      appendMessage(
        'p',
        'queue',
        { ...queuedUser, role, content: 'forged role', toolCalls: [] },
        { source: 'renderer' },
      ),
      /cannot change.*user role/,
    )
    assertStoredUserUnchanged(events, body, spine, text)
  })

  for (const state of ['unaccepted', 'accepted', 'pruned-accepted'] as const) {
    test(`full save cannot replace ${state} user identity with ${role}`, async () => {
      await persistUnaccepted()
      if (state !== 'unaccepted')
        await acceptReviewedUserMessage('p', 'queue', { messageId: 'queued', claim: () => true })
      if (state === 'pruned-accepted') await saveProjectThread('p', queueSnapshot())
      const events = join(root, 'p', 'queue', 'events.jsonl')
      const spine = readFileSync(events, 'utf8')
      const body = join(root, 'p', 'queue', 'messages', 'queued.md')
      const beforeBody = existsSync(body) ? readFileSync(body, 'utf8') : undefined
      await assert.rejects(
        saveProjectThread('p', {
          ...queueSnapshot(),
          messages: [{ ...queuedUser, role, content: 'forged full save', toolCalls: [] }],
        }),
        /cannot change.*user role/,
      )
      assert.equal(readFileSync(events, 'utf8'), spine)
      if (beforeBody === undefined) assert.equal(existsSync(body), false)
      else assert.equal(readFileSync(body, 'utf8'), beforeBody)
      if (state !== 'pruned-accepted')
        assert.equal((await loadThreadMessages('p', 'queue'))[0]?.role, 'user')
    })
  }
}

test('trusted main canonical user reconciliation and renderer assistant streaming stay supported', async () => {
  await persistUnaccepted()
  await appendMessage(
    'p',
    'queue',
    { ...queuedUser, content: 'edited before review', toolCalls: [] },
    { source: 'renderer' },
  )
  await acceptReviewedUserMessage('p', 'queue', { messageId: 'queued', claim: () => true })
  await appendMessage('p', 'queue', {
    ...queuedUser,
    content: 'native reviewed canonical text',
    toolCalls: [],
  })
  const assistant = {
    ...queuedUser,
    id: 'reply',
    role: 'assistant',
    content: 'partial',
    toolCalls: [],
  } as const
  await appendMessage('p', 'queue', { ...assistant, toolCalls: [] }, { source: 'renderer' })
  await appendMessage(
    'p',
    'queue',
    { ...assistant, content: 'complete reply', toolCalls: [] },
    { source: 'renderer' },
  )
  await assert.rejects(
    appendMessage(
      'p',
      'queue',
      { ...queuedUser, id: 'reply', toolCalls: [] },
      { source: 'renderer' },
    ),
    /cannot change.*user role/,
  )
  await saveProjectThread('p', {
    ...queueSnapshot(),
    messages: [
      { ...queuedUser, content: 'main reviewed history edit', toolCalls: [] },
      { ...assistant, content: 'complete reply', toolCalls: [] },
    ],
  })
  assert.deepEqual(
    (await loadThreadMessages('p', 'queue')).map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: 'main reviewed history edit' },
      { role: 'assistant', content: 'complete reply' },
    ],
  )
})

async function persistUnaccepted(): Promise<void> {
  await createThread('p', queueSnapshot())
  await appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, { source: 'renderer' })
}

test('concurrent duplicate appends report one creation and mint one receipt inside the queue', async () => {
  await createThread('p', queueSnapshot())
  const minted: string[] = []
  const options = {
    source: 'renderer',
    onUnacceptedCreated: (id: string): void => {
      minted.push(id)
    },
  } as const
  const results = await Promise.all([
    appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, options),
    appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, options),
  ])
  assert.deepEqual(results, [
    { created: true, unacceptedUser: true },
    { created: false, unacceptedUser: true },
  ])
  assert.deepEqual(minted, ['queued'])
  assert.equal((await loadThreadMessages('p', 'queue')).length, 1)
})

test('a retirement queued behind fresh append revokes its receipt before any late result handling', async () => {
  await createThread('p', queueSnapshot())
  const receipts = new Set<string>()
  const append = appendMessage(
    'p',
    'queue',
    { ...queuedUser, toolCalls: [] },
    {
      source: 'renderer',
      onUnacceptedCreated: (id): void => {
        receipts.add(id)
      },
    },
  )
  const retire = deleteQueuedMessage('p', 'queue', 'queued', (): void => {
    receipts.clear()
  })
  await Promise.all([append, retire])
  assert.equal(receipts.size, 0)
  assert.deepEqual(await loadThreadMessages('p', 'queue'), [])
  await assert.rejects(
    appendMessage(
      'p',
      'queue',
      { ...queuedUser, toolCalls: [] },
      {
        source: 'renderer',
        onUnacceptedCreated: (id): void => {
          receipts.add(id)
        },
      },
    ),
    /deleted queued message/,
  )
  assert.equal(receipts.size, 0)
})

test('acceptance winning the shared queue rejects retirement even with forged pending metadata', async () => {
  await persistUnaccepted()
  await saveAgentHistory('p', 'queue', [{ role: 'user', content: 'previous accepted context' }])
  const historyPath = join(root, 'p', 'queue', 'agent-history.json')
  const history = readFileSync(historyPath, 'utf8')
  let claims = 0
  const accepted = acceptReviewedUserMessage('p', 'queue', {
    messageId: 'queued',
    claim: (): boolean => {
      claims++
      return true
    },
  })
  const retired = deleteQueuedMessage('p', 'queue', 'queued')
  const result = await Promise.allSettled([accepted, retired])
  assert.deepEqual(result[0], { status: 'fulfilled', value: 'queued' })
  assert.equal(result[1].status, 'rejected')
  assert.equal(claims, 1)
  await updateMeta('p', 'queue', { pendingMessages: queueSnapshot().pendingMessages ?? [] })
  await assert.rejects(deleteQueuedMessage('p', 'queue', 'queued'), /accepted user message/)
  assert.equal(readFileSync(historyPath, 'utf8'), history)
})

test('retirement winning revokes receipts and a later protected acceptance reserves a fresh main ID', async () => {
  await persistUnaccepted()
  const receipts = new Set(['sender-one', 'sender-two'])
  let claims = 0
  const retired = deleteQueuedMessage('p', 'queue', 'queued', (): void => {
    receipts.clear()
  })
  const accepted = acceptReviewedUserMessage('p', 'queue', {
    messageId: 'queued',
    claim: (): boolean => {
      claims++
      return true
    },
  })
  await retired
  const fresh = await accepted
  assert.notEqual(fresh, 'queued')
  assert.match(fresh, /^[0-9a-f-]{36}$/)
  assert.equal(claims, 0)
  assert.equal(receipts.size, 0)
  assert.deepEqual(await loadThreadMessages('p', 'queue'), [])
  const result = await appendMessage('p', 'queue', { ...queuedUser, id: fresh, toolCalls: [] })
  assert.deepEqual(result, { created: false, unacceptedUser: false })
  assert.deepEqual(
    (await loadThreadMessages('p', 'queue')).map((message) => message.id),
    [fresh],
  )
})

test('a failed one-use claim cannot reuse an optimistic ID, leaving that unsent note deletable', async () => {
  await persistUnaccepted()
  const fresh = await acceptReviewedUserMessage('p', 'queue', {
    messageId: 'queued',
    claim: (): boolean => false,
  })
  assert.notEqual(fresh, 'queued')
  await deleteQueuedMessage('p', 'queue', 'queued')
  assert.deepEqual(await loadThreadMessages('p', 'queue'), [])
})

test('accepted status survives a cold source load and stale full save after its message was pruned', async () => {
  await persistUnaccepted()
  await acceptReviewedUserMessage('p', 'queue', { messageId: 'queued', claim: (): boolean => true })
  await saveProjectThread('p', queueSnapshot())
  const coldRoot = join(root, 'cold')
  mkdirSync(join(coldRoot, 'p'), { recursive: true })
  cpSync(join(root, 'p', 'queue'), join(coldRoot, 'p', 'queue'), { recursive: true })
  process.env['COPSE_WORKSPACE_DIR'] = coldRoot
  const minted: string[] = []
  await assert.rejects(
    appendMessage(
      'p',
      'queue',
      { ...queuedUser, toolCalls: [] },
      {
        source: 'renderer',
        onUnacceptedCreated: (id): void => {
          minted.push(id)
        },
      },
    ),
    /accepted user message cannot be replaced/,
  )
  assert.equal(minted.length, 0)
  await assert.rejects(deleteQueuedMessage('p', 'queue', 'queued'), /accepted user message/)
})

test('legacy accepted IDs are retained conservatively when a full save drops their message', async () => {
  const accepted: Thread = { ...queueSnapshot(), messages: [{ ...queuedUser, toolCalls: [] }] }
  await createThread('p', accepted)
  const events = join(root, 'p', 'queue', 'events.jsonl')
  // A real pre-lifecycle source has no main-owned marker. Reopen a fresh source
  // directory so the test does not accidentally reuse its earlier cache entry.
  writeFileSync(
    events,
    serializeSpineEntries(
      parseSpineEntries(readFileSync(events, 'utf8')).filter(
        (entry) => entry.line?.type !== 'user_message_lifecycle',
      ),
    ),
  )
  const coldRoot = join(root, 'legacy-cold')
  mkdirSync(join(coldRoot, 'p'), { recursive: true })
  cpSync(join(root, 'p', 'queue'), join(coldRoot, 'p', 'queue'), { recursive: true })
  process.env['COPSE_WORKSPACE_DIR'] = coldRoot
  await assert.rejects(deleteQueuedMessage('p', 'queue', 'queued'), /Only a saved queued/)
  await saveProjectThread('p', queueSnapshot())
  let minted = false
  await assert.rejects(
    appendMessage(
      'p',
      'queue',
      { ...queuedUser, toolCalls: [] },
      {
        source: 'renderer',
        onUnacceptedCreated: (): void => {
          minted = true
        },
      },
    ),
    /accepted user message cannot be replaced/,
  )
  assert.equal(minted, false)
})

test('create-with-result preserves idempotency and never remints a first-message receipt', async () => {
  const value: Thread = { ...queueSnapshot(), messages: [{ ...queuedUser, toolCalls: [] }] }
  const minted: string[] = []
  const options = {
    source: 'renderer',
    onUnacceptedCreated: (id: string): void => {
      minted.push(id)
    },
  } as const
  assert.equal(await createThreadWithResult('p', value, options), true)
  assert.equal(await createThreadWithResult('p', value, options), false)
  const append = await appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, options)
  assert.deepEqual(append, { created: false, unacceptedUser: true })
  assert.deepEqual(minted, ['queued'])
})

for (const initial of ['two-users', 'assistant-and-user'] as const) {
  test(`renderer-created ${initial} history is rejected instead of minting accepted identities`, async () => {
    const first =
      initial === 'two-users'
        ? { ...queuedUser, id: 'first-user', toolCalls: [] }
        : ({
            id: 'assistant',
            role: 'assistant',
            content: 'seeded reply',
            toolCalls: [],
            createdAt: 1,
          } as const)
    const value: Thread = {
      ...queueSnapshot(),
      messages: [
        { ...first, toolCalls: [] },
        { ...queuedUser, toolCalls: [] },
      ],
    }
    const minted: string[] = []
    const options = {
      source: 'renderer',
      onUnacceptedCreated: (id: string): void => {
        minted.push(id)
      },
    } as const
    await assert.rejects(
      createThreadWithResult('p', value, options),
      /only one unaccepted user message/,
    )
    assert.deepEqual(minted, [])
    assert.deepEqual(await loadThreadMessages('p', 'queue'), [])
  })
}

test('duplicate concurrent fresh single-user creates mint exactly one receipt without overwriting', async () => {
  const value: Thread = { ...queueSnapshot(), messages: [{ ...queuedUser, toolCalls: [] }] }
  const minted: string[] = []
  const options = {
    source: 'renderer',
    onUnacceptedCreated: (id: string): void => {
      minted.push(id)
    },
  } as const
  assert.deepEqual(
    await Promise.all([
      createThreadWithResult('p', value, options),
      createThreadWithResult('p', value, options),
    ]),
    [true, false],
  )
  assert.deepEqual(minted, ['queued'])
  await deleteQueuedMessage('p', 'queue', 'queued')
  assert.deepEqual(await loadThreadMessages('p', 'queue'), [])
})

test('renderer append cannot create an orphan thread before its authoritative create', async () => {
  const minted: string[] = []
  await assert.rejects(
    appendMessage(
      'p',
      'append-before-create',
      { ...queuedUser, toolCalls: [] },
      {
        source: 'renderer',
        onUnacceptedCreated: (id): void => {
          minted.push(id)
        },
      },
    ),
    /Thread is not persisted yet/,
  )
  assert.equal(existsSync(join(root, 'p', 'append-before-create')), false)
  assert.equal(minted.length, 0)

  const created = await createThreadWithResult(
    'p',
    {
      ...queueSnapshot(),
      id: 'append-before-create',
      messages: [{ ...queuedUser, toolCalls: [] }],
    },
    {
      source: 'renderer',
      onUnacceptedCreated: (id): void => {
        minted.push(id)
      },
    },
  )
  assert.equal(created, true)
  assert.deepEqual(minted, ['queued'])
})

test('renderer create cannot bless message data already present in an orphan directory', async () => {
  const dir = join(root, 'p', 'orphan')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"unknown","forged":true}\n')
  const minted: string[] = []
  await assert.rejects(
    createThreadWithResult(
      'p',
      {
        ...queueSnapshot(),
        id: 'orphan',
        messages: [{ ...queuedUser, toolCalls: [] }],
      },
      {
        source: 'renderer',
        onUnacceptedCreated: (id): void => {
          minted.push(id)
        },
      },
    ),
    /existing store data/,
  )
  assert.deepEqual(minted, [])
  assert.equal(
    readFileSync(join(dir, 'events.jsonl'), 'utf8'),
    '{"type":"unknown","forged":true}\n',
  )
})

for (const terminal of ['accepted', 'retired'] as const) {
  test(`cold ${terminal} identity cannot become fresh after an unreadable spine and a transient retry`, async () => {
    await persistUnaccepted()
    if (terminal === 'accepted') {
      await acceptReviewedUserMessage('p', 'queue', {
        messageId: 'queued',
        claim: (): boolean => true,
      })
    } else {
      await deleteQueuedMessage('p', 'queue', 'queued')
    }
    const coldRoot = join(root, `read-failure-${terminal}`)
    mkdirSync(join(coldRoot, 'p'), { recursive: true })
    cpSync(join(root, 'p', 'queue'), join(coldRoot, 'p', 'queue'), { recursive: true })
    process.env['COPSE_WORKSPACE_DIR'] = coldRoot
    const events = join(coldRoot, 'p', 'queue', 'events.jsonl')
    const before = readFileSync(events, 'utf8')
    const messagePath = join(coldRoot, 'p', 'queue', 'messages', 'queued.md')
    const beforeMessage = readFileSync(messagePath, 'utf8')
    const realRead = fsPromises.open
    let attempts = 0
    const read = mock.method(
      fsPromises,
      'open',
      async (...args: Parameters<typeof realRead>): ReturnType<typeof realRead> => {
        if (String(args[0]) === events) {
          attempts++
          throw Object.assign(new Error('simulated authority read failure'), { code: 'EACCES' })
        }
        return realRead(...args)
      },
    )
    const minted: string[] = []
    const options = {
      source: 'renderer',
      onUnacceptedCreated: (id: string): void => {
        minted.push(id)
      },
    } as const
    try {
      await assert.rejects(
        appendMessage(
          'p',
          'queue',
          { ...queuedUser, content: 'must not replace', toolCalls: [] },
          options,
        ),
        /simulated authority read failure/,
      )
    } finally {
      read.mock.restore()
    }
    assert.ok(attempts > 0, 'the actual authority-open boundary must be exercised')
    assert.equal(readFileSync(events, 'utf8'), before)
    assert.equal(readFileSync(messagePath, 'utf8'), beforeMessage)
    assert.deepEqual(minted, [])
    if (terminal === 'retired') {
      await assert.rejects(
        appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, options),
        /deleted queued message/,
      )
    } else {
      await assert.rejects(
        appendMessage('p', 'queue', { ...queuedUser, toolCalls: [] }, options),
        /accepted user message cannot be replaced/,
      )
    }
    assert.deepEqual(minted, [])
  })
}

test('a failed existing-message mutation reread preserves the spine, body and receipt state', async () => {
  await persistUnaccepted()
  const events = join(root, 'p', 'queue', 'events.jsonl')
  const messagePath = join(root, 'p', 'queue', 'messages', 'queued.md')
  const before = readFileSync(events, 'utf8')
  const beforeMessage = readFileSync(messagePath, 'utf8')
  const realRead = fsPromises.open
  let attempts = 0
  const read = mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof realRead>): ReturnType<typeof realRead> => {
      if (String(args[0]) === events) {
        attempts++
        throw Object.assign(new Error('simulated mutation reread failure'), { code: 'EIO' })
      }
      return realRead(...args)
    },
  )
  let minted = false
  try {
    await assert.rejects(
      appendMessage(
        'p',
        'queue',
        { ...queuedUser, content: 'must not replace', toolCalls: [] },
        {
          source: 'renderer',
          onUnacceptedCreated: (): void => {
            minted = true
          },
        },
      ),
      /simulated mutation reread failure/,
    )
  } finally {
    read.mock.restore()
  }
  assert.ok(attempts > 0, 'the actual authority-open boundary must be exercised')
  assert.equal(readFileSync(events, 'utf8'), before)
  assert.equal(readFileSync(messagePath, 'utf8'), beforeMessage)
  assert.equal(minted, false)
})
