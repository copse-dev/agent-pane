import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import { addMessage, createThread, getThreadById } from '@shared/store/thread-helpers.ts'
import { buildSideChatThread } from '@copse/thread-store/side-chat.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountPanelModeControls } from './panel-mode-controls.ts'

describe('panel mode controls: side chat', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function mount(): {
    store: ReturnType<typeof createStore>
    threadId: string
    sideChat: () => HTMLButtonElement
  } {
    const store = createStore()
    store.setState({ activeProjectId: 'project-1' })
    const threadId = createThread(store)
    const controls = mountPanelModeControls(store, createFakeApi())
    document.body.append(controls.element)
    const sideChat = (): HTMLButtonElement => {
      const btn = controls.element.querySelector<HTMLButtonElement>(
        '[data-panel-control="side-chat"]',
      )
      assert.ok(btn)
      return btn
    }
    return { store, threadId, sideChat }
  }

  it('hides the control while the open thread has no side chat and its panel is closed', () => {
    const { sideChat } = mount()
    assert.equal(sideChat().hidden, true)
  })

  it('shows the control while its panel is open', () => {
    const { store, sideChat } = mount()
    store.setState({ filesPaneOpen: true, rightPanelMode: 'side-chat' })
    store.emit('right_panel_mode_changed')
    assert.equal(sideChat().hidden, false)
    store.setState({ rightPanelMode: 'terminal' })
    store.emit('right_panel_mode_changed')
    assert.equal(sideChat().hidden, true)
  })

  it('shows the control with a count once the open thread has a side chat', () => {
    const { store, threadId, sideChat } = mount()
    const anchorId = addMessage(store, threadId, 'user', 'Why is this flaky?')
    const parent = getThreadById(store, threadId)
    assert.ok(parent)
    const side = buildSideChatThread(parent, { anchorMessageId: anchorId })
    assert.ok(side)
    store.setState({ threads: [...store.getState().threads, side] })
    store.emit('threads_changed')
    assert.equal(sideChat().hidden, false)
    assert.equal(sideChat().querySelector('.titlebar-btn-badge')?.textContent, '1')
  })
})
