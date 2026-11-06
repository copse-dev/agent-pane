import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendToken,
  createThread,
  getThreadById,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import {
  applyTranscriptRowPlan,
  planTranscriptRows,
  relinkReadingAnchor,
  removeTranscriptRow,
  type TranscriptRow,
  transcriptRowSignature,
  wantedTranscriptRows,
} from './transcript-rows.ts'

function rows(spec: string): TranscriptRow[] {
  // "a b:2 c" → keys a, b, c with signatures '1', '2', '1'.
  return spec
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      const [key = '', signature = '1'] = part.split(':')
      return { key, signature }
    })
}

describe('planTranscriptRows', () => {
  it('keeps every row when nothing changed', () => {
    assert.deepEqual(planTranscriptRows(rows('a b c'), rows('a b c')), {
      kind: 'patch',
      ops: [],
      kept: 3,
    })
  })

  it('appends new rows at the tail and keeps the rest', () => {
    assert.deepEqual(planTranscriptRows(rows('a b'), rows('a b c d')), {
      kind: 'patch',
      ops: [
        { kind: 'insert', key: 'c', before: null },
        { kind: 'insert', key: 'd', before: null },
      ],
      kept: 2,
    })
  })

  it('inserts a row between kept rows before its next surviving neighbour', () => {
    assert.deepEqual(planTranscriptRows(rows('a c'), rows('a b c')), {
      kind: 'patch',
      ops: [{ kind: 'insert', key: 'b', before: 'c' }],
      kept: 2,
    })
  })

  it('replaces only rows whose signature changed', () => {
    assert.deepEqual(planTranscriptRows(rows('a b c'), rows('a b:2 c')), {
      kind: 'patch',
      ops: [{ kind: 'replace', key: 'b' }],
      kept: 2,
    })
  })

  it('removes rows that left the transcript, before any other op', () => {
    assert.deepEqual(planTranscriptRows(rows('a b c'), rows('a c:2 d')), {
      kind: 'patch',
      ops: [
        { kind: 'remove', key: 'b' },
        { kind: 'replace', key: 'c' },
        { kind: 'insert', key: 'd', before: null },
      ],
      kept: 1,
    })
  })

  it('asks for a rebuild when kept rows would have to move', () => {
    assert.deepEqual(planTranscriptRows(rows('a b c'), rows('a c b')), {
      kind: 'rebuild',
      reason: 'reordered',
    })
  })

  it('asks for a rebuild when a key appears twice', () => {
    assert.deepEqual(planTranscriptRows(rows('a a'), rows('a')), {
      kind: 'rebuild',
      reason: 'duplicate-key',
    })
    assert.deepEqual(planTranscriptRows(rows('a'), rows('a a')), {
      kind: 'rebuild',
      reason: 'duplicate-key',
    })
  })
})

describe('transcriptRowSignature', () => {
  function seed(): { store: ReturnType<typeof createStore>; threadId: string; ids: string[] } {
    const store = createStore()
    const threadId = createThread(store)
    const ids = [
      addMessage(store, threadId, 'user', 'First question'),
      addMessage(store, threadId, 'assistant', 'First answer'),
      addMessage(store, threadId, 'user', 'Second question'),
      addMessage(store, threadId, 'assistant', ''),
    ]
    return { store, threadId, ids }
  }
  function thread(store: ReturnType<typeof createStore>, threadId: string): Thread {
    const found = getThreadById(store, threadId)
    assert.ok(found)
    return found
  }
  function signatures(store: ReturnType<typeof createStore>, threadId: string): string[] {
    return wantedTranscriptRows(thread(store, threadId), new Set()).map((row) => row.signature)
  }

  it('changes only the live tail when the thread status flips', () => {
    // The last reply is still empty, so its reasoning trail is live while running.
    const { store, threadId } = seed()
    setThreadStatus(store, threadId, 'running')
    const before = signatures(store, threadId)
    setThreadStatus(store, threadId, 'idle')
    const after = signatures(store, threadId)
    assert.deepEqual(after.slice(0, 3), before.slice(0, 3))
    assert.notEqual(after[3], before[3])
  })

  it('changes only the streamed message and the previous last row as a turn grows', () => {
    const { store, threadId, ids } = seed()
    const before = signatures(store, threadId)
    appendToken(store, ids[3] ?? '', 'Second answer')
    const streamed = signatures(store, threadId)
    assert.deepEqual(streamed.slice(0, 3), before.slice(0, 3))
    assert.notEqual(streamed[3], before[3], 'an in-place token append must change the signature')

    addMessage(store, threadId, 'user', 'Third question')
    const appended = signatures(store, threadId)
    assert.deepEqual(
      appended.slice(0, 4),
      streamed,
      'a settled reply draws the same once it stops being the last message',
    )
  })

  it('ties every member of a multi-message run to the run it draws', () => {
    const store = createStore()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'Fix it')
    const anchor = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, anchor, {
      id: 'tc-1',
      name: 'read_file',
      args: { path: 'a.ts' },
      status: 'done',
      result: 'ok',
    })
    const member = addMessage(store, threadId, 'assistant', '')
    addToolCall(store, member, {
      id: 'tc-2',
      name: 'read_file',
      args: { path: 'b.ts' },
      status: 'done',
      result: 'ok',
    })
    addMessage(store, threadId, 'assistant', 'Done.')
    const t = thread(store, threadId)
    const anchorMessage = t.messages.find((message) => message.id === anchor)
    assert.ok(anchorMessage)
    const before = transcriptRowSignature(t, anchorMessage)
    const memberMessage = t.messages.find((message) => message.id === member)
    const call = memberMessage?.toolCalls[0]
    assert.ok(call)
    // The anchor's rollup draws the member's calls: a member change re-signs it.
    call.result = 'changed'
    assert.notEqual(transcriptRowSignature(t, anchorMessage), before)
  })

  it('leaves hidden (queued) messages out of the wanted rows', () => {
    const { store, threadId, ids } = seed()
    const wanted = wantedTranscriptRows(thread(store, threadId), new Set([ids[2] ?? '']))
    assert.deepEqual(
      wanted.map((row) => row.key),
      [ids[0], ids[1], ids[3]],
    )
  })
})

