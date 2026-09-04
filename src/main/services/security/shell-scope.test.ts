/**
 * The two behaviours of `analyzeShellCommand` that depend on facts only the app
 * knows — the chat store it mounts read-only and the scratch directories its
 * configured ACP agents declare — exercised through the app's re-export so the
 * `shell-guard-environment.ts` binding is what is under test. The classifier's
 * own tests live with the package.
 */
import { after, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { analyzeShellCommand } from './shell-scope.ts'
import { setSetting } from '../storage/settings.ts'

describe('analyzeShellCommand (app environment)', () => {
  const root = '/Users/me/project'

  describe('chat store (read-only seatbelt mount)', () => {
    const chatRoot = join(homedir(), '.copse', 'workspace')
    const threadFile = join(
      chatRoot,
      'e2e-mermaid-project/584472db-c76e-40b0-942a-3e5358d60a0c/blobs/archives/Plugin-Review/e833d1aa/agent-history.json',
    )

    it('does not flag reading an absolute chat-store path', () => {
      // The seatbelt overlay allowRead's the chat store, so this read is fully
      // contained — prompting to run it OUTSIDE the sandbox would be strictly
      // worse than letting it run inside.
      const r = analyzeShellCommand(`cat ${threadFile}`, root)
      assert.equal(r.verdict, 'sandbox', r.reasons.join('; '))
    })

    it('does not flag a read pipeline over the chat store', () => {
      const r = analyzeShellCommand(`cat ${threadFile} | jq .messages`, root)
      assert.equal(r.verdict, 'sandbox', r.reasons.join('; '))
      assert.equal(analyzeShellCommand(`rg needle ${chatRoot}`, root).verdict, 'sandbox')
    })

    it('does not flag the tilde spelling of a chat-store read', () => {
      const r = analyzeShellCommand('cat ~/.copse/workspace/proj/thread/agent-history.json', root)
      assert.equal(r.verdict, 'sandbox', r.reasons.join('; '))
    })

    it('waives the ~/ rule only when every tilde token is a chat-store read', () => {
      assert.equal(analyzeShellCommand('ls ~/', root).verdict, 'external')
      // A bare `~` alongside a chat-store read does not qualify for the waiver.
      assert.equal(analyzeShellCommand('cat ~/.copse/workspace/a.json ~', root).verdict, 'external')
      assert.equal(
        analyzeShellCommand('cat ~/.copse/workspace/a.json ~/.ssh/id_rsa', root).verdict,
        'external',
      )
    })

    it('still flags writes and deletes inside the chat store', () => {
      // allowWrite deliberately excludes the chat store, so these are real
      // escapes the sandbox would block.
      for (const cmd of [
        `rm ${threadFile}`,
        `mv ${threadFile} ${chatRoot}/other.json`,
        `echo x > ${threadFile}`,
      ]) {
        assert.equal(
          analyzeShellCommand(cmd, root).verdict,
          'external',
          `expected external: ${cmd}`,
        )
      }
    })

    it('still flags a sibling dir sharing the chat-store name prefix', () => {
      const r = analyzeShellCommand(`cat ${chatRoot}-stolen/x.json`, root)
      assert.equal(r.verdict, 'external')
      assert.ok(r.reasons.some((x) => x.includes('outside workspace')))
    })

    it('still flags a non-chat-store path read in the same command', () => {
      const r = analyzeShellCommand(`cat ${threadFile} /etc/passwd`, root)
      assert.equal(r.verdict, 'external')
    })
  })
})

describe('agent scratch directories', () => {
  const root = '/Users/me/project'
  const CLAUDE_AGENT = {
    id: 'claude-acp',
    title: 'Claude Code',
    command: 'claude-code-acp',
    enabled: true,
  }

  beforeEach(async () => {
    await setSetting('registeredAcpAgents', [CLAUDE_AGENT])
  })

  after(async () => {
    await setSetting('registeredAcpAgents', [])
  })

  it('contains a command whose scratch file is the agent TMPDIR', () => {
    // Claude Code exports TMPDIR=/tmp/claude, so a model obeying "put scratch in
    // $TMPDIR" writes here. The seatbelt allow-lists it; the classifier must agree.
    const r = analyzeShellCommand('node /tmp/claude/probe.js', root)
    assert.ok(!r.reasons.some((x) => /global temp path|absolute path outside workspace/.test(x)))
  })

  it('covers the /private twin and the bookkeeping glob', () => {
    for (const command of ['cat /private/tmp/claude/out.log', 'cat /tmp/claude-9f2a-cwd']) {
      const r = analyzeShellCommand(command, root)
      assert.equal(r.verdict, 'sandbox', command)
    }
  })

  it('still escalates when a non-scratch temp path rides along', () => {
    const r = analyzeShellCommand('cp /tmp/claude/probe.js /tmp/elsewhere/probe.js', root)
    assert.equal(r.verdict, 'external')
    assert.ok(r.reasons.some((x) => x.includes('global temp path')))
  })

  it('keeps the opaque-executable reason for the command that reported this', () => {
    // The dialog carried two reasons; only the path half was wrong. Executing a
    // workspace binary the agent could have authored must still prompt.
    const r = analyzeShellCommand(
      'env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/Copse.app/Contents/MacOS/Electron /tmp/claude/probe.js',
      root,
    )
    assert.equal(r.verdict, 'external')
    assert.deepEqual(r.reasons, [
      'executes an in-workspace file directly (contents opaque to analysis)',
    ])
  })

  it('waives nothing once the user disables the agent', async () => {
    await setSetting('registeredAcpAgents', [{ ...CLAUDE_AGENT, enabled: false }])
    const r = analyzeShellCommand('node /tmp/claude/probe.js', root)
    assert.equal(r.verdict, 'external')
    assert.ok(r.reasons.some((x) => x.includes('global temp path')))
  })

  it('waives nothing when the agent opts out of its sandbox preset', async () => {
    await setSetting('registeredAcpAgents', [{ ...CLAUDE_AGENT, sandbox: false }])
    const r = analyzeShellCommand('node /tmp/claude/probe.js', root)
    assert.equal(r.verdict, 'external')
  })

  it('does not waive another agent-shaped path that nothing declares', () => {
    const r = analyzeShellCommand('cat /tmp/claudette/x', root)
    assert.equal(r.verdict, 'external')
  })
})
