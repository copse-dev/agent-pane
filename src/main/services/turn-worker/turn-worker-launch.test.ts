import assert from 'node:assert/strict'
import type { SpawnOptions } from 'node:child_process'
import { describe, it } from 'node:test'
import { handOffTurns, type TurnWorkerLaunchDependencies } from './turn-worker-launch.ts'

interface Call {
  command: string
  args: readonly string[]
  options: SpawnOptions
  unrefed: boolean
}

type LaunchDeps = TurnWorkerLaunchDependencies & {
  spawn: NonNullable<TurnWorkerLaunchDependencies['spawn']>
}

function deps(calls: Call[], overrides: Partial<TurnWorkerLaunchDependencies> = {}): LaunchDeps {
  return {
    execPath: '/app/Copse',
    workerPath: '/app/dist/main/turn-worker.js',
    userDataPath: '/profile',
    appVersion: '1.2.3',
    packaged: true,
    env: { HOME: '/home/me' },
    openLog: (): number => 7,
    spawn: (
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ): ReturnType<LaunchDeps['spawn']> => {
      const call: Call = { command, args, options, unrefed: false }
      calls.push(call)
      return {
        pid: 99,
        unref: (): void => {
          call.unrefed = true
        },
      }
    },
    ...overrides,
  }
}

describe('handOffTurns', () => {
  it('starts one detached worker per turn, run as Node by the app binary', () => {
    const calls: Call[] = []
    const started = handOffTurns(
      [
        { projectId: 'p', threadId: 'a' },
        { projectId: 'p', threadId: 'b' },
      ],
      deps(calls),
    )
    assert.equal(started.length, 2)
    assert.equal(calls.length, 2)
    const [first] = calls
    assert.ok(first)
    assert.equal(first.command, '/app/Copse')
    assert.deepEqual(first.args, [
      '/app/dist/main/turn-worker.js',
      '--user-data',
      '/profile',
      '--project',
      'p',
      '--thread',
      'a',
      '--app-version',
      '1.2.3',
      '--packaged',
    ])
    assert.equal(first.options.detached, true)
    assert.deepEqual(first.options.stdio, ['ignore', 7, 7])
    assert.deepEqual(first.options.env, { HOME: '/home/me', ELECTRON_RUN_AS_NODE: '1' })
    assert.equal(first.unrefed, true)
  })

  it('skips a turn whose worker cannot start and hands off the rest', () => {
    const calls: Call[] = []
    const lines: string[] = []
    const base = deps(calls, { packaged: false })
    const started = handOffTurns(
      [
        { projectId: 'p', threadId: 'bad' },
        { projectId: 'p', threadId: 'good' },
      ],
      {
        ...base,
        log: (line) => lines.push(line),
        spawn: (command, args, options) => {
          if (args.includes('bad')) throw new Error('EACCES')
          return base.spawn(command, args, options)
        },
      },
    )
    assert.deepEqual(started, [{ projectId: 'p', threadId: 'good' }])
    assert.equal(calls[0]?.args.includes('--packaged'), false)
    assert.ok(lines.some((line) => line.includes('could not hand off bad')))
  })
})
