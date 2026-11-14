import assert from 'node:assert/strict'
import { beforeEach, afterEach, mock, test } from 'node:test'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  appendFileSync,
  cpSync,
  mkdirSync,
  promises as fsPromises,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { parseSpineEntries } from '@copse/thread-store/spine-schema.ts'
import type { Message, StreamChunk } from '@shared/types'
import { AgentDispatcher, type AgentDispatcherDependencies } from './agent-dispatcher.ts'
import { ToolRegistry } from './tool-registry.ts'
import {
  acceptExactReviewedUserMessage,
  acceptReviewedUserMessage,
  appendMessage,
  appendHookRun,
  createThread,
  deleteQueuedMessage,
  loadThreadMessages,
  getProjectThread,
  closeThreadStoreIndexes,
} from './thread-store.ts'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copse-strict-reviewed-'))
  configureThreadStore({ workspaceRoot: () => root })
})
afterEach(() => {
  closeThreadStoreIndexes()
  configureThreadStore()
  rmSync(root, { recursive: true, force: true })
})

async function persistedPrompt(): Promise<Message> {
  await createThread('p', {
    id: 't',
    title: 'Phone prompt',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [],
    pendingMessages: [
      { messageId: 'phone-message', payload: { content: 'Reviewed phone prompt' }, createdAt: 1 },
    ],
  })
  await appendMessage(
    'p',
    't',
    {
      id: 'phone-message',
      role: 'user',
      content: 'Reviewed phone prompt',
      createdAt: 1,
      toolCalls: [],
    },
    { source: 'renderer' },
  )
  const [message] = await loadThreadMessages('p', 't')
  assert.ok(message)
  return message
}

/** Match the phone dispatcher's required string result; null cancels before provider entry. */
async function acceptForDispatch(message: Message, claim: () => boolean): Promise<string> {
  const id = await acceptExactReviewedUserMessage('p', 't', { message, claim })
  if (id === null) throw new Error('Reviewed user message was retired or changed')
  return id
}

function acceptedIds(): string[] {
  const raw = readFileSync(join(root, 'p', 't', 'events.jsonl'), 'utf8')
  return parseSpineEntries(raw).flatMap(({ line }) =>
    line?.type === 'user_message_lifecycle' && line.state === 'accepted' ? [line.id] : [],
  )
}

test('accepts the exact existing reviewed identity once and preserves its saved content', async () => {
  const message = await persistedPrompt()
  let claims = 0
  assert.equal(
    await acceptForDispatch(message, (): boolean => {
      claims++
      return true
    }),
    message.id,
  )
  assert.equal(claims, 1)
  assert.deepEqual(acceptedIds(), [message.id])
  assert.deepEqual(await loadThreadMessages('p', 't'), [message])
  await assert.rejects(
    acceptForDispatch(message, () => assert.fail('No replay claim')),
    /Reviewed user message/,
  )
  assert.deepEqual(acceptedIds(), [message.id])
})

test('real Delete between optimistic validation and queued acceptance emits nothing and cannot mint a fresh ID', async () => {
  // Main has already validated this saved optimistic message against its grant.
  const snapshot = await persistedPrompt()
  const events = join(root, 'p', 't', 'events.jsonl')
  const deletionAtRename = Promise.withResolvers<undefined>()
  const releaseDeletion = Promise.withResolvers<undefined>()
  const acceptanceQueued = Promise.withResolvers<undefined>()
  const realRename = fsPromises.rename
  const rename = mock.method(
    fsPromises,
    'rename',
    async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
      if (String(args[1]) === events) {
        deletionAtRename.resolve(undefined)
        await releaseDeletion.promise
      }
      return realRename(...args)
    },
  )
  let providerEntries = 0
  let claims = 0
  const emitted: StreamChunk[] = []
  const dependencies: AgentDispatcherDependencies = {
    loadPlan: async () => null,
    loadHistory: async () => [],
    saveHistory: async () => {},
    recoverHistory: async () => [],
    loadEpoch: async () => null,
    saveEpoch: async () => {},
    appendMachineContinuation: async () => {},
    now: () => 1,
    createId: () => 'audit',
    prepareExecutionContext: async () => ({
      projectId: 'p',
      threadId: 't',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }),
    transcriptLength: async () => 0,
    isScheduledAutomationRun: () => false,
    run: async () => {
      providerEntries++
      return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
    },
  }
  const dispatcher = new AgentDispatcher(
    {
      emit: (_id, chunk): void => {
        emitted.push(chunk)
      },
    },
    new ToolRegistry(),
    dependencies,
  )
  const retired = deleteQueuedMessage('p', 't', snapshot.id)
  try {
    await deletionAtRename.promise
    const rejected = assert.rejects(
      dispatcher.dispatch({
        projectId: 'p',
        threadId: 't',
        payload: { userContent: snapshot.content, invokedSkills: [], priorTodos: [] },
        protectedHistory: [],
        protectedPlan: null,
        protectedHumanStart: {
          content: snapshot.content,
          acceptMessageId: (): Promise<string> => {
            acceptanceQueued.resolve(undefined)
            // Even a still-valid retained claim cannot rescue a retired ID.
            return acceptForDispatch(snapshot, (): boolean => {
              claims++
              return true
            })
          },
        },
      }),
      /Reviewed user message/,
    )
    await acceptanceQueued.promise
    releaseDeletion.resolve(undefined)
    await retired
    await rejected
  } finally {
    releaseDeletion.resolve(undefined)
    await retired
    rename.mock.restore()
  }
  assert.equal(providerEntries, 0)
  assert.equal(claims, 0)
  assert.deepEqual(emitted, [])
  assert.deepEqual(acceptedIds(), [])
  assert.deepEqual(await loadThreadMessages('p', 't'), [])
  const cold = join(root, 'cold')
  mkdirSync(join(cold, 'p'), { recursive: true })
  cpSync(join(root, 'p', 't'), join(cold, 'p', 't'), { recursive: true })
  closeThreadStoreIndexes()
  configureThreadStore({ workspaceRoot: () => cold })
  const reloaded = await getProjectThread('p', 't')
  assert.ok(reloaded)
  assert.deepEqual(reloaded.messages, [])
  assert.deepEqual(reloaded.pendingMessages ?? [], [])
})

