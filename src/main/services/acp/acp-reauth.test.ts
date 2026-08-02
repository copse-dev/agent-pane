import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { offerAcpReauth } from './acp-reauth.ts'
import { runWithAskUserHandler } from '../ask-user.ts'
import { setTerminalCommandLauncher } from '../exec/terminal-launch.ts'

describe('offerAcpReauth', () => {
  let launched: string[] = []

  beforeEach(() => {
    launched = []
    setTerminalCommandLauncher((command) => launched.push(command))
  })

  afterEach(() => {
    setTerminalCommandLauncher(null)
  })

  /** Run the offer with a canned answer to the single question it asks. */
  function withAnswer<T>(answer: (question: string) => string, fn: () => Promise<T>): Promise<T> {
    return runWithAskUserHandler(
      (req) => Promise.resolve({ answers: req.questions.map((q) => answer(q.question)) }),
      fn,
    )
  }

  it('launches the re-login command, not the first-run token command', async () => {
    const command = await withAnswer(
      () => 'Run `claude /login`',
      () => offerAcpReauth({ agentId: 'claude-agent-acp', kind: 'expired' }),
    )
    assert.equal(command, 'claude /login')
    assert.deepEqual(launched, ['claude /login'])
  })

  it('says which agent expired and that the sign-in finishes in the terminal', async () => {
    let asked = ''
    await withAnswer(
      (question) => {
        asked = question
        return 'Not now'
      },
      () => offerAcpReauth({ agentId: 'claude-agent-acp', kind: 'expired' }),
    )
    assert.match(asked, /Claude’s saved sign-in has expired/)
    assert.match(asked, /claude \/login/)
    assert.match(asked, /re-send your message/)
  })

  it('launches nothing when the user declines', async () => {
    const command = await withAnswer(
      () => 'Not now',
      () => offerAcpReauth({ agentId: 'cursor', kind: 'required' }),
    )
    assert.equal(command, null)
    assert.deepEqual(launched, [])
  })

  // A blank answer is what a closed window / timed-out ask resolves to, and a
  // terminal must never open off the back of one.
  it('treats a blank or unrecognised answer as a decline', async () => {
    assert.equal(
      await withAnswer(
        () => '',
        () => offerAcpReauth({ agentId: 'cursor', kind: 'required' }),
      ),
      null,
    )
    assert.equal(
      await withAnswer(
        () => 'what does that do?',
        () => offerAcpReauth({ agentId: 'cursor', kind: 'required' }),
      ),
      null,
    )
    assert.deepEqual(launched, [])
  })

  it('does not ask when the catalog has no login command for the agent', async () => {
    let asked = false
    const command = await runWithAskUserHandler(
      (req) => {
        asked = true
        return Promise.resolve({ answers: req.questions.map(() => '') })
      },
      () => offerAcpReauth({ agentId: 'some-custom-agent', kind: 'expired' }),
    )
    assert.equal(command, null)
    assert.equal(asked, false)
  })

  // Headless hosts have no Shells pane; the written guidance in the error text
  // is already the whole answer there, so don't raise an offer we can't honour.
  it('does not ask when no terminal surface is attached', async () => {
    setTerminalCommandLauncher(null)
    let asked = false
    const command = await runWithAskUserHandler(
      (req) => {
        asked = true
        return Promise.resolve({ answers: req.questions.map(() => '') })
      },
      () => offerAcpReauth({ agentId: 'claude-agent-acp', kind: 'expired' }),
    )
    assert.equal(command, null)
    assert.equal(asked, false)
  })
})
