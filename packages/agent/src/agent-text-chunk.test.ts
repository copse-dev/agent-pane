import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planAgentTextChunk, type AgentTextChunkState } from './agent-text-chunk.ts'

describe('planAgentTextChunk', () => {
  it('starts a new message for the first visible text chunk', () => {
    const { plan } = planAgentTextChunk({ msgId: null, toolSinceText: false }, 'Hello')
    assert.deepEqual(plan, {
      action: 'append',
      text: 'Hello',
      startNewMessage: true,
    })
  })

  it('appends whitespace-only chunks to an active message', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: false }, '\n\n')
    assert.deepEqual(plan, {
      action: 'append',
      text: '\n\n',
      startNewMessage: false,
    })
  })

  it('ignores whitespace-only chunks before any message exists', () => {
    const { plan } = planAgentTextChunk({ msgId: null, toolSinceText: false }, '\n')
    assert.equal(plan.action, 'ignore')
  })

  it('ignores whitespace-only chunks between tool calls', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: true }, '\n')
    assert.equal(plan.action, 'ignore')
  })

  it('finalizes the prior bubble and starts a new one after tool calls', () => {
    const { plan } = planAgentTextChunk({ msgId: 'msg-1', toolSinceText: true }, 'Done')
    assert.deepEqual(plan, {
      action: 'append',
      text: 'Done',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('keeps a mid-sentence fragment in one bubble when a tool interrupts', () => {
    // "I" streamed, then a tool call, then "'ve kicked off…" resumes the sentence.
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'I' },
      "'ve kicked off the build",
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: "'ve kicked off the build",
      startNewMessage: false,
    })
  })

  it('appends a lowercase continuation after a mid-sentence tool call', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Let me check the' },
      ' file now.',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: ' file now.',
      startNewMessage: false,
    })
  })

  it('starts a new bubble when a lowercase word would join without a boundary', () => {
    // "thinking" then a tool call then "final answer": there is no whitespace
    // boundary between the fragments, so joining them would mangle into
    // "thinkingfinal answer". These are separate messages, not a continuation.
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'thinking' },
      'final answer',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'final answer',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('starts a new bubble when a fresh capitalized sentence follows tool calls', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Let me check the file.' },
      'The build succeeded.',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'The build succeeded.',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('starts a new bubble when prior text ended with terminal punctuation', () => {
    // Even though the incoming chunk is a lowercase continuation char, the prior
    // text ended at a sentence boundary, so this is a genuine fresh answer.
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'All done.' },
      'and more',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'and more',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('starts a new bubble when prior text ended with a question mark', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Ready?' },
      'yes',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'yes',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('starts a new bubble when prior text ended with a trailing newline', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'A list item\n' },
      'and another',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'and another',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('starts a new bubble when the continuation begins with an uppercase letter', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'checking' },
      'Result ready',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: 'Result ready',
      finalizeMsgId: 'msg-1',
      startNewMessage: true,
    })
  })

  it('appends when the continuation begins with a comma', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Running the tests' },
      ', which pass.',
    )
    assert.deepEqual(plan, {
      action: 'append',
      text: ', which pass.',
      startNewMessage: false,
    })
  })

  it('keeps a table row together when a tool call cuts it mid-row', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: '|---|---|\n| 40 ×' },
      ' 100 | 5.5–6.2 ms | 823 |',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('joins the lowercase word fragment in the last table cell across a tool', () => {
    const { plan } = planAgentTextChunk(
      {
        msgId: 'msg-1',
        toolSinceText: true,
        currentText: '| Item | Status |\n| --- | --- |\n| Source | Re',
      },
      'ady |\n\n- **',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('keeps an interrupted table row without its optional leading pipe together', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Item | Status\n--- | ---\nSource' },
      'Continued | value',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  for (const currentText of [
    'Item | Status\n--- | ---\nSource | Ready',
    '| Item | Status |\n| --- | --- |\n| Source | Ready',
    'Item\\|detail | Status\n--- | ---\nSource\\|detail | Ready',
    'Item | Status\n--- | ---\n\nSource',
    'Item | Status\n-x | --\nSource',
    'Choose source | target\nSource',
  ]) {
    it(`keeps a fresh reply separate from complete rows or non-table text ${JSON.stringify(currentText)}`, () => {
      const { plan } = planAgentTextChunk(
        { msgId: 'msg-1', toolSinceText: true, currentText },
        'Next, inspect the build.',
      )
      assert.equal(plan.action === 'append' && plan.startNewMessage, true)
    })
  }

  it('recognizes the single-hyphen aligned delimiter supported by the GFM renderer', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Item | Status\n:- | -:\nSource' },
      'Continued | value',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('keeps a dangling bold marker with the text that closes it', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'rows\n\n- **' },
      'Why the sidebar is cheap:** it renders',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('keeps text inside an open code fence in the same bubble', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Run:\n```sh\npnpm test' },
      '\nDone',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('keeps a trailing newline inside an open fence with its capitalized continuation', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'Run:\n```sh\npnpm test\n' },
      'Done\n```',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('starts a fresh bubble after a completed emphasis span', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: '**Completed.**' },
      'Next, inspect the build.',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, true)
  })

  for (const closing of ['~~~', '```', '```` trailing text']) {
    it(`does not close a four-backtick fence with ${closing}`, () => {
      const { plan } = planAgentTextChunk(
        { msgId: 'msg-1', toolSinceText: true, currentText: `Run:\n\`\`\`\`sh\n${closing}\n` },
        'Done\n````',
      )
      assert.equal(plan.action === 'append' && plan.startNewMessage, false)
    })
  }

  for (const currentText of [
    'Run:\n````sh\npnpm test\n`````',
    'Run:\n~~~sh\npnpm test\n~~~~',
    '__Completed.__',
    '```text\n**\n```\n\n**Completed.**',
    '`**` **Completed.**',
    '``a ` ** literal`` **Completed.**',
    '\\` **Completed.**',
    '~~Completed.~~',
    '`Completed.`',
    'A literal \\**',
  ]) {
    it(`starts a fresh bubble after closed or literal markup ${JSON.stringify(currentText)}`, () => {
      const { plan } = planAgentTextChunk(
        { msgId: 'msg-1', toolSinceText: true, currentText },
        'Next, inspect the build.',
      )
      assert.equal(plan.action === 'append' && plan.startNewMessage, true)
    })
  }

  it('keeps a real dangling bold marker after a code span whose closing tick follows a backslash', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: '`literal\\` **' },
      'Why:** Continue here.',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('rejoins a hyphenated word split by a tool call', () => {
    const { plan } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'about 5–10 sidebar-' },
      'relevant events',
    )
    assert.equal(plan.action === 'append' && plan.startNewMessage, false)
  })

  it('threads currentText through the returned state on append', () => {
    const { state } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: false, currentText: 'Hello' },
      ' world',
    )
    assert.equal(state.currentText, 'Hello world')
  })

  it('resets currentText to the chunk when a new message begins', () => {
    const { state } = planAgentTextChunk(
      { msgId: 'msg-1', toolSinceText: true, currentText: 'All done.' },
      'Fresh sentence.',
    )
    assert.equal(state.currentText, 'Fresh sentence.')
  })

  it('preserves newline-only deltas during active streaming', () => {
    let state: AgentTextChunkState = { msgId: 'msg-1', toolSinceText: false }
    const chunks = ['## Title', '\n', '- item one', '\n', '- item two']

    const texts: string[] = []
    for (const chunk of chunks) {
      const result = planAgentTextChunk(state, chunk)
      state = result.state
      if (result.plan.action === 'append') texts.push(result.plan.text)
    }

    assert.deepEqual(texts, chunks)
  })
})