test('strict acceptance winning the project queue prevents later Delete and accepts no replacement identity', async () => {
  const message = await persistedPrompt()
  const accepted = acceptForDispatch(message, (): boolean => true)
  const deleted = assert.rejects(deleteQueuedMessage('p', 't', message.id), /accepted user message/)
  assert.equal(await accepted, message.id)
  await deleted
  assert.deepEqual(acceptedIds(), [message.id])
})

test('a changed prompt after the preliminary read cannot consume a claim or become accepted', async () => {
  const snapshot = await persistedPrompt()
  await appendMessage(
    'p',
    't',
    { ...snapshot, content: 'Renderer changed the prompt' },
    { source: 'renderer' },
  )
  const before = readFileSync(join(root, 'p', 't', 'events.jsonl'), 'utf8')
  await assert.rejects(
    acceptForDispatch(snapshot, () => assert.fail('No changed-source claim')),
    /Reviewed user message/,
  )
  assert.equal(readFileSync(join(root, 'p', 't', 'events.jsonl'), 'utf8'), before)
  assert.deepEqual(acceptedIds(), [])
})

test('a failed one-use claim rejects without reserving a fresh accepted identity', async () => {
  const message = await persistedPrompt()
  await assert.rejects(
    acceptForDispatch(message, (): boolean => false),
    /Reviewed user message/,
  )
  assert.deepEqual(acceptedIds(), [])
  await deleteQueuedMessage('p', 't', message.id)
})

test('strict acceptance rejects an incomplete authoritative spine without rewriting it', async () => {
  const message = await persistedPrompt()
  const events = join(root, 'p', 't', 'events.jsonl')
  appendFileSync(events, '{"type":"user_message_lifecycle",')
  const before = readFileSync(events, 'utf8')
  await assert.rejects(
    acceptForDispatch(message, () => assert.fail('No incomplete-source claim')),
    /Reviewed user message/,
  )
  assert.equal(readFileSync(events, 'utf8'), before)
  assert.deepEqual(acceptedIds(), [])
})

test('ordinary separately reviewed desktop acceptance retains its fresh-ID fallback', async () => {
  const message = await persistedPrompt()
  await deleteQueuedMessage('p', 't', message.id)
  const fresh = await acceptReviewedUserMessage('p', 't', {
    messageId: message.id,
    claim: () => assert.fail('No retired-ID claim'),
  })
  assert.notEqual(fresh, message.id)
  assert.deepEqual(acceptedIds(), [fresh])
})

test('only derived hook audit cards may change after the Main prompt snapshot', async () => {
  const message = await persistedPrompt()
  await appendHookRun('p', 't', {
    v: 1,
    type: 'hook_run',
    id: 'audit',
    hookId: 'test-audit',
    event: 'beforeSubmitPrompt',
    executor: 'command',
    startedAt: 2,
    durationMs: 1,
    exitCode: 0,
    parseOk: true,
    decision: {},
    stdout: { ref: 'blobs/audit.stdout.txt', sha256: 'x' },
    stderr: { ref: 'blobs/audit.stderr.txt', sha256: 'y' },
  })
  assert.equal((await loadThreadMessages('p', 't'))[0]?.hookCards?.length, 1)
  assert.equal(await acceptForDispatch(message, (): boolean => true), message.id)
  assert.equal((await loadThreadMessages('p', 't'))[0]?.hookCards?.length, 1)
  assert.deepEqual(acceptedIds(), [message.id])
})

test('the queued acceptance snapshot is detached from later caller mutation', async () => {
  const message = await persistedPrompt()
  const accepted = acceptForDispatch(message, (): boolean => true)
  message.content = 'Mutate caller object while acceptance is queued'
  assert.equal(await accepted, message.id)
  assert.equal((await loadThreadMessages('p', 't'))[0]?.content, 'Reviewed phone prompt')
})
