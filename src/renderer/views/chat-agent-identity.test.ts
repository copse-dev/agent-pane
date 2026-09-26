import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  setThreadStatus,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { createDemoApi } from '../demo/demo-api.ts'
import { enqueueUserMessage } from '../controller/message-queue.ts'
import { selectDemoScenario } from '../demo/scenarios.ts'
import { mountConversation } from './conversation.ts'
import { chatAgentIdentity, namedAgentTitles } from './chat-agent-identity.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('sparse chat identities', () => {
  it('reserves the two styles for remote and custom named agents', () => {
    const names = namedAgentTitles([
      { id: 'maple', title: 'Maple' },
      { id: 'codex', title: 'Codex' },
      { id: 'codex-acp', title: 'Codex' },
      null,
      { title: 12 },
    ])
    assert.equal(chatAgentIdentity('a', { model: 'claude-sonnet-4-6' }, names), null)
    assert.equal(chatAgentIdentity('a', { model: 'acp:codex' }, names), null)
    assert.equal(chatAgentIdentity('a', { model: 'acp:codex-acp' }, names), null)
    assert.equal(chatAgentIdentity('a', { model: 'acp:unknown' }, names), null)
    assert.equal(chatAgentIdentity('a', {}, names), null)
    const named = chatAgentIdentity('a', { model: 'acp:maple#model-a' }, names)
    assert.equal(named?.style, 'riso')
    assert.deepEqual(chatAgentIdentity('b', { model: 'acp:maple#model-b' }, names), named)
    assert.deepEqual(chatAgentIdentity('a', { requestedModel: 'acp:maple' }, names), named)
    assert.equal(
      chatAgentIdentity('a', { model: 'claude-sonnet-4-6', requestedModel: 'acp:maple' }, names),
      null,
    )
    const remote = chatAgentIdentity('a', { model: 'remote-agent:cursor' }, names)
    assert.equal(remote?.style, 'duotone')
    assert.equal(remote.label, 'Cursor Cloud Agent')
    assert.notEqual(
      chatAgentIdentity('b', { model: 'remote-agent:cursor' }, names)?.key,
      remote.key,
    )
  })

  it('marks speaker boundaries, preserves native labels, and updates a named agent safely', async () => {
    const store = createStore()
    const tid = createThread(store)
    const api = createDemoApi(selectDemoScenario(''))
    await api.settings.set('registeredAcpAgents', [{ id: 'maple', title: 'Maple' }])
    const models = [
      'claude-sonnet-4-6',
      'remote-agent:cursor',
      'remote-agent:cursor',
      'acp:maple',
      'acp:maple#model-b',
      'claude-sonnet-4-6',
      'acp:maple',
    ]
    for (const model of models)
      addMessage(store, tid, 'assistant', 'Reply', undefined, undefined, { model })
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)
    await Promise.resolve()
    const markers = [...host.querySelectorAll('.msg-assistant')].map(
      (msg) => msg.querySelector('.message-agent-name')?.textContent ?? null,
    )
    assert.deepEqual(markers, [null, 'Cursor Cloud Agent', null, 'Maple', null, null, 'Maple'])
    assert.equal(host.querySelectorAll('.agent-avatar[data-avatar-style="duotone"]').length, 1)
    const named = [
      ...host.querySelectorAll<HTMLImageElement>('.agent-avatar[data-avatar-style="riso"]'),
    ]
    assert.equal(named.length, 2)
    const source = named[0]?.src
    assert.equal(named[1]?.src, source)
    assert.equal(host.querySelector('.message-model')?.textContent, 'Claude Sonnet 4.6')
    const title = '<img src=x onerror=alert(1)>'
    await api.settings.set('registeredAcpAgents', [{ id: 'maple', title }])
    store.emit('settings_changed')
    await Promise.resolve()
    assert.equal(host.querySelectorAll('.message-agent-name img').length, 0)
    assert.equal(host.querySelectorAll('.message-agent-name')[1]?.textContent, title)
    assert.equal(
      host.querySelector<HTMLImageElement>('.agent-avatar[data-avatar-style="riso"]')?.src,
      source,
    )
    unmount()
  })

  it('activates only the latest speaker while running and stops on completion or a thread switch', async () => {
    const store = createStore()
    const tid = createThread(store)
    const api = createDemoApi(selectDemoScenario(''))
    await api.settings.set('registeredAcpAgents', [{ id: 'maple', title: 'Maple' }])
    addMessage(store, tid, 'assistant', 'Remote reply', undefined, undefined, {
      model: 'remote-agent:cursor',
    })
    addMessage(store, tid, 'assistant', 'Maple reply', undefined, undefined, {
      requestedModel: 'acp:maple',
    })
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)
    await Promise.resolve()
    const active = (): Element | null => host.querySelector('[data-avatar-active]')
    assert.equal(active(), null)
    setThreadStatus(store, tid, 'running')
    const maple = active()
    assert.equal(maple?.getAttribute('data-avatar-style'), 'riso')
    const next = addMessage(store, tid, 'assistant', 'Still reviewing', undefined, undefined, {
      requestedModel: 'acp:maple',
    })
    store.emit('message_token', next, 'More text')
    assert.equal(active(), maple, 'a continuation keeps the same marker')
    store.setState({ animateAgentAvatars: false })
    store.emit('settings_changed')
    await Promise.resolve()
    assert.equal(active(), null)
    assert.equal(
      host.querySelectorAll('.agent-avatar').length,
      2,
      'disabling motion keeps identities',
    )
    store.setState({ animateAgentAvatars: true })
    store.emit('settings_changed')
    await Promise.resolve()
    assert.equal(active(), maple)
    assert.equal(host.querySelectorAll('[data-avatar-active]').length, 1)
    setThreadStatus(store, tid, 'idle')
    assert.equal(active(), null)
    addMessage(store, tid, 'user', 'Check again')
    setThreadStatus(store, tid, 'running')
    assert.equal(active(), null, 'a new turn cannot animate the previous speaker')
    addMessage(store, tid, 'assistant', 'Native reply', undefined, undefined, {
      model: 'claude-sonnet-4-6',
    })
    assert.equal(active(), null)
    addMessage(store, tid, 'assistant', 'Remote reply', undefined, undefined, {
      model: 'remote-agent:cursor',
    })
    assert.equal(active()?.getAttribute('data-avatar-style'), 'duotone')
    assert.equal(host.querySelectorAll('[data-avatar-active]').length, 1)
    const queued = addMessage(store, tid, 'user', 'One more check')
    enqueueUserMessage(store, tid, {
      messageId: queued,
      payload: { content: 'One more check' },
      createdAt: 1,
    })
    assert.equal(active()?.getAttribute('data-avatar-style'), 'duotone')
    assert.equal(host.querySelectorAll('[data-avatar-active]').length, 1)
    setThreadStatus(store, tid, 'error')
    assert.equal(active(), null)
    setThreadStatus(store, tid, 'running')
    const remote = active()
    assert.ok(remote)
    const other = createThread(store)
    switchThread(store, other)
    assert.equal(remote.hasAttribute('data-avatar-active'), false)
    assert.equal(active(), null)
    unmount()
  })
})
