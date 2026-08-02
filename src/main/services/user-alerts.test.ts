import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchUserAlert,
  type UserAlertEffects,
  type UserAlertPreferences,
} from './user-alerts.ts'

const enabled: UserAlertPreferences = {
  interaction: true,
  threadFinished: true,
  systemNotification: true,
  sound: true,
  bounce: true,
}

function effects(): {
  value: UserAlertEffects
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    value: {
      notification: (title, body) => calls.push(`notification:${title}:${body}`),
      sound: () => calls.push('sound'),
      bounce: (kind) => {
        calls.push(`bounce:${kind}`)
        return () => calls.push('stop')
      },
    },
  }
}

describe('dispatchUserAlert', () => {
  it('delivers interaction alerts through every enabled channel and stops the bounce', () => {
    const fake = effects()
    const stop = dispatchUserAlert(enabled, 'interaction', 'Run command', fake.value)

    assert.deepEqual(fake.calls, [
      'notification:Copse needs your input:Run command',
      'sound',
      'bounce:interaction',
    ])
    stop()
    assert.equal(fake.calls.at(-1), 'stop')
  })

  it('lets each delivery channel be disabled independently', () => {
    const fake = effects()
    dispatchUserAlert(
      { ...enabled, systemNotification: false, bounce: false },
      'thread-finished',
      'Refactor is ready.',
      fake.value,
    )

    assert.deepEqual(fake.calls, ['sound'])
  })

  it('suppresses every channel when that event is disabled', () => {
    const interaction = effects()
    dispatchUserAlert(
      { ...enabled, interaction: false },
      'interaction',
      'Approval needed',
      interaction.value,
    )
    assert.deepEqual(interaction.calls, [])

    const finished = effects()
    dispatchUserAlert(
      { ...enabled, threadFinished: false },
      'thread-finished',
      'Done',
      finished.value,
    )
    assert.deepEqual(finished.calls, [])
  })
})
