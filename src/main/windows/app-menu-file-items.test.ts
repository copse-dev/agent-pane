import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAppFileMenuItems, type AppFileMenuActions } from './app-menu-file-items.ts'

function actionRecorder(): { actions: AppFileMenuActions; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    actions: {
      createWindow: () => calls.push('window'),
      createThread: () => calls.push('thread'),
      openFolder: () => calls.push('folder'),
      openSettings: () => calls.push('settings'),
    },
  }
}

function clickItem(items: ReturnType<typeof buildAppFileMenuItems>, label: string): void {
  const item = items.find((candidate) => candidate.label === label)
  assert.ok(item)
  const click = item.click
  assert.ok(click)
  Reflect.apply(click, undefined, [])
}

describe('buildAppFileMenuItems', () => {
  it('creates a new full window with the multi-window accelerator', () => {
    const { actions, calls } = actionRecorder()
    const items = buildAppFileMenuItems(actions, false)
    const newWindow = items.find((item) => item.label === 'New Window')

    assert.equal(newWindow?.accelerator, 'CmdOrCtrl+Shift+N')
    clickItem(items, 'New Window')
    assert.deepEqual(calls, ['window'])
  })

  it('routes file actions through the provided callbacks', () => {
    const { actions, calls } = actionRecorder()
    const items = buildAppFileMenuItems(actions, false)

    clickItem(items, 'New Thread')
    clickItem(items, 'Open Folder…')
    clickItem(items, 'Settings…')

    assert.deepEqual(calls, ['thread', 'folder', 'settings'])
  })

  it('keeps Settings outside the File menu on macOS', () => {
    const { actions } = actionRecorder()
    const items = buildAppFileMenuItems(actions, true)

    assert.equal(
      items.some((item) => item.label === 'Settings…'),
      false,
    )
    assert.equal(items.at(-1)?.role, 'close')
  })
})
