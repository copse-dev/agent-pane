import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { requestUserAnswers, setAskUserHandler, type AskUserRequest } from './ask-user.ts'
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

  it('reverts to blank answers once the handler is cleared', async () => {
    setAskUserHandler(async () => ({ answers: ['x', 'y'] }))
    assert.deepEqual((await requestUserAnswers(req)).answers, ['x', 'y'])
    setAskUserHandler(null)
    assert.deepEqual((await requestUserAnswers(req)).answers, ['', ''])
  })
})

// #2332: a question waiting on a human is a host-side wait, and the run's
// sliding idle deadline must not advance while one is on screen — otherwise a
// user who thinks for longer than the 15-minute idle budget has the turn
// aborted underneath a dialog that is still asking them for an answer.
describe('requestUserAnswers idle-deadline pause', () => {
  afterEach(() => {
    setAskUserHandler(null)
    resetRunDeadlinesForTest()
  })

  function recordingDeadline(): { deadline: PausableRunDeadline; log: string[] } {
    const log: string[] = []
    return {
      log,
      deadline: {
        pause: () => log.push('pause'),
        resume: () => log.push('resume'),
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
