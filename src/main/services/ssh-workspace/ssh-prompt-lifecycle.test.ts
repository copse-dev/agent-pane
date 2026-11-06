import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { RendererPromptTarget } from '../renderer-prompt-target.ts'
import { SshPromptLifecycle } from './ssh-prompt-lifecycle.ts'

function target(): RendererPromptTarget & {
  events: { channel: string; args: unknown[] }[]
  destroy(): void
} {
  const events: { channel: string; args: unknown[] }[] = []
  let destroyed = false
  return {
    events,
    destroy: (): void => {
      destroyed = true
    },
    isDestroyed: (): boolean => destroyed,
    send: (channel: string, ...args: unknown[]): void => {
      events.push({ channel, args })
    },
  }
}

it('expires the real 60-second deadline and dismisses only the owning renderer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lifecycle = new SshPromptLifecycle()
  const owner = target()
  const other = target()
  const result = lifecycle.request({ prompt: 'Passphrase', kind: 'secret' }, owner)
  const second = lifecycle.request({ prompt: 'Host key?', kind: 'confirm' }, other)
  const request = owner.events[0]?.args[0]
  assert.ok(typeof request === 'object' && request !== null && Object.hasOwn(request, 'id'))
  t.mock.timers.tick(59_999)
  assert.equal(owner.events.length, 1)
  t.mock.timers.tick(1)
  assert.deepEqual(await result, { value: '' })
  assert.deepEqual(await second, { value: '' })
  assert.equal(owner.events[1]?.channel, 'ssh-prompt:dismissed')
  assert.notDeepEqual(owner.events[1].args, other.events[1]?.args)
})

it('accepts an answer once, ignores late responses and clears its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lifecycle = new SshPromptLifecycle()
  const owner = target()
  const result = lifecycle.request({ prompt: 'Host key?', kind: 'confirm' }, owner)
  lifecycle.settle('unknown', { value: 'yes' })
  const request = owner.events[0]?.args[0]
  assert.ok(
    typeof request === 'object' &&
      request !== null &&
      'id' in request &&
      typeof request.id === 'string',
  )
  lifecycle.settle(request.id, { value: 'yes' })
  lifecycle.settle(request.id, { value: '' })
  assert.deepEqual(await result, { value: 'yes' })
  t.mock.timers.tick(60_000)
  assert.equal(owner.events.length, 2)
})

it('settles even when the renderer disappears or throws while dismissing', async () => {
  const lifecycle = new SshPromptLifecycle()
  const owner = target()
  const result = lifecycle.request({ prompt: 'Passphrase', kind: 'secret' }, owner)
  owner.destroy()
  lifecycle.cancelAll()
  assert.deepEqual(await result, { value: '' })
  const throwing = lifecycle.request(
    { prompt: 'Passphrase', kind: 'secret' },
    {
      isDestroyed: (): boolean => false,
      send: (): void => {
        throw new Error('renderer closed')
      },
    },
  )
  assert.deepEqual(await throwing, { value: '' })
})
