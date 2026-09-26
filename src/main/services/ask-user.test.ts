import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createWindowAskUserHandler,
  requestUserAnswers,
  setAskUserHandler,
  type AskUserRequest,
  type AskUserResult,
} from './ask-user.ts'
import {
  registerRunDeadline,
  resetRunDeadlinesForTest,
  type PausableRunDeadline,
} from './hooks/run-deadline.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'

const req: AskUserRequest = {
  questions: [{ question: 'Which DB?', options: ['Postgres'] }, { question: 'Async?' }],
}

describe('requestUserAnswers pluggable transport', () => {
  afterEach(() => {
    setAskUserHandler(null)
  })

  it('returns blank answers (without hanging) when no handler is registered', async () => {
    setAskUserHandler(null)
    assert.deepEqual(await requestUserAnswers(req), { answers: ['', ''] })
  })

  it('routes the request to the registered handler', async () => {
    const seen: AskUserRequest[] = []
    setAskUserHandler(async (r) => {
      seen.push(r)
      return { answers: ['Postgres', 'Yes'] }
    })
    assert.deepEqual(await requestUserAnswers(req), { answers: ['Postgres', 'Yes'] })
    assert.deepEqual(seen, [req])
  })

  it('marks the answers cancelled when the run already stopped', async () => {
    let asked = false
    setAskUserHandler(async () => {
      asked = true
      return { answers: ['x', 'y'] }
    })
    const controller = new AbortController()
    controller.abort()

    assert.deepEqual(await requestUserAnswers(req, controller.signal), {
      answers: ['', ''],
      cancelled: true,
    })
    assert.equal(asked, false)
  })

  it('marks the answers cancelled when the run stops mid-question', async () => {
    setAskUserHandler(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = requestUserAnswers(req, controller.signal)

    controller.abort()

    assert.deepEqual(await pending, { answers: ['', ''], cancelled: true })
  })

  it('keeps an answer that arrived in the same turn as the stop', async () => {
    let fulfill: (answers: string[]) => void = () => {}
    const answered = new Promise<string[]>((resolve) => {
      fulfill = resolve
    })
    // An async handler adds promise hops between the answer and the result.
    setAskUserHandler(async () => ({ answers: await answered }))
    const controller = new AbortController()
    const pending = requestUserAnswers(req, controller.signal)

    fulfill(['Postgres', 'Yes'])
    controller.abort()

    assert.deepEqual(await pending, { answers: ['Postgres', 'Yes'] })
  })

  it('reverts to blank answers once the handler is cleared', async () => {
    setAskUserHandler(async () => ({ answers: ['x', 'y'] }))
    assert.deepEqual((await requestUserAnswers(req)).answers, ['x', 'y'])
    setAskUserHandler(null)
    assert.deepEqual((await requestUserAnswers(req)).answers, ['', ''])
  })
})

function fakeWindowDeps(): {
  sent: string[]
  answer: (answers: string[]) => void
  deps: Parameters<typeof createWindowAskUserHandler>[0]
} {
  const sent: string[] = []
  const pending = new Map<string, (result: AskUserResult) => void>()
  const settle = (id: string, result: AskUserResult): void => {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(result)
  }
  return {
    sent,
    answer: (answers): void => {
      for (const id of [...pending.keys()]) settle(id, { answers })
    },
    deps: {
      send: (channel): void => {
        sent.push(channel)
      },
      register: (id, resolve): void => {
        pending.set(id, resolve)
      },
      settle,
      alertUser: () => () => {},
    },
  }
}

describe('window ask_user handler', () => {
  afterEach(() => {
    setAskUserHandler(null)
  })

  it('returns what the user answered in the window', async () => {
    const window = fakeWindowDeps()
    setAskUserHandler(createWindowAskUserHandler(window.deps))
    const pending = requestUserAnswers(req, new AbortController().signal)

    window.answer(['Postgres', 'Yes'])

    assert.deepEqual(await pending, { answers: ['Postgres', 'Yes'] })
    assert.deepEqual(window.sent, ['agent:ask-user-request'])
  })

  it('withdraws an open question as cancelled when the run stops', async () => {
    const window = fakeWindowDeps()
    setAskUserHandler(createWindowAskUserHandler(window.deps))
    const controller = new AbortController()
    const pending = requestUserAnswers(req, controller.signal)

    controller.abort()

    assert.deepEqual(await pending, { answers: ['', ''], cancelled: true })
    assert.deepEqual(window.sent, ['agent:ask-user-request', 'agent:ask-user-cancelled'])
  })

  it('alerts for the asking thread and releases the alert once answered', async () => {
    const window = fakeWindowDeps()
    const alerts: { kind: string; threadId: string | undefined }[] = []
    let released = 0
    setAskUserHandler(
      createWindowAskUserHandler({
        ...window.deps,
        alertUser: (kind, _body, threadId) => {
          alerts.push({ kind, threadId })
          return (): void => {
            released += 1
          }
        },
      }),
    )
    const pending = runWithActiveRunIdentity('thread-ask', () =>
      requestUserAnswers(req, new AbortController().signal),
    )

    // The thread lets the notification open it and holds its badge count.
    assert.deepEqual(alerts, [{ kind: 'interaction', threadId: 'thread-ask' }])
    assert.equal(released, 0)
    window.answer(['Postgres', 'Yes'])
    await pending
    assert.equal(released, 1)
  })
})

// #2332: a question waiting on a human is a host-side wait, and the run's
// idle and hard deadlines must not advance while one is on screen — otherwise a
// user who thinks for longer than the 15-minute idle budget has the turn
// aborted underneath a dialog that is still asking them for an answer.
describe('requestUserAnswers host-wait deadline pause', () => {
  afterEach(() => {
    setAskUserHandler(null)
    resetRunDeadlinesForTest()
  })

  function recordingDeadline(): { deadline: PausableRunDeadline; log: string[] } {
    const log: string[] = []
    return {
      log,
      deadline: {
        pauseForHostWait: () => log.push('pause'),
        resumeForHostWait: () => log.push('resume'),
      },
    }
  }

  it('pauses the run deadline for the whole wait and resumes after', async () => {
    const { deadline, log } = recordingDeadline()
    registerRunDeadline('thread-ask', deadline)
    let pausedWhileWaiting: string[] = []
    setAskUserHandler(async () => {
      pausedWhileWaiting = [...log]
      return { answers: ['Postgres', 'Yes'] }
    })

    const answered = await runWithActiveRunIdentity('thread-ask', () => requestUserAnswers(req))

    assert.deepEqual(answered.answers, ['Postgres', 'Yes'])
    // Paused before the handler was ever invoked, not merely at the end.
    assert.deepEqual(pausedWhileWaiting, ['pause'])
    assert.deepEqual(log, ['pause', 'resume'])
  })

  it('resumes the deadline when the handler rejects', async () => {
    const { deadline, log } = recordingDeadline()
    registerRunDeadline('thread-ask', deadline)
    setAskUserHandler(async () => {
      throw new Error('window gone')
    })

    await assert.rejects(
      runWithActiveRunIdentity('thread-ask', () =>
        requestUserAnswers(req, new AbortController().signal),
      ),
      /window gone/,
    )
    assert.deepEqual(log, ['pause', 'resume'])
  })

  it('is a transparent pass-through when no run owns the ask', async () => {
    const { deadline, log } = recordingDeadline()
    registerRunDeadline('someone-else', deadline)
    setAskUserHandler(async () => ({ answers: ['a', 'b'] }))

    assert.deepEqual((await requestUserAnswers(req)).answers, ['a', 'b'])
    assert.deepEqual(log, [])
  })
})
