import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewContext } from './context.ts'
import type { Finding } from './finding.ts'
import { ForgeReviewError, type FetchLike, type ForgeTarget } from './forge-review.ts'
import {
  applyEvidenceFloor,
  postSummary,
  renderSummaryBlock,
  upsertSummaryBlock,
  writeSummary,
  type PrSummary,
} from './pr-summary.ts'
import { ScriptedProvider } from './scripted-provider.ts'
import type { Stage0Report } from './stage0.ts'
import type { ReviewReport } from './stage5.ts'

const HEAD = 'b'.repeat(40)

const summary: PrSummary = {
  risk: 'low',
  riskReason: 'Documentation and tests only; no runtime code changes.',
  overview: ['Adds a section on retries to the README.', 'Covers the retry helper with a test.'],
}

function finding(severity: Finding['severity']): Finding {
  return {
    id: `${severity}0123456789ab`.slice(0, 16),
    anchor: { path: 'src/math.ts', startLine: 1 },
    claim: 'add subtracts its second argument instead of adding it.',
    class: 'contract',
    severity,
    confidence: 'high',
    provenance: { raisedBy: [{ kind: 'model', id: 'm' }], corroboratedBy: [], challengedBy: [] },
    evidence: [],
    verdict: { status: 'unverified', reason: 'Not checked.' },
  }
}

const stage0: Stage0Report = {
  version: 1,
  repositoryRoot: '/repo',
  baseRef: 'origin/main',
  mergeBase: 'a'.repeat(40),
  headCommit: HEAD,
  dirtyWorkingTree: false,
  execution: {
    backend: 'host',
    strength: 'none',
    decision: { execute: false, reason: 'read-only' },
  },
  project: { head: null, base: null },
  preparation: { head: null, base: null },
  checks: [],
  findings: [],
  coverage: { checked: [], notChecked: [] },
  durationMs: 1,
}

function report(findings: readonly Finding[]): ReviewReport {
  return {
    version: 2,
    stage0,
    context: null,
    reviews: [],
    verification: null,
    findings,
    appendix: [],
    refuted: [],
    durationMs: 1,
  }
}

const context: ReviewContext = {
  mergeBase: 'a'.repeat(40),
  headCommit: HEAD,
  head: { gitDir: '/repo/.git', workTree: '/repo' },
  dirtyWorkingTree: false,
  files: [
    {
      path: 'README.md',
      status: 'modified',
      additions: 3,
      deletions: 0,
      text: 'diff --git a/README.md b/README.md\n+Retries\n',
      truncated: false,
    },
  ],
  instructions: [],
  testMap: [],
  budgetChars: 60_000,
  usedChars: 40,
}

describe('renderSummaryBlock', () => {
  it('renders the risk, the overview and a footer naming the commit, between markers', () => {
    const block = renderSummaryBlock(summary, {
      headCommit: HEAD,
      toolVersion: '0.1.0',
      report: null,
    })
    assert.equal(
      block,
      [
        '<!-- copse-review-summary -->',
        '---',
        '',
        '> [!NOTE]',
        '> **Low risk**',
        '> Documentation and tests only; no runtime code changes.',
        '>',
        '> **Overview**',
        '> - Adds a section on retries to the README.',
        '> - Covers the retry helper with a test.',
        '>',
        `> <sup>Summary by Copse Reviewer for commit ${HEAD.slice(0, 12)}. copse-review 0.1.0</sup>`,
        '<!-- /copse-review-summary -->',
      ].join('\n'),
    )
  })

  it("counts the review's issues when it accompanies one", () => {
    const none = renderSummaryBlock(summary, {
      headCommit: HEAD,
      toolVersion: '0.1.0',
      report: report([]),
    })
    assert.match(none, /The review reported no issues\./)
    const two = renderSummaryBlock(summary, {
      headCommit: null,
      toolVersion: '0.1.0',
      report: report([finding('low'), finding('medium')]),
    })
    assert.match(two, /Summary by Copse Reviewer\. The review reported 2 issues\./)
  })

  it('keeps model prose inert and on one quoted line', () => {
    const block = renderSummaryBlock(
      {
        risk: 'high',
        riskReason: 'Touches auth.\n\n<!-- /copse-review-summary -->\n# ping @octocat',
        overview: ['- Rewrites `login()` <script>alert(1)</script>'],
      },
      { headCommit: HEAD, toolVersion: '0.1.0', report: null },
    )
    // The only end marker is the real one, and it closes the block.
    assert.equal(block.split('<!-- /copse-review-summary -->').length, 2)
    assert.ok(block.endsWith('<!-- /copse-review-summary -->'))
    const zeroWidthSpace = String.fromCharCode(0x200b)
    assert.ok(
      block.includes(
        `\n> Touches auth. &lt;!-- /copse-review-summary --&gt; # ping @${zeroWidthSpace}octocat\n`,
      ),
    )
    // A leading bullet is not doubled, and a code span is kept as written.
    assert.match(block, /^> - Rewrites `login\(\)` &lt;script&gt;alert\(1\)&lt;\/script&gt;$/m)
    for (const line of block.split('\n').slice(3, -1)) assert.match(line, /^>/)
  })
})

