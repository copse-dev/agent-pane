import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { offerAcpReauth } from './acp-reauth.ts'
import { runWithAskUserHandler } from '../ask-user.ts'
import { setTerminalCommandLauncher } from '../exec/terminal-launch.ts'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

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

// When the agent ran on an SSH host its credential store is there, so the
// terminal must open on the host — running `claude /login` locally would sign
// in the wrong machine and leave the remote agent exactly as unauthenticated.
describe('offerAcpReauth on an SSH workspace', () => {
  const REMOTE_ROOT = '/remote/project'
  let launched: string[] = []

  beforeEach(async () => {
    launched = []
    setTerminalCommandLauncher((command) => launched.push(command))
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
    setWorkspaceRootForTest(REMOTE_ROOT)
  })

  afterEach(async () => {
    setTerminalCommandLauncher(null)
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('launches the guarded login command for the tab that opens on the host', async () => {
    const command = await runWithAskUserHandler(
      (req) => Promise.resolve({ answers: req.questions.map(() => 'yes') }),
      () => offerAcpReauth({ agentId: 'claude-agent-acp', kind: 'expired' }),
    )
    assert.equal(command, 'claude /login (on dev)')
    assert.equal(launched.length, 1)
    const cmd = launched[0] ?? ''
    assert.ok(cmd.includes('claude /login'))
    assert.ok(cmd.includes('command -v claude'), 'missing-CLI hint guard precedes the login')
    // The Shells tab for an SSH workspace is already a pty on the host, so the
    // command must not be wrapped in ssh — that nests ssh on the host with
    // this machine's identity/socket paths, which don't exist there.
    assert.ok(!/\bssh\b/.test(cmd), 'no ssh nesting in the typed command')
  })

  it('names the host in the question so the user knows where the sign-in happens', async () => {
    let asked = ''
    await runWithAskUserHandler(
      (req) => {
        asked = req.questions[0]?.question ?? ''
        return Promise.resolve({ answers: req.questions.map(() => 'Not now') })
      },
      () => offerAcpReauth({ agentId: 'claude-agent-acp', kind: 'required' }),
    )
    assert.match(asked, /SSH host dev/)
    assert.match(asked, /claude \/login/)
    assert.deepEqual(launched, [])
  })
})
