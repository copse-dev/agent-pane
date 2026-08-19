import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { ACP_UNSUPPORTED_ON_SSH_MESSAGE } from '@shared/acp.ts'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  AcpTurnFailure,
  acpErrorMessage,
  buildAcpPrompt,
  buildAcpPromptContent,
  isAcpConnectionDropped,
  isRetryableAcpError,
  isTransientProviderError,
  probeAcpAgentForSettings,
  permissionResponseFor,
  mergeAcpPermissionAbortSignals,
  runAcpAgentFromSettings,
  shouldAutoApproveLowRiskAcpPermission,
  shouldAutoApproveSandboxedCodexCodeMode,
  runWithAcpRetry,
  sliceLines,
} from './acp-agent-service.ts'

const ALLOW_ONCE: PermissionOption = { optionId: 'a1', name: 'Allow once', kind: 'allow_once' }
const ALLOW_ALWAYS: PermissionOption = {
  optionId: 'a2',
  name: 'Always allow',
  kind: 'allow_always',
}
const REJECT_ONCE: PermissionOption = { optionId: 'r1', name: 'Reject', kind: 'reject_once' }

function permissionRequest(
  toolCall: Partial<RequestPermissionRequest['toolCall']>,
): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', ...toolCall },
    options: [ALLOW_ONCE, REJECT_ONCE],
  }
}

describe('shouldAutoApproveLowRiskAcpPermission', () => {
  it('auto-approves ACP read/search only when the agent is sandboxed', () => {
    assert.equal(
      shouldAutoApproveLowRiskAcpPermission(permissionRequest({ kind: 'read' }), {
        sandboxed: true,
      }),
      true,
    )
    assert.equal(
      shouldAutoApproveLowRiskAcpPermission(permissionRequest({ kind: 'search' }), {
        sandboxed: false,
      }),
      false,
    )
  })

  it('leaves ACP execute requests to the shared shell approval flow', () => {
    assert.equal(
      shouldAutoApproveLowRiskAcpPermission(
        permissionRequest({ kind: 'execute', rawInput: { command: 'rg TODO src | head -20' } }),
        { sandboxed: true },
      ),
      false,
    )
  })
})

describe('shouldAutoApproveSandboxedCodexCodeMode', () => {
  const opaqueCodexExec: RequestPermissionRequest = {
    ...permissionRequest({ kind: 'execute' }),
    _meta: { codex: { params: { itemId: 'exec-1' } } },
  }

  it('auto-approves only an opaque Codex code-mode cell inside the native sandbox', () => {
    assert.equal(
      shouldAutoApproveSandboxedCodexCodeMode({ id: 'codex', sandboxed: true }, opaqueCodexExec),
      true,
    )
    assert.equal(
      shouldAutoApproveSandboxedCodexCodeMode({ id: 'codex', sandboxed: false }, opaqueCodexExec),
      false,
    )
    assert.equal(
      shouldAutoApproveSandboxedCodexCodeMode({ id: 'custom', sandboxed: true }, opaqueCodexExec),
      false,
    )
  })

  it('does not waive a concrete command or an unproven adapter request', () => {
    assert.equal(
      shouldAutoApproveSandboxedCodexCodeMode(
        { id: 'codex', sandboxed: true },
        {
          ...opaqueCodexExec,
          toolCall: { ...opaqueCodexExec.toolCall, rawInput: { command: 'npm publish' } },
        },
      ),
      false,
    )
    assert.equal(
      shouldAutoApproveSandboxedCodexCodeMode(
        { id: 'codex', sandboxed: true },
        permissionRequest({ kind: 'execute' }),
      ),
      false,
    )
  })
})

describe('permissionResponseFor', () => {
  it('selects a one-shot allow option on approval, preferring allow_once', () => {
    const res = permissionResponseFor([ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE], true)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a1' })
  })

  it('falls back to allow_always when no one-shot allow is offered', () => {
    const res = permissionResponseFor([ALLOW_ALWAYS, REJECT_ONCE], true)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a2' })
  })

  it('selects a reject option on denial', () => {
    const res = permissionResponseFor([ALLOW_ONCE, REJECT_ONCE], false)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'r1' })
  })

  it('cancels when the agent offered no option of the needed polarity', () => {
    assert.deepEqual(permissionResponseFor([REJECT_ONCE], true).outcome, { outcome: 'cancelled' })
    assert.deepEqual(permissionResponseFor([ALLOW_ONCE], false).outcome, { outcome: 'cancelled' })
  })

  it('prefers allow_always for remembered grants so the agent stops asking too', () => {
    const res = permissionResponseFor([ALLOW_ONCE, ALLOW_ALWAYS], true, { preferAlways: true })
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a2' })
  })

  it('falls back to allow_once when a remembered grant has no allow_always option', () => {
    const res = permissionResponseFor([ALLOW_ONCE, REJECT_ONCE], true, { preferAlways: true })
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a1' })
  })
})