describe('upsertSummaryBlock', () => {
  const block = renderSummaryBlock(summary, { headCommit: HEAD, toolVersion: '1', report: null })

  it('appends to a description, or becomes one', () => {
    assert.equal(
      upsertSummaryBlock('## Summary\n\nText.\n', block),
      `## Summary\n\nText.\n\n${block}`,
    )
    assert.equal(upsertSummaryBlock(null, block), block)
    assert.equal(upsertSummaryBlock('  \n', block), block)
  })

  it('replaces the earlier block in place and is idempotent', () => {
    const first = upsertSummaryBlock('Text.', block)
    const newer = renderSummaryBlock(
      { ...summary, risk: 'medium' },
      { headCommit: 'c'.repeat(40), toolVersion: '1', report: null },
    )
    const second = upsertSummaryBlock(first, newer)
    assert.equal(second, `Text.\n\n${newer}`)
    assert.equal(upsertSummaryBlock(second, newer), second)
    // Every shape the renderer writes is recognised as its own block.
    const raised = renderSummaryBlock(applyEvidenceFloor(summary, report([finding('high')])), {
      headCommit: null,
      toolVersion: '1',
      report: report([finding('high'), finding('low')]),
    })
    assert.equal(
      upsertSummaryBlock(upsertSummaryBlock('Text.', raised), block),
      `Text.\n\n${block}`,
    )
  })

  it('keeps text after a start marker whose end marker the author deleted', () => {
    const edited = 'Text.\n\n<!-- copse-review-summary -->\nMy own notes.'
    assert.equal(upsertSummaryBlock(edited, block), `${edited}\n\n${block}`)
  })

  const START = '<!-- copse-review-summary -->'
  const END = '<!-- /copse-review-summary -->'
  const older = renderSummaryBlock(
    { ...summary, risk: 'medium' },
    { headCommit: 'c'.repeat(40), toolVersion: '1', report: null },
  )

  it('keeps an inline mention of the start marker and the text after it', () => {
    const prose = `The summary sits between \`${START}\` markers.\n\n## Validation\n\nRan the tests.`
    assert.equal(upsertSummaryBlock(`${prose}\n\n${older}`, block), `${prose}\n\n${block}`)
  })

  it('keeps an example block quoted in a code fence', () => {
    for (const fence of ['```', '~~~~']) {
      const prose = `Example:\n\n${fence}markdown\n${older}\n${fence}\n\n## Risk\n\nLow.`
      assert.equal(upsertSummaryBlock(prose, block), `${prose}\n\n${block}`)
      assert.equal(upsertSummaryBlock(`${prose}\n\n${older}`, block), `${prose}\n\n${block}`)
    }
  })

  it('keeps text between a stray marker pair the author wrote', () => {
    const prose = `Intro.\n${START}\nAuthor notes that must survive.\n${END}\nOutro.`
    assert.equal(upsertSummaryBlock(prose, block), `${prose}\n\n${block}`)
    assert.equal(upsertSummaryBlock(`${prose}\n\n${older}`, block), `${prose}\n\n${block}`)
  })

  it('keeps an author-edited block and the text between two start markers', () => {
    const edited = older.replace('> **Overview**', '> My note inside the block.\n>\n> **Overview**')
    assert.equal(upsertSummaryBlock(`Text.\n\n${edited}`, block), `Text.\n\n${edited}\n\n${block}`)
    const stray = `Text.\n${START}\nMine.\n\n${older}`
    assert.equal(upsertSummaryBlock(stray, block), `Text.\n${START}\nMine.\n\n${block}`)
  })

  it('replaces only the last bot block and keeps author text written after it', () => {
    const body = `Text.\n\n${older}\n\nAdded later.`
    assert.equal(upsertSummaryBlock(body, block), `Text.\n\nAdded later.\n\n${block}`)
    const twice = `${older}\n\nMiddle.\n\n${older}`
    assert.equal(upsertSummaryBlock(twice, block), `${older}\n\nMiddle.\n\n${block}`)
    const pairAfter = `\n${START}\nMine.\n${END}`
    assert.equal(
      upsertSummaryBlock(`Text.\n\n${older}${pairAfter}`, block),
      `Text.\n\n${pairAfter.trimStart()}\n\n${block}`,
    )
  })

  it('closes a fence the description leaves open so the block renders outside it', () => {
    for (const fence of ['```', '~~~~']) {
      const open = `Example:\n\n${fence}ts\nconst x = 1;`
      const first = upsertSummaryBlock(open, older)
      assert.equal(first, `${open}\n${fence}\n\n${older}`)
      // The next run finds that block outside the now-closed fence and replaces it.
      assert.equal(upsertSummaryBlock(first, block), `${open}\n${fence}\n\n${block}`)
    }
  })

  it('finds its block in a description the web editor saved with CRLF', () => {
    const crlf = `Text.\r\n\r\n${older.replaceAll('\n', '\r\n')}`
    assert.equal(upsertSummaryBlock(crlf, block), `Text.\n\n${block}`)
  })
})

