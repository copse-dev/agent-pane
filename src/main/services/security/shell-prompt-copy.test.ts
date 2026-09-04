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
import { analyzeShellCommand } from './shell-scope.ts'
import {
  formatExpectedSandboxBlockPromptParts,
  formatExternalSandboxPromptParts,
  formatShellPromptParts,
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
