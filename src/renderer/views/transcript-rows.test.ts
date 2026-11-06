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
  appendReasoning,
  setMessageTurnOutcome,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { Message, Thread } from '@shared/types'
import {
  adoptPatchedSignatures,
  applyTranscriptRowPlan,
  planTranscriptRows,
  relinkReadingAnchor,
  removeTranscriptRow,
  sameExceptTurnOutcome,
  type TranscriptRow,
  type TranscriptRowSignature,
  transcriptRowSignature,
  type WantedTranscriptRow,
  wantedTranscriptRows,
} from './transcript-rows.ts'

function signature(patched: string, settled = ''): TranscriptRowSignature {
  return { patched, settled }
}

function rows(spec: string): TranscriptRow[] {
  // "a b:2 c" → keys a, b, c with patched signatures '1', '2', '1';
  // "b:2/x" also gives b the settled signature 'x'.
  return spec
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      const [key = '', parts = '1'] = part.split(':')
      const [patched = '1', settled = ''] = parts.split('/')
      return { key, signature: signature(patched, settled) }
    })
}

/** Wanted rows from a `rows` spec; `runs` lists the keys of each multi-message run. */
function wanted(spec: string, runs: readonly (readonly string[])[] = []): WantedTranscriptRow[] {
  return rows(spec).map((row) => ({
    ...row,
    patchedBy: runs.find((run) => run.includes(row.key)) ?? [row.key],
  }))
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
    assert.deepEqual(planTranscriptRows(rows('a b c'), rows('a b:1/x c')), {
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
  function signatures(
    store: ReturnType<typeof createStore>,
    threadId: string,
  ): TranscriptRowSignature[] {
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
    assert.notDeepEqual(after[3], before[3])
  })

  it('changes only the streamed message and the previous last row as a turn grows', () => {
    const { store, threadId, ids } = seed()
    const before = signatures(store, threadId)
    appendToken(store, ids[3] ?? '', 'Second answer')
    const streamed = signatures(store, threadId)
    assert.deepEqual(streamed.slice(0, 3), before.slice(0, 3))
    assert.notDeepEqual(
      streamed[3],
      before[3],
      'an in-place token append must change the signature',
    )

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
    assert.notDeepEqual(transcriptRowSignature(t, anchorMessage), before)
    // The patch that redrew the member redrew the anchor: both are patched by either.
    const runRows = wantedTranscriptRows(t, new Set()).filter(
      (row) => row.key === anchor || row.key === member,
    )
    assert.deepEqual(
      runRows.map((row) => row.patchedBy),
      [
        [anchor, member],
        [anchor, member],
      ],
    )
  })

  it('settles a step joining its run apart from what it streams', () => {
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
    // A step that has not streamed anything yet is not part of the run.
    const step = addMessage(store, threadId, 'assistant', '')
    const stepRow = (): TranscriptRowSignature => {
      const found = wantedTranscriptRows(thread(store, threadId), new Set()).find(
        (row) => row.key === step,
      )
      assert.ok(found)
      return found.signature
    }
    const empty = stepRow()
    appendReasoning(store, step, 'Thinking.')
    // Its reasoning makes it a member: its own bubble must be rebuilt as one.
    assert.notEqual(stepRow().settled, empty.settled)

    const settled = stepRow().settled
    addToolCall(store, step, {
      id: 'tc-2',
      name: 'read_file',
      args: { path: 'b.ts' },
      status: 'running',
      result: null,
    })
    assert.equal(stepRow().settled, settled, 'a call starting is streamed content')
  })

  it('signs a turn outcome only by what it draws', () => {
    const { store, threadId, ids } = seed()
    const replyRow = (): TranscriptRowSignature => {
      const found = wantedTranscriptRows(thread(store, threadId), new Set()).find(
        (row) => row.key === ids[1],
      )
      assert.ok(found)
      return found.signature
    }
    const before = replyRow()
    const outcome = {
      stopReason: 'end_turn',
      source: 'provider',
      executor: 'local',
      provider: 'openai',
      model: 'openai:gpt-5.5',
      endedAt: 2,
    } as const
    setMessageTurnOutcome(store, threadId, ids[1] ?? '', { ...outcome, status: 'completed' })
    assert.deepEqual(replyRow(), before, 'a completed outcome draws nothing new')
    // A failed one changes the concise classes, which no handler patches.
    setMessageTurnOutcome(store, threadId, ids[1] ?? '', { ...outcome, status: 'failed' })
    assert.equal(replyRow().patched, before.patched)
    assert.notEqual(replyRow().settled, before.settled)
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

describe('adoptPatchedSignatures', () => {
  const current = (): boolean => true

  it('takes the patched part of a patched row from the thread and keeps its settled part', () => {
    const rendered = rows('a b:1/s c')
    const adopted = adoptPatchedSignatures(rendered, wanted('a b:2/t c:2'), new Set(['b']), current)
    assert.deepEqual(adopted, rows('a b:2/s c'))
    // The settled part still differs, so the row is rebuilt; c was not patched.
    assert.deepEqual(planTranscriptRows(adopted, wanted('a b:2/t c:2')), {
      kind: 'patch',
      ops: [
        { kind: 'replace', key: 'b' },
        { kind: 'replace', key: 'c' },
      ],
      kept: 1,
    })
  })

  it('counts a patch to any member of a run for every row of the run', () => {
    const adopted = adoptPatchedSignatures(
      rows('p a b'),
      wanted('p a:2 b:2', [['a', 'b']]),
      new Set(['b']),
      current,
    )
    assert.deepEqual(adopted, rows('p a:2 b:2'))
  })

  it('keeps a row appended at the tail out of the way', () => {
    const adopted = adoptPatchedSignatures(rows('a b'), wanted('a b:2 c'), new Set(['b']), current)
    assert.deepEqual(adopted, rows('a b:2'))
  })

  it('adopts nothing when the list changes shape around the rows', () => {
    const patched = new Set(['b'])
    const removed = rows('a b c')
    assert.ok(adoptPatchedSignatures(removed, wanted('a b:2'), patched, current) === removed)
    const insertedAbove = rows('a b')
    assert.ok(
      adoptPatchedSignatures(insertedAbove, wanted('x a b:2'), patched, current) === insertedAbove,
    )
  })

  it('adopts nothing once a message was replaced from outside the stream', () => {
    const rendered = rows('a b')
    const adopted = adoptPatchedSignatures(
      rendered,
      wanted('a:2 b:2'),
      new Set(['b']),
      (index) => index !== 0,
    )
    assert.ok(adopted === rendered)
  })
})

describe('sameExceptTurnOutcome', () => {
  const drawn: Message = {
    id: 'm1',
    role: 'assistant',
    content: 'Done.',
    toolCalls: [],
    createdAt: 1,
  }

  it('accepts the same message and one that only gained a turn outcome', () => {
    assert.equal(sameExceptTurnOutcome(drawn, drawn), true)
    const ended: Message = {
      ...drawn,
      turnOutcome: {
        status: 'completed',
        stopReason: 'end_turn',
        source: 'provider',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 2,
      },
    }
    assert.equal(sameExceptTurnOutcome(drawn, ended), true)
  })

  it('rejects a message with any other field replaced, added or removed', () => {
    assert.equal(sameExceptTurnOutcome(drawn, { ...drawn, content: 'Edited.' }), false)
    assert.equal(sameExceptTurnOutcome(drawn, { ...drawn, toolCalls: [] }), false)
    assert.equal(sameExceptTurnOutcome(drawn, { ...drawn, editedByUser: true }), false)
    // Field order is not a difference.
    const { createdAt: _createdAt, ...withoutCreatedAt } = drawn
    assert.equal(sameExceptTurnOutcome({ ...withoutCreatedAt, createdAt: 1 }, drawn), true)
    assert.equal(
      sameExceptTurnOutcome({ ...drawn, editedByUser: true }, drawn),
      false,
      'a field the next message lost',
    )
  })

  it('accepts a change only in the fields a handler says it redraws', () => {
    const reviewed: Message = { ...drawn, review: { status: 'running', summary: '' } }
    assert.equal(sameExceptTurnOutcome(drawn, reviewed), false)
    assert.equal(sameExceptTurnOutcome(drawn, reviewed, ['review']), true)
    assert.equal(sameExceptTurnOutcome(reviewed, drawn, ['review']), true, 'a review removed')
    assert.equal(
      sameExceptTurnOutcome(drawn, { ...reviewed, content: 'Edited.' }, ['review']),
      false,
      'another field changed alongside the redrawn one',
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
    const plan = planTranscriptRows(rows('a b c'), rows('a b:2 d'))
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