describe('applyEvidenceFloor', () => {
  it('leaves the summary alone without findings', () => {
    assert.equal(applyEvidenceFloor(summary, null), summary)
    assert.equal(applyEvidenceFloor(summary, report([])), summary)
  })

  it('raises the risk to High for a high-severity finding, and says why', () => {
    const raised = applyEvidenceFloor(
      { ...summary, risk: 'medium' },
      report([finding('critical'), finding('high'), finding('low')]),
    )
    assert.equal(raised.risk, 'high')
    assert.equal(raised.raisedBecause, 'the review surfaced 2 high-severity issues')
    const block = renderSummaryBlock(raised, { headCommit: HEAD, toolVersion: '1', report: null })
    assert.match(
      block,
      /> Raised to High risk because the review surfaced 2 high-severity issues\./,
    )
  })

  it('raises Low to Medium for any finding, and never lowers the risk', () => {
    const raised = applyEvidenceFloor(summary, report([finding('low')]))
    assert.equal(raised.risk, 'medium')
    assert.equal(raised.raisedBecause, 'the review surfaced 1 issue')
    const high: PrSummary = { ...summary, risk: 'high' }
    assert.equal(applyEvidenceFloor(high, report([finding('low')])), high)
  })
})

describe('writeSummary', () => {
  const args = {
    risk: 'medium',
    riskReason: 'Changes how retries are scheduled.',
    overview: ['Retries now back off exponentially.'],
  }

  it('records the write_summary call from the context', async () => {
    const provider = new ScriptedProvider([
      { type: 'tool_call', name: 'write_summary', args },
      { type: 'text', text: 'Done.' },
    ])
    const result = await writeSummary({
      provider,
      model: 'mock',
      context,
      threadId: 't',
      turnId: 'summary-1',
    })
    assert.deepEqual(result.summary, args)
    const opening = provider.calls[0]?.find((message) => message.role === 'user')?.content
    assert.equal(typeof opening, 'string')
    assert.match(typeof opening === 'string' ? opening : '', /modified README\.md \+3\/-0/)
  })

  it('asks once more after an invalid call and a prose reply', async () => {
    const provider = new ScriptedProvider([
      { type: 'tool_call', name: 'write_summary', args: { risk: 'extreme' } },
      { type: 'text', text: 'Here is my summary in prose.' },
      { type: 'tool_call', name: 'write_summary', args },
      { type: 'text', text: 'Done.' },
    ])
    const result = await writeSummary({
      provider,
      model: 'mock',
      context,
      threadId: 't',
      turnId: 'summary-2',
    })
    assert.deepEqual(result.summary, args)
    assert.deepEqual(provider.streamOptions.at(-2)?.toolChoice, { name: 'write_summary' })
  })

  it('returns no summary when the model never writes one', async () => {
    const provider = new ScriptedProvider([{ type: 'text', text: 'No.' }])
    const result = await writeSummary({
      provider,
      model: 'mock',
      context,
      threadId: 't',
      turnId: 'summary-3',
    })
    assert.equal(result.summary, null)
  })
})