describe('mergeAcpPermissionAbortSignals', () => {
  it('returns the rpc signal when no turn signal is provided', () => {
    const rpc = new AbortController().signal
    assert.equal(mergeAcpPermissionAbortSignals(undefined, rpc), rpc)
  })

  it('combines turn and rpc signals so either abort is observed', async () => {
    const turn = new AbortController()
    const rpc = new AbortController()
    const merged = mergeAcpPermissionAbortSignals(turn.signal, rpc.signal)
    const pending = waitForAbort(merged)
    turn.abort()
    await pending
    assert.equal(merged.aborted, true)
  })
})

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve()
      },
      { once: true },
    )
  })
}

describe('sliceLines', () => {
  const file = 'one\ntwo\nthree\nfour\n'

  it('returns the whole file when no line/limit is given', () => {
    assert.equal(sliceLines(file), file)
  })

  it('slices from a 1-based start line', () => {
    assert.equal(sliceLines(file, 2), 'two\nthree\nfour\n')
  })

  it('applies a max line count from the start', () => {
    assert.equal(sliceLines(file, 2, 2), 'two\nthree')
    assert.equal(sliceLines(file, 1, 1), 'one')
  })
})

describe('acpErrorMessage', () => {
  it('includes JSON-RPC error.data.details when present', () => {
    const err = new Error('Internal error')
    Object.defineProperty(err, 'data', {
      value: {
        details: "Claude Code process exited with code 1. stderr: error: unknown option '--tools'",
      },
    })

    assert.equal(
      acpErrorMessage(err),
      "Internal error: Claude Code process exited with code 1. stderr: error: unknown option '--tools'",
    )
  })

  it('falls back to the base message when there is no structured detail', () => {
    assert.equal(acpErrorMessage(new Error('ACP connection closed')), 'ACP connection closed')
  })
})

describe('isTransientProviderError', () => {
  it('matches transient provider failures surfaced as opaque agent text', () => {
    assert.ok(isTransientProviderError(new Error('Internal error: API Error: Overloaded')))
    assert.ok(isTransientProviderError(new Error('429 rate_limit_error')))
    assert.ok(isTransientProviderError(new Error('upstream returned 503')))
    assert.ok(isTransientProviderError(new Error('Internal Server Error')))
  })

  it('matches transient provider failures in JSON-RPC error.data.details', () => {
    const err = new Error('Internal error')
    Object.defineProperty(err, 'data', {
      value: { details: 'Claude Code process exited after upstream returned 503' },
    })

    assert.ok(isTransientProviderError(err))
  })

  it('does not treat a dropped connection as a provider error', () => {
    assert.ok(!isTransientProviderError(new Error('ACP connection closed')))
  })
})

describe('isAcpConnectionDropped', () => {
  it('matches a closed connection or dead agent process', () => {
    // The exact string the SDK surfaces when the agent process dies mid-turn.
    assert.ok(isAcpConnectionDropped(new Error('ACP connection closed')))
    assert.ok(isAcpConnectionDropped(new Error('read ECONNRESET')))
    assert.ok(isAcpConnectionDropped(new Error('write EPIPE')))
    assert.ok(isAcpConnectionDropped(new Error('Premature close')))
    assert.ok(isAcpConnectionDropped(new Error('write after end')))
    assert.ok(isAcpConnectionDropped(new Error('ProcessTransport is not ready for writing')))
    assert.ok(isAcpConnectionDropped(new Error('Query closed before response received')))
    assert.ok(isAcpConnectionDropped(new Error('Claude Code process exited with code 143')))
  })

  it('matches dropped connections in JSON-RPC error.data.details', () => {
    const err = new Error('Internal error')
    Object.defineProperty(err, 'data', {
      value: { details: 'Claude Code process exited with code 1. stderr: auth expired' },
    })

    assert.ok(isAcpConnectionDropped(err))
  })

  it('does not match provider errors or ordinary failures', () => {
    assert.ok(!isAcpConnectionDropped(new Error('Internal error: API Error: Overloaded')))
    assert.ok(!isAcpConnectionDropped(new Error('401 Unauthorized')))
    assert.ok(!isAcpConnectionDropped(new Error('Write to src/a.ts was rejected by the user.')))
  })
})

