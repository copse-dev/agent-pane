import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearThreadProposalDecision,
  findThreadProposalDecision,
  parseThreadProposal,
  recordThreadProposalDecision,
  threadProposalAcknowledgement,
  threadProposalFileSummary,
  threadProposalStatus,
  THREAD_PROPOSAL_FILES_SHOWN,
  THREAD_PROPOSAL_SUMMARY_MAX,
  THREAD_PROPOSAL_TITLE_MAX,
  type ThreadProposalDecision,
} from './thread-proposal.ts'

const args = {
  title: 'Migrate the settings store to Zod',
  summary: 'Replace the hand-rolled settings parsing with a Zod schema.',
  rationale: 'It touches every settings call site, so it should not ride along here.',
  prompt: 'Replace src/main/services/storage/settings.ts hand-rolled parsing with a Zod schema.',
  files: ['src/main/services/storage/settings.ts'],
}

describe('parseThreadProposal', () => {
  it('decodes a complete proposal, keyed by the tool call id', () => {
    const proposal = parseThreadProposal('call-1', args)
    assert.ok(proposal)
    assert.equal(proposal.id, 'call-1')
    assert.equal(proposal.title, args.title)
    assert.equal(proposal.summary, args.summary)
    assert.equal(proposal.rationale, args.rationale)
    assert.equal(proposal.prompt, args.prompt)
    assert.deepEqual(proposal.files, args.files)
  })

  it('omits the optional fields rather than carrying empty ones', () => {
    const proposal = parseThreadProposal('call-1', {
      title: args.title,
      summary: args.summary,
      prompt: args.prompt,
      rationale: '   ',
      files: ['', '  '],
    })
    assert.ok(proposal)
    assert.equal('rationale' in proposal, false)
    assert.equal('files' in proposal, false)
  })

  it('refuses a proposal missing anything the card cannot be drawn without', () => {
    for (const missing of ['title', 'summary', 'prompt'] as const) {
      const partial = Object.fromEntries(Object.entries(args).filter(([key]) => key !== missing))
      assert.equal(parseThreadProposal('call-1', partial), null, `missing ${missing}`)
    }
    assert.equal(parseThreadProposal('call-1', { ...args, prompt: '   ' }), null)
    assert.equal(parseThreadProposal('', args), null)
    assert.equal(parseThreadProposal('call-1', 'not an object'), null)
    assert.equal(parseThreadProposal('call-1', null), null)
    // Streaming args arrive as a partial object before the call completes.
    assert.equal(parseThreadProposal('call-1', {}), null)
  })

  it('truncates a title or summary long enough to stop reading as a card', () => {
    const proposal = parseThreadProposal('call-1', {
      ...args,
      title: 'x'.repeat(THREAD_PROPOSAL_TITLE_MAX + 40),
      summary: 'y'.repeat(THREAD_PROPOSAL_SUMMARY_MAX + 40),
    })
    assert.ok(proposal)
    assert.equal(proposal.title.length, THREAD_PROPOSAL_TITLE_MAX)
    assert.equal(proposal.summary.length, THREAD_PROPOSAL_SUMMARY_MAX)
    assert.ok(proposal.title.endsWith('…'))
  })

  it('keeps the prompt verbatim — it is what the new thread runs', () => {
    const prompt = `${'z'.repeat(THREAD_PROPOSAL_SUMMARY_MAX + 100)}\n\nsecond paragraph`
    const proposal = parseThreadProposal('call-1', { ...args, prompt })
    assert.equal(proposal?.prompt, prompt)
  })
})

describe('thread proposal decisions', () => {
  const started: ThreadProposalDecision = {
    id: 'call-1',
    status: 'started',
    decidedAt: 2,
    threadId: 'thread-9',
  }

  it('reports an unanswered proposal as a standing offer', () => {
    assert.equal(threadProposalStatus(undefined, 'call-1'), 'pending')
    assert.equal(threadProposalStatus([], 'call-1'), 'pending')
    assert.equal(threadProposalStatus([started], 'other'), 'pending')
  })

  it('replaces an earlier answer instead of appending a second row', () => {
    const dismissed: ThreadProposalDecision = { id: 'call-1', status: 'dismissed', decidedAt: 1 }
    const decisions = recordThreadProposalDecision([dismissed], started)
    assert.equal(decisions.length, 1)
    assert.equal(threadProposalStatus(decisions, 'call-1'), 'started')
    assert.equal(findThreadProposalDecision(decisions, 'call-1')?.threadId, 'thread-9')
  })

  it('leaves other proposals alone when one is answered or cleared', () => {
    const other: ThreadProposalDecision = { id: 'call-2', status: 'dismissed', decidedAt: 1 }
    const decisions = recordThreadProposalDecision([other], started)
    assert.deepEqual(decisions.map((d) => d.id).sort(), ['call-1', 'call-2'])
    const cleared = clearThreadProposalDecision(decisions, 'call-1')
    assert.deepEqual(cleared, [other])
    assert.equal(threadProposalStatus(cleared, 'call-1'), 'pending')
  })

  it('clearing an unknown id is a no-op', () => {
    assert.deepEqual(clearThreadProposalDecision([started], 'call-2'), [started])
    assert.deepEqual(clearThreadProposalDecision(undefined, 'call-1'), [])
  })
})

describe('threadProposalAcknowledgement', () => {
  const proposal = parseThreadProposal('call-1', args)
  assert.ok(proposal)
  const message = threadProposalAcknowledgement(proposal)

  it('names the offer so the agent can refer to it', () => {
    assert.match(message, /Migrate the settings store to Zod/)
  })

  it('says nothing ran and nothing is waiting on the agent', () => {
    assert.match(message, /Nothing has run/)
    assert.match(message, /do not wait for an answer/)
    assert.match(message, /do not propose the same thing again/)
  })

  it('never reads as work completed or scheduled', () => {
    assert.doesNotMatch(message, /\b(created|started|queued|scheduled|running)\b/i)
  })
})

describe('threadProposalFileSummary', () => {
  it('lists a short set verbatim', () => {
    assert.equal(threadProposalFileSummary(['a.ts', 'b.ts']), 'a.ts, b.ts')
  })

  it('collapses the tail into a count', () => {
    const files = Array.from(
      { length: THREAD_PROPOSAL_FILES_SHOWN + 3 },
      (_, i) => `f${String(i)}.ts`,
    )
    const summary = threadProposalFileSummary(files)
    assert.ok(summary)
    assert.ok(summary.endsWith('+3 more'))
    assert.equal(summary.split(',').length, THREAD_PROPOSAL_FILES_SHOWN)
  })

  it('has nothing to say about an empty list', () => {
    assert.equal(threadProposalFileSummary([]), null)
    assert.equal(threadProposalFileSummary(undefined), null)
  })
})