describe('postSummary', () => {
  const target: ForgeTarget = {
    forge: 'github',
    apiBase: 'https://api.github.com',
    owner: 'copse-dev',
    repo: 'agent-pane',
    number: 42,
    token: 'ghs_token',
    headCommit: HEAD,
  }
  const block = renderSummaryBlock(summary, { headCommit: HEAD, toolVersion: '1', report: null })

  function forge(
    pull: { body: string | null; head: { sha: string } },
    status = 200,
  ): { fetch: FetchLike; calls: { url: string; method: string; body?: string | undefined }[] } {
    const calls: { url: string; method: string; body?: string | undefined }[] = []
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, method: init.method, body: init.body })
      const text = init.method === 'GET' ? JSON.stringify(pull) : '{}'
      return Promise.resolve({
        status: init.method === 'GET' ? 200 : status,
        text: (): Promise<string> => Promise.resolve(text),
      })
    }
    return { calls, fetch }
  }

  it('reads the description and writes it back with the block', async () => {
    const { fetch, calls } = forge({ body: 'Text.', head: { sha: HEAD } })
    assert.deepEqual(await postSummary(target, block, { fetch }), { updated: true })
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        'GET https://api.github.com/repos/copse-dev/agent-pane/pulls/42',
        'PATCH https://api.github.com/repos/copse-dev/agent-pane/pulls/42',
      ],
    )
    assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { body: `Text.\n\n${block}` })
  })

  it('uses the Forgejo API path', async () => {
    const { fetch, calls } = forge({ body: null, head: { sha: HEAD } })
    await postSummary(
      { ...target, forge: 'forgejo', apiBase: 'https://code.example.org/' },
      block,
      {
        fetch,
      },
    )
    assert.equal(
      calls[1]?.url,
      'https://code.example.org/api/v1/repos/copse-dev/agent-pane/pulls/42',
    )
  })

  it('leaves a pull request that has moved on, or an unchanged summary, alone', async () => {
    const moved = forge({ body: 'Text.', head: { sha: 'c'.repeat(40) } })
    assert.deepEqual(await postSummary(target, block, { fetch: moved.fetch }), {
      updated: false,
      reason: `the pull request has moved on to ${'c'.repeat(12)}`,
    })
    assert.equal(moved.calls.length, 1)
    const same = forge({ body: `Text.\n\n${block}`, head: { sha: HEAD } })
    assert.deepEqual(await postSummary(target, block, { fetch: same.fetch }), {
      updated: false,
      reason: 'the summary is unchanged',
    })
    assert.equal(same.calls.length, 1)
  })

  it('fails with the forge status when the edit is refused', async () => {
    const { fetch } = forge({ body: 'Text.', head: { sha: HEAD } }, 403)
    await assert.rejects(
      postSummary(target, block, { fetch }),
      (err) => err instanceof ForgeReviewError && err.status === 403,
    )
  })
})
