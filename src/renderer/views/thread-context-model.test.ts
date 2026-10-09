import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message, Thread } from '@shared/types'
import { deriveThreadContext } from './thread-context-model.ts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const pr = {
  owner: 'acme',
  repo: 'widget',
  number: 42,
  url: 'https://github.com/acme/widget/pull/42',
}

function message(id: string, content: string, fields: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, toolCalls: [], createdAt: 1, ...fields }
}

function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }
}

const project = { name: 'Widgets', path: '/work/widgets' }

test('derives repos, deduplicated links, subagents and side chats for a thread', () => {
  const other = thread(ID, { title: 'Release planning' })
  const main = thread('main', {
    prRefs: [pr],
    prProductions: [{ pr, eventId: 'e', source: 'pr-create', createdAt: 1 }],
    gitBranch: 'feature/x',
    messages: [
      message('m1', `See https://docs.example.com/a and copse://thread/${ID} and ${pr.url}`),
      message('m2', 'again https://docs.example.com/a#frag', {
        toolCalls: [
          {
            id: 't',
            name: 'explore',
            args: {},
            status: 'done',
            result: '',
            subagent: {
              id: 'sa',
              kind: 'explore',
              status: 'running',
              prompt: 'Find the flaky wait\nmore',
              summary: null,
              messages: [],
              model: 'acp:claude-acp#haiku',
            },
          },
        ],
      }),
    ],
  })
  const side = thread('side', {
    title: 'Why waitFor?',
    createdAt: 5,
    sideChat: { parentThreadId: 'main', anchorMessageId: 'm1' },
    unreadAt: 9,
  })
  const archived = thread('old', {
    createdAt: 2,
    archivedAt: 3,
    sideChat: { parentThreadId: 'main', anchorMessageId: 'm1' },
  })

  const model = deriveThreadContext({
    thread: main,
    project,
    threads: [main, other, side, archived],
    mentionedIn: [{ threadId: 'x', title: 'Mentions main' }],
  })

  assert.deepEqual(model.repos, [
    { name: 'Widgets', path: '/work/widgets', branch: 'feature/x', checkout: 'shared' },
  ])
  assert.deepEqual(
    model.links.map((link) => [link.kind, link.label]),
    [
      ['pr', 'acme/widget#42'],
      // Order of appearance in the transcript; the panel groups them by kind.
      ['url', 'docs.example.com/a'],
      ['thread', 'Release planning'],
    ],
  )
  assert.deepEqual(model.subagents, [
    {
      id: 'sa',
      kind: 'explore',
      status: 'running',
      prompt: 'Find the flaky wait',
      model: 'acp:claude-acp#haiku',
    },
  ])
  // Active side chats first, archived after.
  assert.deepEqual(
    model.sideChats.map((row) => [row.id, row.archived, row.unread]),
    [
      ['side', false, true],
      ['old', true, false],
    ],
  )
  assert.deepEqual(model.mentionedIn, [{ threadId: 'x', title: 'Mentions main' }])
  assert.equal(model.sideOf, undefined)
})

test('an unloaded transcript falls back to recorded links and shows no subagents', () => {
  const lazy = thread('lazy', {
    messagesLoaded: false,
    links: [{ kind: 'url', target: 'https://recorded.example/' }],
  })
  const model = deriveThreadContext({ thread: lazy, project, threads: [lazy] })
  assert.deepEqual(
    model.links.map((link) => link.target),
    ['https://recorded.example/'],
  )
  assert.deepEqual(model.subagents, [])
})

test('flags a thread link whose target is outside the project', () => {
  const t = thread('t', { messages: [message('m', `copse://thread/${ID}`)] })
  const [link] = deriveThreadContext({ thread: t, project, threads: [t] }).links
  assert.equal(link?.unresolved, true)
})

test('a side chat reports its parent and the message it branched from', () => {
  const parent = thread('main', {
    messages: [message('m1', 'The race is in waitForExist\ndetails')],
  })
  const side = thread('side', { sideChat: { parentThreadId: 'main', anchorMessageId: 'm1' } })
  const model = deriveThreadContext({ thread: side, project, threads: [parent, side] })
  assert.deepEqual(model.sideOf, {
    parentThreadId: 'main',
    parentTitle: 'main',
    anchorExcerpt: 'The race is in waitForExist',
  })
  assert.deepEqual(model.sideChats, [])
})

test('a worktree thread reports its own branch', () => {
  const t = thread('t', {
    worktree: {
      path: '/x',
      branch: 'copse/t',
      baseBranch: 'main',
      baseCommit: 'a',
      createdAt: 1,
      seededFromDirtyProject: false,
    },
  })
  assert.equal(
    deriveThreadContext({ thread: t, project, threads: [t] }).repos[0]?.checkout,
    'worktree',
  )
  assert.equal(
    deriveThreadContext({ thread: t, project, threads: [t] }).repos[0]?.branch,
    'copse/t',
  )
})
