import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLA_CONTEXT,
  COMMENT_MARKER,
  decodeSignatures,
  evaluateOpenPullRequests,
  evaluatePullRequest,
  MAX_LISTED_COMMITS,
  SIGN_PHRASE,
  type ClaComment,
  type ClaCommit,
  type ClaOctokit,
  type ClaPullRequest,
  type ClaResult,
  type ClaUser,
} from './cla-check.mts'

const REPO = 'copse-dev/agent-pane'

const maintainer: ClaUser = { login: 'jk', id: 1, type: 'User' }
const outsider: ClaUser = { login: 'eve', id: 2, type: 'User' }
const claude: ClaUser = { login: 'claude', id: 81847, type: 'User' }
const actionsBot: ClaUser = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
const releaseBot: ClaUser = { login: 'copse-release-bot[bot]', id: 304038887, type: 'Bot' }
const copilot: ClaUser = { login: 'Copilot', id: 198982749, type: 'Bot' }

const ACTIONS_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const COPILOT_EMAIL = '198982749+Copilot@users.noreply.github.com'

let shaCounter = 0
function commit(author: ClaUser | null, email: string, message = 'change'): ClaCommit {
  shaCounter += 1
  return {
    sha: shaCounter.toString(16).padStart(40, '0'),
    author,
    commit: { message, author: { email } },
  }
}

function pull(
  number: number,
  user: ClaUser,
  commits: ClaCommit[],
  options: { fork?: boolean; headRef?: string; base?: string } = {},
): ClaPullRequest {
  return {
    number,
    state: 'open',
    user,
    head: {
      sha: commits.at(-1)?.sha ?? 'f'.repeat(40),
      ref: options.headRef ?? `topic-${String(number)}`,
      repo: { full_name: options.fork ? 'fork-owner/agent-pane' : REPO },
    },
    base: { ref: options.base ?? 'main', repo: { full_name: REPO, default_branch: 'main' } },
  }
}

interface Scenario {
  pr: ClaPullRequest
  commits: ClaCommit[]
  comments?: ClaComment[]
  /** CLA statuses already on this pull request's head. */
  statuses?: string[]
}

interface Written {
  statuses: { sha: string; state: string; description: string }[]
  created: { issue: number; body: string }[]
  updated: { id: number; body: string }[]
  commitListings: number[]
}

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { status: 404 })
}

function fakeGitHub(
  scenarios: Scenario[],
  options: { pushers?: string[]; signatures?: unknown; bots?: ClaUser[] } = {},
): { github: ClaOctokit; written: Written } {
  const byNumber = new Map(scenarios.map((s) => [s.pr.number, s]))
  // GitHub logins are case-insensitive, and trailer addresses arrive lower-cased.
  const pushers = new Set((options.pushers ?? [maintainer.login]).map((l) => l.toLowerCase()))
  const bots = new Map([copilot, ...(options.bots ?? [])].map((b) => [b.login.toLowerCase(), b]))
  const written: Written = { statuses: [], created: [], updated: [], commitListings: [] }
  const scenario = (number: number): Scenario => {
    const found = byNumber.get(number)
    if (!found) throw notFound()
    return found
  }
  const github: ClaOctokit = {
    paginate: async (method, params) => (await method(params)).data,
    rest: {
      pulls: {
        get: async ({ pull_number }) => ({ data: scenario(pull_number).pr }),
        list: async () => ({ data: scenarios.map((s) => s.pr) }),
        listCommits: async ({ pull_number }) => {
          written.commitListings.push(pull_number)
          return { data: scenario(pull_number).commits.slice(0, MAX_LISTED_COMMITS) }
        },
      },
      issues: {
        listComments: async ({ issue_number }) => ({ data: scenario(issue_number).comments ?? [] }),
        createComment: async ({ issue_number, body }) => {
          written.created.push({ issue: issue_number, body })
          return {}
        },
        updateComment: async ({ comment_id, body }) => {
          written.updated.push({ id: comment_id, body })
          return {}
        },
      },
      repos: {
        getContent: async ({ ref }) => {
          assert.equal(ref, 'main', 'signatures must come from the default branch')
          if (options.signatures === undefined) throw notFound()
          const content = Buffer.from(JSON.stringify(options.signatures)).toString('base64')
          return { data: { type: 'file', content } }
        },
        getCollaboratorPermissionLevel: async ({ username }) => {
          if (!pushers.has(username.toLowerCase())) throw notFound()
          return { data: { permission: 'write' } }
        },
        getCombinedStatusForRef: async ({ ref }) => {
          const found = scenarios.find((s) => s.pr.head.sha === ref)
          return { data: { statuses: (found?.statuses ?? []).map((context) => ({ context })) } }
        },
        createCommitStatus: async ({ sha, state, context, description }) => {
          assert.equal(context, CLA_CONTEXT)
          assert.ok(description.length <= 140, 'GitHub rejects a longer status description')
          written.statuses.push({ sha, state, description })
          return {}
        },
      },
      users: {
        getByUsername: async ({ username }) => {
          const bot = bots.get(username.toLowerCase())
          if (bot) return { data: bot }
          if (username === maintainer.login) return { data: maintainer }
          if (username === outsider.login) return { data: outsider }
          throw notFound()
        },
      },
    },
  }
  return { github, written }
}