describe('isRetryableAcpError', () => {
  it('retries transient provider failures surfaced as opaque agent text', () => {
    assert.ok(isRetryableAcpError(new Error('Internal error: API Error: Overloaded')))
    assert.ok(isRetryableAcpError(new Error('429 rate_limit_error')))
    assert.ok(isRetryableAcpError(new Error('upstream returned 503')))
    assert.ok(isRetryableAcpError(new Error('Internal Server Error')))
  })

  it('does not retry a dropped connection because the agent may have run unseen work', () => {
    assert.ok(!isRetryableAcpError(new Error('ACP connection closed')))
    assert.ok(!isRetryableAcpError(new Error('write EPIPE')))
  })

  it('rejects non-transient failures', () => {
    assert.ok(!isRetryableAcpError(new Error('401 Unauthorized')))
    assert.ok(!isRetryableAcpError(new Error('ACP agent "x" is not configured or is disabled.')))
    assert.ok(!isRetryableAcpError(new Error('Write to src/a.ts was rejected by the user.')))
  })
})

describe('runWithAcpRetry', () => {
  const noAbort = new AbortController().signal
  const overloaded = (): Error => new Error('Internal error: API Error: Overloaded')

  it('retries a no-progress transient failure and succeeds', async () => {
    let attempts = 0
    const result = await runWithAcpRetry(
      () => {
        attempts++
        return attempts < 3 ? Promise.reject(overloaded()) : Promise.resolve('ok')
      },
      { signal: noAbort, hasProgress: () => false, delayMs: () => 0 },
    )
    assert.equal(result, 'ok')
    assert.equal(attempts, 3)
  })

  it('does not retry a dropped connection even with no visible progress', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(new Error('ACP connection closed'))
        },
        { signal: noAbort, hasProgress: () => false, delayMs: () => 0 },
      ),
      /connection closed/,
    )
    assert.equal(attempts, 1)
  })

  it('does not retry a dropped connection once the turn streamed something', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(new Error('ACP connection closed'))
        },
        { signal: noAbort, hasProgress: () => true, delayMs: () => 0 },
      ),
      /connection closed/,
    )
    assert.equal(attempts, 1)
  })

  it('does not retry once the turn has made visible progress', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(overloaded())
        },
        { signal: noAbort, hasProgress: () => true, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 1)
  })

  it('does not retry non-transient failures', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(new Error('401 Unauthorized'))
        },
        { signal: noAbort, hasProgress: () => false, delayMs: () => 0 },
      ),
      /401/,
    )
    assert.equal(attempts, 1)
  })

  it('gives up after maxAttempts', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(overloaded())
        },
        { signal: noAbort, hasProgress: () => false, maxAttempts: 2, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 2)
  })

  it('does not retry after the turn is aborted', async () => {
    const controller = new AbortController()
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          controller.abort()
          return Promise.reject(overloaded())
        },
        { signal: controller.signal, hasProgress: () => false, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 1)
  })
})

