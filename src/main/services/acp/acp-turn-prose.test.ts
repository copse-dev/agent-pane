import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { EMPTY_ACP_TURN_PROSE, nextAcpTurnProse, type AcpTurnProse } from './acp-turn-prose.ts'

const fold = (chunks: StreamChunk[]): AcpTurnProse =>
  chunks.reduce(nextAcpTurnProse, EMPTY_ACP_TURN_PROSE)

const message = (text: string, messageId?: string): StreamChunk => ({
  type: 'acp_content',
  channel: 'message',
  content: { type: 'text', text },
  ...(messageId !== undefined ? { messageId } : {}),
})

describe('nextAcpTurnProse', () => {
  // Claude Agent ACP stamps every message with its API message id, which
  // arrives as `acp_content`, not `text`. Its words are still the answer.
  it('counts id-stamped message text as the agent’s prose', () => {
    const prose = fold([message('Checking ', 'msg_1'), message('the build.', 'msg_1')])
    assert.equal(prose.text, 'Checking the build.')
    assert.equal(prose.finalMessage, 'Checking the build.')
  })

  it('keeps plain text chunks too', () => {
    assert.equal(fold([{ type: 'text', text: 'Done.' }]).text, 'Done.')
  })

  it('starts a new final message when the message id changes', () => {
    const prose = fold([
      message('The session token has expired in the fixture.', 'msg_1'),
      message('Failed to authenticate: OAuth session expired', 'synthetic'),
    ])
    assert.equal(
      prose.text,
      'The session token has expired in the fixture.\n\nFailed to authenticate: OAuth session expired',
    )
    assert.equal(prose.finalMessage, 'Failed to authenticate: OAuth session expired')
  })

  it('keeps one blank line between id-stamped messages in the history text', () => {
    const prose = fold([
      message('Checking the build.', 'msg_1'),
      message('The build passes.', 'msg_2'),
      message('Done.\n', 'msg_3'),
      message('Bye.', 'msg_4'),
    ])
    assert.equal(prose.text, 'Checking the build.\n\nThe build passes.\n\nDone.\n\nBye.')
  })

  it('starts a new final message after a tool call', () => {
    const prose = fold([
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_call', toolCall: { id: 'read-1', name: 'read_file', args: {} } },
      { type: 'text', text: 'It is empty.' },
    ])
    assert.equal(prose.text, 'Reading the file.It is empty.')
    assert.equal(prose.finalMessage, 'It is empty.')
  })

  it('ignores reasoning and non-text content', () => {
    const prose = fold([
      { type: 'reasoning', text: 'thinking' },
      {
        type: 'acp_content',
        channel: 'thought',
        content: { type: 'text', text: 'more thinking' },
        messageId: 'thought-1',
      },
      {
        type: 'acp_content',
        channel: 'message',
        content: { type: 'image', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
        messageId: 'msg_1',
      },
    ])
    assert.deepEqual(prose, EMPTY_ACP_TURN_PROSE)
  })
})