async function evaluate(
  scenario: Scenario,
  options: Parameters<typeof fakeGitHub>[1] = {},
): Promise<{ result: ClaResult; written: Written }> {
  const { github, written } = fakeGitHub([scenario], options)
  const result = await evaluatePullRequest(
    { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
    scenario.pr.number,
  )
  return { result, written }
}

function stateOf(result: ClaResult): string {
  return result.kind === 'evaluated' ? result.state : `skipped: ${result.reason}`
}

describe('CLA evaluation', () => {
  it('passes a maintainer pull request whose commits are by agents, bots and unlinked addresses', async () => {
    // #3228's shape: maintainer commits, an autoformat head commit by
    // github-actions[bot], plus agent trailers the app's ACP agents add.
    const commits = [
      commit(
        maintainer,
        'jonathan@example.com',
        'feat\n\nCo-authored-by: Codex <codex@openai.com>',
      ),
      commit(claude, 'noreply@anthropic.com', 'fix\n\nCo-Authored-By: Copse <noreply@copse.dev>'),
      commit(null, 'jonathan@laptop.local'),
      commit(actionsBot, ACTIONS_EMAIL, 'style: apply eslint --fix and oxfmt'),
    ]
    const { result, written } = await evaluate({ pr: pull(3228, maintainer, commits), commits })
    assert.equal(stateOf(result), 'success')
    assert.deepEqual(written.statuses, [
      {
        sha: commits[3]?.sha,
        state: 'success',
        description: 'Every commit author has signed the CLA',
      },
    ])
    assert.deepEqual(written.created, [], 'a passing pull request gets no comment')
  })

  it('passes a promotion pull request a bot opened from main, however many commits it carries', async () => {
    const commits = Array.from({ length: 300 }, (_, i) =>
      commit(i % 2 ? outsider : null, i % 2 ? 'eve@example.com' : 'old@unlinked.example'),
    )
    const pr = pull(4000, releaseBot, commits, { headRef: 'main', base: 'release' })
    const { result, written } = await evaluate({ pr, commits })
    assert.equal(stateOf(result), 'success')
    assert.deepEqual(written.commitListings, [], 'a promotion is decided without listing commits')
    assert.match(written.statuses[0]?.description ?? '', /^Promotes main/)
  })

  it('passes a same-repository pull request an App opened, with an unlinked author address', async () => {
    // peter-evans/create-pull-request under copse-release-bot: sync and
    // release-bump pull requests. Their head branch lives here, so the opener
    // had write access.
    const commits = [commit(null, 'automation@unlinked.example'), commit(actionsBot, ACTIONS_EMAIL)]
    const { result } = await evaluate({ pr: pull(4001, releaseBot, commits), commits })
    assert.equal(stateOf(result), 'success')
  })

  it('passes a maintainer pull request carrying a Copilot co-author trailer', async () => {
    const commits = [
      commit(maintainer, 'jk@example.com', `x\n\nCo-authored-by: Copilot <${COPILOT_EMAIL}>`),
    ]
    const { result } = await evaluate({ pr: pull(4002, maintainer, commits), commits })
    assert.equal(stateOf(result), 'success')
  })

  it('fails an outside pull request with an agent-authored commit and an unsigned opener', async () => {
    const commits = [commit(claude, 'noreply@anthropic.com')]
    const { result, written } = await evaluate({
      pr: pull(4003, outsider, commits, { fork: true }),
      commits,
    })
    assert.equal(stateOf(result), 'failure')
    assert.ok(result.kind === 'evaluated')
    assert.deepEqual(
      result.unsigned.map((u) => u.login),
      ['eve'],
      'the opener, not @claude, answers for the agent commit',
    )
    assert.equal(written.created.length, 1)
    assert.match(written.created[0]?.body ?? '', new RegExp(SIGN_PHRASE))
  })

  it('fails an outside pull request whose commit claims a Bot account address', async () => {
    // GitHub resolves Copilot's noreply address to a Bot account, and the
    // address is self-declared: it must not let an outsider skip signing.
    const commits = [commit(copilot, COPILOT_EMAIL)]
    const { result } = await evaluate({
      pr: pull(4004, outsider, commits, { fork: true }),
      commits,
    })
    assert.equal(stateOf(result), 'failure')
    assert.ok(result.kind === 'evaluated')
    assert.deepEqual(
      result.unsigned.map((u) => u.login),
      ['eve'],
    )
  })

  it('fails a bot-opened pull request from a fork that carries agent commits', async () => {
    const commits = [commit(actionsBot, ACTIONS_EMAIL)]
    const outsideBot: ClaUser = { login: 'helper[bot]', id: 9, type: 'Bot' }
    const { result } = await evaluate({
      pr: pull(4005, outsideBot, commits, { fork: true }),
      commits,
    })
    assert.equal(stateOf(result), 'failure')
    assert.ok(result.kind === 'evaluated')
    assert.match(
      result.unresolved.join('\n'),
      /opened by helper\[bot\] from outside this repository/,
    )
  })

  it('fails an outside unsigned human author, even on a maintainer pull request', async () => {
    const commits = [commit(outsider, 'eve@example.com')]
    for (const opener of [outsider, maintainer]) {
      const { result } = await evaluate({ pr: pull(4006, opener, commits), commits })
      assert.equal(stateOf(result), 'failure', `opened by ${opener.login}`)
    }
  })

  it('fails an outside pull request with an unlinked author address', async () => {
    const commits = [commit(null, 'someone@unlinked.example')]
    const { result } = await evaluate({
      pr: pull(4007, outsider, commits, { fork: true }),
      commits,
    })
    assert.equal(stateOf(result), 'failure')
  })

  it('passes once the outside author signs, by comment or in the signatures file', async () => {
    const commits = [commit(outsider, 'eve@example.com')]
    const signedByComment = await evaluate({
      pr: pull(4008, outsider, commits, { fork: true }),
      commits,
      comments: [{ id: 5, user: outsider, body: SIGN_PHRASE }],
    })
    assert.equal(stateOf(signedByComment.result), 'success')
    const signedInFile = await evaluate(
      { pr: pull(4009, outsider, commits, { fork: true }), commits },
      { signatures: { signatures: [{ id: outsider.id, evidence: 'x' }] } },
    )
    assert.equal(stateOf(signedInFile.result), 'success')
  })

  it('does not stamp a verdict on a head that moved while its commits were listed', async () => {
    const commits = [commit(maintainer, 'jk@example.com'), commit(maintainer, 'jk@example.com')]
    const pr = pull(4010, maintainer, commits.slice(0, 1))
    const { result, written } = await evaluate({ pr, commits })
    assert.equal(result.kind, 'skipped')
    assert.deepEqual(written.statuses, [])
  })

  it('rejects more commits than the API lists on an ordinary pull request', async () => {
    const commits = Array.from({ length: 260 }, () => commit(maintainer, 'jk@example.com'))
    const pr = pull(4011, maintainer, commits.slice(0, MAX_LISTED_COMMITS))
    const { result } = await evaluate({ pr, commits })
    assert.equal(stateOf(result), 'failure')
  })
})

describe('CLA backfill', () => {
  const log = (): void => {}

  it('recomputes a stale failure to success and corrects its comment', async () => {
    // #3121/#3108: failed under the rule before agent commits were the
    // opener's to answer for, and never recomputed.
    const commits = [commit(claude, 'noreply@anthropic.com')]
    const stale: ClaComment = {
      id: 77,
      user: actionsBot,
      body: `${COMMENT_MARKER}\nThanks for contributing. ... Waiting on:\n- @claude`,
    }
    const { github, written } = fakeGitHub([
      { pr: pull(3121, maintainer, commits), commits, comments: [stale], statuses: [CLA_CONTEXT] },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyMissing: false },
    )
    assert.deepEqual(results.map(stateOf), ['success'])
    assert.equal(written.statuses[0]?.state, 'success')
    assert.equal(written.updated.length, 1)
    assert.match(written.updated[0]?.body ?? '', /All commit authors have signed/)
  })

  it('in only-missing mode, evaluates just the heads that carry no CLA status', async () => {
    // #3228's head predates the workflow; a GITHUB_TOKEN push lands the same way.
    const missing = [commit(actionsBot, ACTIONS_EMAIL)]
    const present = [commit(maintainer, 'jk@example.com')]
    const { github, written } = fakeGitHub([
      { pr: pull(3228, maintainer, missing), commits: missing },
      { pr: pull(3245, maintainer, present), commits: present, statuses: [CLA_CONTEXT] },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyMissing: true },
    )
    assert.deepEqual(
      results.map((r) => r.number),
      [3228],
    )
    assert.deepEqual(
      written.statuses.map((s) => s.sha),
      [missing[0]?.sha],
    )
  })

  it('keeps going past one pull request that errors, then fails the run', async () => {
    const good = [commit(maintainer, 'jk@example.com')]
    const { github, written } = fakeGitHub([
      { pr: pull(1, maintainer, good), commits: good },
      { pr: pull(2, maintainer, good), commits: good },
    ])
    const original = github.rest.pulls.listCommits
    github.rest.pulls.listCommits = async (params): ReturnType<typeof original> => {
      if (params.pull_number === 1) throw new Error('boom')
      return original(params)
    }
    await assert.rejects(
      evaluateOpenPullRequests(
        { github, owner: 'copse-dev', repo: 'agent-pane', log },
        { onlyMissing: false },
      ),
      /CLA evaluation failed for #1/,
    )
    assert.deepEqual(
      written.statuses.map((s) => s.state),
      ['success'],
    )
  })

  it('leaves an unchanged failure comment alone', async () => {
    const commits = [commit(outsider, 'eve@example.com')]
    const first = fakeGitHub([{ pr: pull(9, outsider, commits, { fork: true }), commits }])
    await evaluateOpenPullRequests(
      { github: first.github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyMissing: false },
    )
    const body = first.written.created[0]?.body ?? ''
    assert.ok(body.includes('@eve'))
    const second = fakeGitHub([
      {
        pr: pull(9, outsider, commits, { fork: true }),
        commits,
        comments: [{ id: 3, user: actionsBot, body }],
      },
    ])
    await evaluateOpenPullRequests(
      { github: second.github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyMissing: false },
    )
    assert.deepEqual(second.written.created, [])
    assert.deepEqual(second.written.updated, [])
  })
})

describe('decodeSignatures', () => {
  it('keeps numeric ids and lower-cased string emails, and ignores the rest', () => {
    const decoded = decodeSignatures(
      JSON.stringify({
        signatures: [{ id: 7, emails: ['A@B.example', 3] }, { id: 'x' }, null, 'nope'],
      }),
    )
    assert.deepEqual([...decoded.ids], [7])
    assert.deepEqual([...decoded.emails], ['a@b.example'])
    assert.deepEqual([...decodeSignatures('{}').ids], [])
    assert.throws(() => decodeSignatures('{'))
  })
})