describe('applyTranscriptRowPlan', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function row(key: string, text = key): HTMLElement {
    const element = document.createElement('div')
    element.className = 'msg'
    element.dataset['messageId'] = key
    element.textContent = text
    return element
  }
  function card(attribute: string, key: string): HTMLElement {
    const element = document.createElement('div')
    element.setAttribute(attribute, key)
    return element
  }
  function order(list: HTMLElement): string[] {
    return Array.from(list.children, (child) => {
      if (child instanceof HTMLElement && child.dataset['messageId'] !== undefined) {
        return child.dataset['messageId']
      }
      const attribute = child.getAttributeNames()[0] ?? child.className
      return `${attribute}=${child.getAttribute(attribute) ?? ''}`
    })
  }

  it('keeps unchanged rows by identity, rebuilds changed rows in place with their cards', () => {
    const list = document.createElement('div')
    const activity = document.createElement('div')
    activity.className = 'agent-activity'
    const a = row('a')
    const b = row('b')
    const c = row('c')
    list.append(
      a,
      b,
      card('data-review-for', 'b'),
      card('data-turn-recovery-for', 'b'),
      c,
      card('data-hook-cards-for', 'c'),
      activity,
    )
    document.body.append(list)

    const built: string[] = []
    const plan = planTranscriptRows(
      [
        { key: 'a', signature: '1' },
        { key: 'b', signature: '1' },
        { key: 'c', signature: '1' },
      ],
      [
        { key: 'a', signature: '1' },
        { key: 'b', signature: '2' },
        { key: 'd', signature: '1' },
      ],
    )
    assert.equal(plan.kind, 'patch')
    applyTranscriptRowPlan(plan, {
      list,
      insert: (key, before) => {
        built.push(key)
        list.insertBefore(row(key, `${key}-new`), before ?? activity)
      },
    })

    assert.deepEqual(built, ['b', 'd'])
    assert.deepEqual(order(list), ['a', 'b', 'd', 'class=agent-activity'])
    assert.ok(list.children[0] === a, 'the unchanged row must be the same node')
    assert.ok(list.children[1] !== b, 'the changed row is rebuilt')
    assert.equal(list.children[1]?.textContent, 'b-new')
    assert.equal(c.isConnected, false)
  })

  it('rebuilds a row with cards before the node that followed them', () => {
    const list = document.createElement('div')
    list.append(row('a'), card('data-review-report-for', 'a'), row('b'))
    document.body.append(list)
    const next = removeTranscriptRow(list, 'a')
    assert.ok(next instanceof HTMLElement && next.dataset['messageId'] === 'b')
    assert.deepEqual(order(list), ['b'])
  })

  it('relinks a reading anchor to the rebuilt row with the same key', () => {
    const list = document.createElement('div')
    const old = row('a')
    list.append(old)
    document.body.append(list)
    removeTranscriptRow(list, 'a')
    const rebuilt = row('a')
    list.append(rebuilt)
    const anchor = relinkReadingAnchor(list, { element: old, viewportTop: 42 })
    assert.ok(anchor?.element === rebuilt)
    assert.equal(anchor.viewportTop, 42)
    const connected = { element: rebuilt, viewportTop: 7 }
    assert.ok(relinkReadingAnchor(list, connected) === connected)
  })
})
