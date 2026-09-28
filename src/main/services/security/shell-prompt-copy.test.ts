/**
 * The approval prompts a person actually reads.
 *
 * Reasons travel as rule identifiers (`inline script (interpreter -c/-e/--eval)`)
 * because the classifier dedupes on them and the decision spine stores them.
 * These tests pin the other end of that pipe: what reaches the dialog is a
 * sentence about the command, and each distinct concern is stated once.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PRIOR_DENIAL_MARKER } from './denied-operations.ts'
import { analyzeShellCommand } from './shell-scope.ts'
import { formatUnsandboxedPromptParts } from './sandbox-failure.ts'
import {
  formatExpectedSandboxBlockPromptParts,
  formatExternalSandboxPromptParts,
  formatShellPromptParts,
  SHELL_APPROVAL_COMMAND_MAX_CHARS,
  SHELL_APPROVAL_COMMAND_MAX_LINES,
  shellPromptToApprovalFields,
  truncateShellCommandForApproval,
} from './permission-policy.ts'

const root = '/Users/me/project'

describe('outside-sandbox approval copy', () => {
  it('explains an opaque interpreter command without classifier jargon', () => {
    const command = `python3 - <<'PY'\nprint(1)\nPY\npython3 -c "print(2)"`
    const { bodyAdvice, bodyFooter } = formatExternalSandboxPromptParts(
      command,
      analyzeShellCommand(command, root).reasons,
    )

    assert.equal(
      bodyAdvice,
      'The project sandbox would block this command:\n' +
        "• Runs code written or built inside the command itself, so Copse can't tell what it does",
    )
    assert.equal(bodyFooter, 'Allow running it once outside the sandbox?')
  })

  it('lists several distinct concerns one per line', () => {
    const command = 'curl -sL https://example.com/x > ~/notes.txt'
    const { bodyAdvice } = formatExternalSandboxPromptParts(
      command,
      analyzeShellCommand(command, root).reasons,
    )

    assert.deepEqual(bodyAdvice?.split('\n'), [
      'The project sandbox would block this command:',
      '• Downloads from the internet (curl/wget)',
      '• Reads or writes in your home directory, outside the project',
    ])
  })

  it('still says why when the caller had no reasons to pass on', () => {
    const { bodyAdvice } = formatExternalSandboxPromptParts('some-tool', [])
    assert.equal(
      bodyAdvice,
      'The project sandbox would block this command:\n• Needs network or outside-project access',
    )
  })

  it('names no platform, because the sandbox is seatbelt or bubblewrap', () => {
    const { bodyAdvice } = formatExternalSandboxPromptParts('curl https://example.com', [
      'network download (curl/wget)',
    ])
    assert.doesNotMatch(bodyAdvice ?? '', /macOS|Linux/)
  })

  it('keeps an expected block worded as an expectation', () => {
    const { bodyAdvice, bodyFooter } = formatExpectedSandboxBlockPromptParts('gh pr list', [
      'GitHub CLI (may reach GitHub)',
    ])

    assert.equal(
      bodyAdvice,
      'The agent expects the project sandbox to block this command:\n' +
        '• Runs the GitHub CLI, which may reach GitHub\n\n' +
        'It is asking to run outside the sandbox up front, rather than letting it fail inside first.',
    )
    assert.match(bodyFooter ?? '', /not a confirmed sandbox block/)
  })

  it('puts cached denial advice in its own block, not a reason bullet with the live command', () => {
    const prior =
      'gh could not read its own config at ~/.config/gh (operation not permitted) — this needs ' +
      'read access outside the workspace, not the network, and is specific to gh.\n\n' +
      `${PRIOR_DENIAL_MARKER} (matched command: "set -o pipefail; gh pr list").`
    const live = [
      'set -o pipefail',
      ...Array.from({ length: 30 }, (_, i) => `gh search prs --limit 100 "q${i}"`),
    ].join('\n')
    // Pad so the live script clearly exceeds the monospaced preview budget.
    const mega = live + '\n' + 'x'.repeat(SHELL_APPROVAL_COMMAND_MAX_CHARS)

    const parts = formatExpectedSandboxBlockPromptParts(mega, [
      prior,
      'GitHub CLI (may reach GitHub)',
      'inline script (interpreter -c/-e/--eval)',
    ])
    const fields = shellPromptToApprovalFields(parts)

    // Advice: prior note, then lead-in + bullets, then trailing expectation — never
    // the live multi-line script, and no unclosed backticks from a prior command.
    assert.match(fields.bodyAdvice ?? '', new RegExp(PRIOR_DENIAL_MARKER))
    assert.match(fields.bodyAdvice ?? '', /The agent expects the project sandbox to block/)
    assert.match(fields.bodyAdvice ?? '', /• Runs the GitHub CLI/)
    assert.doesNotMatch(fields.bodyAdvice ?? '', /`/)
    assert.doesNotMatch(fields.bodyAdvice ?? '', /gh search prs --limit 100 "q29"/)
    // Prior denial is not rendered as a bullet that also holds the command.
    assert.doesNotMatch(fields.bodyAdvice ?? '', new RegExp(`•[^\n]*${PRIOR_DENIAL_MARKER}`))

    // Live command is only in the monospaced body, truncated with a clear remainder.
    assert.notEqual(fields.body, mega)
    assert.match(fields.body, /\n… \(\+/)
    assert.match(fields.body, /more (lines|characters)/)
    assert.ok(fields.body.length < mega.length)
    assert.ok(!fields.body.includes(prior))

    assert.match(fields.bodyFooter ?? '', /Allow running it once outside the sandbox/)
  })

  it('truncates long commands the same way on the post-failure escalation path', () => {
    const mega = Array.from({ length: SHELL_APPROVAL_COMMAND_MAX_LINES + 5 }, (_, i) => `echo ${i}`).join(
      '\n',
    )
    const prior =
      'git fetch needs network access that was denied\n\n' +
      `${PRIOR_DENIAL_MARKER} (matched command: "git fetch origin main").`
    const parts = formatUnsandboxedPromptParts(mega, [prior, 'sandbox violation'])
    const fields = shellPromptToApprovalFields(parts)

    assert.match(fields.bodyAdvice ?? '', new RegExp(PRIOR_DENIAL_MARKER))
    assert.match(fields.bodyAdvice ?? '', /failed inside the project sandbox \(sandbox violation\)/)
    assert.doesNotMatch(fields.bodyAdvice ?? '', /failed inside the project sandbox \(.*Earlier in this thread/)
    assert.match(fields.body, /\n… \(\+/)
    assert.equal(fields.bodyFooter, 'Allow running it once without sandbox restrictions?')
  })

  it('truncateShellCommandForApproval reports remaining characters for a single long line', () => {
    const long = 'a'.repeat(SHELL_APPROVAL_COMMAND_MAX_CHARS + 200)
    const out = truncateShellCommandForApproval(long)
    assert.match(out, /\+200 more characters/)
    assert.ok(out.startsWith('a'.repeat(SHELL_APPROVAL_COMMAND_MAX_CHARS)))
  })
})

describe('in-sandbox approval copy', () => {
  it('explains why a contained command is still being asked about', () => {
    const command = 'rm -rf build'
    const { bodyFooter } = formatShellPromptParts(command, [
      'recursive/forced delete (rm -rf)',
      'find -delete bulk removal',
    ])

    assert.equal(
      bodyFooter,
      'Why this needs approval:\n' +
        '• Deletes files and folders recursively (rm -rf)\n' +
        '• Deletes every file a search matches (find -delete)',
    )
  })

  it('omits the footer entirely when there is nothing to explain', () => {
    assert.deepEqual(formatShellPromptParts('ls -la', []), { command: 'ls -la' })
  })
})