describe('AcpTurnFailure', () => {
  it('keeps the underlying message so classifyAgentError still matches it', () => {
    const failure = new AcpTurnFailure(new Error('Internal error: API Error: Overloaded'), {
      assistantText: 'partial answer',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    assert.equal(failure.message, 'Internal error: API Error: Overloaded')
    assert.equal(failure.partial.assistantText, 'partial answer')
    assert.deepEqual(failure.partial.usage, { inputTokens: 10, outputTokens: 5 })
  })
})

describe('buildAcpPrompt', () => {
  it('always leads with the session notes', () => {
    const prompt = buildAcpPrompt('hello', [])
    assert.match(prompt, /^Session notes: this session persists across turns/)
    assert.match(prompt, /hello$/)
    // Post-#621 the note must NOT scare the agent off background subagents —
    // sessions are pooled per thread and background work survives the turn
    // (#588); the real constraints are the idle reap and app shutdown. The
    // context-burning find/ls steer stays.
    assert.match(prompt, /background or async\s+subagents survive/i)
    assert.doesNotMatch(prompt, /will NOT survive/i)
    // Since the between-turn update pump (#588), completions surface live —
    // the note must not tell the agent results wait for the next turn.
    assert.match(prompt, /surface in the thread\s+live as they complete/i)
    assert.doesNotMatch(prompt, /delivered when the\s+next turn starts/i)
    assert.match(prompt, /reaped after ~10 idle minutes/)
    assert.match(prompt, /targeted searches/)
  })

  it('adds the sandbox note only for sandboxed turns', () => {
    const sandboxed = buildAcpPrompt('hello', [], { sandboxed: true })
    assert.match(sandboxed, /Environment note: this session runs inside a filesystem sandbox/)
    assert.match(sandboxed, /hello$/)
    // The note must steer away from hardcoded /tmp, distinguish the agent's
    // private shell from Copse's bridge, and point at the shared escape path.
    assert.match(sandboxed, /\$TMPDIR/)
    assert.match(sandboxed, /cannot unsandbox your own shell/i)
    assert.match(sandboxed, /copse[\s\S]+run_shell/i)
    assert.match(sandboxed, /approved external work outside this sandbox/i)
    // The GitHub steer is appended to the sandbox note: bridge first, no
    // github.com on the agent allowlist by default.
    assert.match(sandboxed, /GitHub and CI tools/i)
    assert.match(sandboxed, /sandbox\.allowedDomains/)
    assert.doesNotMatch(buildAcpPrompt('hello', [], { sandboxed: false }), /Environment note:/)
  })

  it('places the notes ahead of the replayed transcript', () => {
    const prompt = buildAcpPrompt('next', [{ role: 'user', content: 'earlier' }], {
      sandboxed: true,
    })
    assert.match(prompt, /^Session notes:/)
    assert.match(prompt, /Environment note:/)
    assert.match(prompt, /User: earlier/)
    assert.match(prompt, /--- New message ---\nnext$/)
  })

  it('replays prior user/assistant turns as a preamble for a fresh session', () => {
    const prompt = buildAcpPrompt('and now?', [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ])
    assert.match(prompt, /User: first question/)
    assert.match(prompt, /Assistant: first answer/)
    assert.match(prompt, /--- New message ---\nand now\?$/)
    assert.doesNotMatch(prompt, /ignored/) // system prompts are dropped
  })

  it('flattens array user content to its text blocks', () => {
    const prompt = buildAcpPrompt(
      [{ type: 'text', text: 'look at this' }],
      [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }],
    )
    assert.match(prompt, /User: earlier/)
    assert.match(prompt, /look at this$/)
  })

  it('appends the invoked-skills block after the current message', () => {
    // An external ACP agent has its own skill catalog and never sees Copse's, so
    // the resolved SKILL.md instructions must travel inlined with the turn.
    const prompt = buildAcpPrompt('The user invoked /demo. Follow the skill instructions.', [], {
      skills:
        '\n\n---\n\n## Invoked skills\n\n<skill_content name="demo">do the thing</skill_content>',
    })
    assert.match(prompt, /The user invoked \/demo\./)
    assert.match(prompt, /## Invoked skills/)
    assert.match(prompt, /do the thing<\/skill_content>$/)
  })

  it('keeps the user message verbatim and frames trusted Copse guidance separately', () => {
    const user = 'Build a polished coming-soon site for Crumb & Bloom. Include an email signup.'
    const guidance = 'Inspect the project, choose a coherent visual direction, then verify it.'
    const prompt = buildAcpPrompt(user, [], {
      includeNotes: false,
      operatorInstructions: guidance,
    })
    assert.equal(
      prompt,
      `${user}\n\n---\n\n## Copse guidance\n\n${guidance}`,
      'product steering must be an explicit adjacent block, never a rewrite of the visible prompt',
    )
  })

  it('places product guidance before explicitly invoked skills', () => {
    const prompt = buildAcpPrompt('Build the website', [], {
      includeNotes: false,
      operatorInstructions: 'Follow the site-building workflow.',
      skills: '\n\n---\n\n## Invoked skills\n\nUSER-SELECTED-SKILL',
    })
    const guidanceIndex = prompt.indexOf('## Copse guidance')
    const skillIndex = prompt.indexOf('## Invoked skills')
    assert.ok(guidanceIndex > 0)
    assert.ok(skillIndex > guidanceIndex)
    assert.match(prompt, /USER-SELECTED-SKILL$/)
  })

  it('sends current-turn guidance on a reused ACP session without replay notes', () => {
    const prompt = buildAcpPrompt('Polish the landing page', [], {
      includeNotes: false,
      operatorInstructions: 'Verify responsive behavior.',
    })
    assert.doesNotMatch(prompt, /^Session notes:/)
    assert.match(prompt, /^Polish the landing page/)
    assert.match(prompt, /## Copse guidance\n\nVerify responsive behavior\.$/)
  })

  it('keeps the invoked-skills block with the new message when replaying a transcript', () => {
    const prompt = buildAcpPrompt('go', [{ role: 'user', content: 'earlier' }], {
      skills: '\n\n## Invoked skills\n\nBODY',
    })
    assert.match(prompt, /--- New message ---\ngo\n\n## Invoked skills\n\nBODY$/)
  })
})

describe('buildAcpPromptContent', () => {
  it('returns a single text block when images are not requested', () => {
    const blocks = buildAcpPromptContent(
      [
        { type: 'text', text: 'describe this' },
        { type: 'image', dataUrl: 'data:image/png;base64,abc123' },
      ],
      [],
      { includeNotes: false },
    )
    assert.equal(blocks.length, 1)
    const first = blocks[0]
    assert.ok(first)
    assert.equal(first.type, 'text')
    assert.match(first.text, /describe this$/)
  })

  it('appends ACP image content blocks when includeImages is true (issue #831)', () => {
    const blocks = buildAcpPromptContent(
      [
        { type: 'text', text: 'what is in this screenshot?' },
        { type: 'image', dataUrl: 'data:image/png;base64,abc123' },
        { type: 'image', dataUrl: 'data:image/jpeg;base64,def456' },
      ],
      [],
      { includeNotes: false, includeImages: true },
    )
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0]?.type, 'text')
    assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'abc123' })
    assert.deepEqual(blocks[2], { type: 'image', mimeType: 'image/jpeg', data: 'def456' })
  })

  it('still produces a text block for image-only prompts when images are included', () => {
    const blocks = buildAcpPromptContent(
      [{ type: 'image', dataUrl: 'data:image/png;base64,onlyimg' }],
      [],
      { includeNotes: false, includeImages: true },
    )
    assert.equal(blocks.length, 2)
    const first = blocks[0]
    assert.ok(first)
    assert.equal(first.type, 'text')
    assert.equal(first.text, '')
    assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'onlyimg' })
  })
})

