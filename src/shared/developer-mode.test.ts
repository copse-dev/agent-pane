import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toggleDetachedDevTools, type DevToolsController } from './developer-mode.ts'

function controller(opened: boolean): {
  controller: DevToolsController
  openedWith: Array<{ mode: 'detach'; title: string }>
  closeCalls: number
} {
  const openedWith: Array<{ mode: 'detach'; title: string }> = []
  const result = {
    openedWith,
    closeCalls: 0,
    controller: {
      isDevToolsOpened: (): boolean => opened,
      openDevTools: (options: { mode: 'detach'; title: string }): void => {
        openedWith.push(options)
      },
      closeDevTools: (): void => {
        result.closeCalls += 1
      },
    },
  }
  return result
}

describe('detached DevTools', () => {
  it('opens in a separate non-dockable window', () => {
    const spy = controller(false)
    toggleDetachedDevTools(spy.controller)
    assert.deepEqual(spy.openedWith, [{ mode: 'detach', title: 'Copse Developer Tools' }])
    assert.equal(spy.closeCalls, 0)
  })

  it('closes an already-open DevTools window', () => {
    const spy = controller(true)
    toggleDetachedDevTools(spy.controller)
    assert.deepEqual(spy.openedWith, [])
    assert.equal(spy.closeCalls, 1)
  })
})
