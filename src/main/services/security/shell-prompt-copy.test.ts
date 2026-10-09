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
import { UNSANDBOXED_ACCESS_WARNING } from '@shared/approval-copy.ts'
import { PRIOR_DENIAL_MARKER } from './denied-operations.ts'
import { analyzeShellCommand } from './shell-scope.ts'
import { formatUnsandboxedPromptParts } from './sandbox-failure.ts'
import {
  formatExpectedSandboxBlockPromptParts,
  formatExternalSandboxPromptParts,
  formatShellPromptParts,
  shellPromptToApprovalFields,
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
        "• Runs code written or built inside the command itself, so Copse can't tell what it does" +
        `\n\n${UNSANDBOXED_ACCESS_WARNING}`,
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
      '',
      UNSANDBOXED_ACCESS_WARNING,
    ])
  })

  it('still says why when the caller had no reasons to pass on', () => {
    const { bodyAdvice } = formatExternalSandboxPromptParts('some-tool', [])
    assert.equal(
      bodyAdvice,
      'The project sandbox would block this command:\n• Needs network or outside-project access' +
        `\n\n${UNSANDBOXED_ACCESS_WARNING}`,
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
        'It is asking to run outside the sandbox up front, rather than letting it fail inside first.' +
        `\n\n${UNSANDBOXED_ACCESS_WARNING}`,
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
      ...Array.from({ length: 30 }, (_, i) => `gh search prs --limit 100 "q${String(i)}"`),
    ].join('\n')
    const mega = live + '\n' + 'x'.repeat(900)

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

    // Live command is only in the independently scrollable monospaced body. It
    // stays complete: approval must never authorize undisclosed shell text.
    assert.equal(fields.body, mega)
    assert.ok(!fields.body.includes(prior))

    assert.match(fields.bodyFooter ?? '', /Allow running it once outside the sandbox/)
  })

  it('keeps long commands complete on the post-failure escalation path', () => {
    const mega = Array.from({ length: 17 }, (_, i) => `echo ${String(i)}`).join('\n')
    const prior =
      'git fetch needs network access that was denied\n\n' +
      `${PRIOR_DENIAL_MARKER} (matched command: "git fetch origin main").`
    const parts = formatUnsandboxedPromptParts(mega, [prior, 'sandbox violation'])
    const fields = shellPromptToApprovalFields(parts)

    assert.match(fields.bodyAdvice ?? '', new RegExp(PRIOR_DENIAL_MARKER))
    assert.match(fields.bodyAdvice ?? '', /failed inside the project sandbox \(sandbox violation\)/)
    assert.doesNotMatch(
      fields.bodyAdvice ?? '',
      /failed inside the project sandbox \(.*Earlier in this thread/,
    )
    assert.equal(fields.body, mega)
    assert.equal(fields.bodyFooter, 'Allow running it once without sandbox restrictions?')
  })
})

describe('shell execution boundary copy', () => {
  it('explains project damage inside the sandbox and keeps the command complete', () => {
    const parts = formatShellPromptParts('rm -rf build', ['recursive/forced delete (rm -rf)'])
    assert.equal(parts.command, 'rm -rf build')
    assert.match(parts.bodyAdvice ?? '', /inside the project sandbox/)
    assert.match(parts.bodyAdvice ?? '', /Deletes files and folders recursively/)
    assert.doesNotMatch(parts.bodyAdvice ?? '', /user account’s access/)
  })
  it('warns about host access even if auto-run being off is the only reason', () => {
    const parts = formatShellPromptParts(
      'node --version',
      ['Auto-run for sandbox commands is disabled in Settings'],
      false,
    )
    assert.equal(parts.command, 'node --version')
    assert.match(parts.bodyAdvice ?? '', /sandbox is unavailable/)
    assert.ok(parts.bodyAdvice?.includes(UNSANDBOXED_ACCESS_WARNING))
  })
  it('warns about unrestricted access on every escape path', () => {
    for (const format of [
      formatExternalSandboxPromptParts,
      formatExpectedSandboxBlockPromptParts,
      formatUnsandboxedPromptParts,
    ]) {
      const parts = format('gh pr create --title "Fix" --body "Review"', [
        'GitHub CLI (may reach GitHub)',
      ])
      assert.ok(parts.bodyAdvice?.includes(UNSANDBOXED_ACCESS_WARNING))
      assert.match(parts.bodyAdvice ?? '', /publishes a pull request/)
    }
  })
})
