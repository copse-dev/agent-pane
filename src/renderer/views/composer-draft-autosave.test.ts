import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createComposerDraftAutosave } from './composer-draft-autosave.ts'

type SaveCall = { threadId: string; value: string }

function setup(initialThreadId: string, initialValue: string) {
  let activeThreadId: string | null = initialThreadId
  let value = initialValue
  const saves: SaveCall[] = []
  const autosave = createComposerDraftAutosave({
    getActiveThreadId: () => activeThreadId,
    getValue: () => value,
    save: (threadId, v) => saves.push({ threadId, value: v }),
    delayMs: 250,
  })
  return {
    autosave,
    saves,
    setActiveThreadId: (id: string | null) => (activeThreadId = id),
    setValue: (v: string) => (value = v),
  }
}

test('persists the draft for the active thread after the debounce elapses', async () => {
  const ctx = setup('thread-a', 'hello draft')
  ctx.autosave.schedule()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(ctx.saves, [{ threadId: 'thread-a', value: 'hello draft' }])
})

test('does not clobber a thread draft after switching away within the debounce window', async () => {
  const ctx = setup('thread-a', 'hello draft')
  // User types in thread-a (schedules a save), then switches to thread-b before
  // the 250ms timer fires; the new thread's textarea value is empty.
  ctx.autosave.schedule()
  ctx.setActiveThreadId('thread-b')
  ctx.setValue('')
  await new Promise((r) => setTimeout(r, 300))
  // The late timer must skip the save so thread-a's draft (persisted by the
  // switch handler) is not overwritten with thread-b's empty textarea value.
  assert.deepEqual(ctx.saves, [])
})

test('cancel prevents a pending save from firing', async () => {
  const ctx = setup('thread-a', 'hello draft')
  ctx.autosave.schedule()
  ctx.autosave.cancel()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(ctx.saves, [])
})

test('rescheduling debounces to a single save with the latest value', async () => {
  const ctx = setup('thread-a', 'first')
  ctx.autosave.schedule()
  ctx.setValue('second')
  ctx.autosave.schedule()
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(ctx.saves, [{ threadId: 'thread-a', value: 'second' }])
})
