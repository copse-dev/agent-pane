import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PASTE_PLACEHOLDER,
  projectPromptTextForDisplay,
  replayPromptText,
  stripPastePlaceholders,
} from './prompt-placeholders.ts'
import { renderTextBlock } from '@copse/agent/build-text-with-attachments.ts'

describe('stripPastePlaceholders', () => {
  it('leaves a prompt without placeholders alone (beyond trimming)', () => {
    assert.equal(stripPastePlaceholders('  Fix the login bug  '), 'Fix the login bug')
  })

  it('removes a placeholder and the double space it leaves behind', () => {
    assert.equal(
      stripPastePlaceholders(`Look at ${PASTE_PLACEHOLDER} and explain`),
      'Look at and explain',
    )
  })

  it('removes several placeholders in one prompt', () => {
    const content = `${PASTE_PLACEHOLDER} vs ${PASTE_PLACEHOLDER} — which?`
    assert.equal(stripPastePlaceholders(content), 'vs — which?')
  })

  it('does not collapse the line structure of a multi-line prompt', () => {
    const content = `First line ${PASTE_PLACEHOLDER}\nSecond line`
    assert.equal(stripPastePlaceholders(content), 'First line\nSecond line')
  })

  it('returns empty for a prompt that was nothing but a paste', () => {
    assert.equal(stripPastePlaceholders(PASTE_PLACEHOLDER), '')
  })
})

describe('replayPromptText', () => {
  it('preserves exact reviewed bytes, including literal placeholders and whitespace', () => {
    const canonical = `  before ${PASTE_PLACEHOLDER} after  \n\n`
    assert.equal(
      replayPromptText(canonical, [{ projection: 'canonical-block' }], undefined),
      canonical,
    )
    assert.equal(replayPromptText(canonical, [], 'canonical-provider'), canonical)
  })

  it('still cleans optimistic placeholders without Main-owned provenance', () => {
    assert.equal(
      replayPromptText(`Look at ${PASTE_PLACEHOLDER}  please`, [{}], undefined),
      'Look at please',
    )
  })
})

describe('projectPromptTextForDisplay', () => {
  it('projects only Main-authenticated canonical paste blocks back to chip positions', () => {
    const attachment = {
      kind: 'paste' as const,
      label: 'Editor notes',
      placement: 'inline' as const,
      projection: 'canonical-block' as const,
      content: 'Keep the first paragraph.',
    }
    const canonical = `Summarize this:\n\n${renderTextBlock(attachment.label, attachment.content)}`

    assert.equal(
      projectPromptTextForDisplay(canonical, [attachment], 'canonical-provider'),
      `Summarize this:\n\n${PASTE_PLACEHOLDER}`,
    )
    assert.equal(projectPromptTextForDisplay(canonical, [attachment], undefined), canonical)
  })

  it('projects reviewed thread labels without changing later provider context', () => {
    const attachment = {
      kind: 'thread' as const,
      label: 'Auth refactor',
      placement: 'inline' as const,
      projection: 'canonical-thread-label' as const,
    }
    const canonical = `Compare @Auth refactor\n\nThread context: @Auth refactor`

    assert.equal(
      projectPromptTextForDisplay(canonical, [attachment], 'canonical-provider'),
      `Compare ${PASTE_PLACEHOLDER}\n\nThread context: @Auth refactor`,
    )
  })

  it('removes a reviewed trailing shell block while retaining its transcript chip', () => {
    const attachment = {
      kind: 'shell' as const,
      label: 'Run · git rebase --continue · exit 0',
      projection: 'canonical-block' as const,
      content: 'Successfully rebased and updated refs/heads/topic.',
    }
    const canonical = `Continue after recovery.\n\n${renderTextBlock(
      `Shell: ${attachment.label}`,
      attachment.content,
    )}`

    assert.equal(
      projectPromptTextForDisplay(canonical, [attachment], 'canonical-provider'),
      'Continue after recovery.',
    )
  })
})