describe('ACP on SSH workspaces', () => {
  beforeEach(async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: '/remote/project', sshHost: 'dev' }])
    setWorkspaceRootForTest('/remote/project')
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('rejects session open and model detect with a clear unsupported message', async () => {
    await assert.rejects(
      () =>
        runAcpAgentFromSettings({
          threadId: 't1',
          agentId: 'cursor',
          userPrompt: 'hi',
          priorMessages: [],
          signal: new AbortController().signal,
          onChunk: () => undefined,
        }),
      (err: unknown) => err instanceof Error && err.message === ACP_UNSUPPORTED_ON_SSH_MESSAGE,
    )
    await assert.rejects(
      () => probeAcpAgentForSettings('cursor'),
      (err: unknown) => err instanceof Error && err.message === ACP_UNSUPPORTED_ON_SSH_MESSAGE,
    )
  })

  it('lifts the SSH block once remote ACP is opted in', async () => {
    await setSetting('acpOverSshEnabled', true)
    // The agent isn't registered here, so it now fails PAST the SSH guard with a
    // different error — proving the guard no longer short-circuits on SSH.
    await assert.rejects(
      () =>
        runAcpAgentFromSettings({
          threadId: 't1',
          agentId: 'cursor',
          userPrompt: 'hi',
          priorMessages: [],
          signal: new AbortController().signal,
          onChunk: () => undefined,
        }),
      (err: unknown) => err instanceof Error && err.message !== ACP_UNSUPPORTED_ON_SSH_MESSAGE,
    )
  })
})
