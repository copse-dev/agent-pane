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
const dependabot: ClaUser = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' }

const ACTIONS_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const COPILOT_EMAIL = '198982749+Copilot@users.noreply.github.com'
const DEPENDABOT_EMAIL = '49699333+dependabot[bot]@users.noreply.github.com'

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
  /** The latest status per context already on this pull request's head. */
  statuses?: { context: string; state: string }[]
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
        compareCommitsWithBasehead: async () => ({ data: { status: 'ahead' } }),
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
          return { data: { statuses: found?.statuses ?? [] } }
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

  it('passes pinned promotions already on main, including after main advances', async () => {
    for (const status of ['identical', 'behind']) {
      const commits = Array.from({ length: 300 }, () => commit(null, 'old@unlinked.example'))
      const pr = pull(4000, releaseBot, commits, { headRef: 'promote/main', base: 'release' })
      const { github, written } = fakeGitHub([{ pr, commits }])
      github.rest.repos.compareCommitsWithBasehead = async (
        params,
      ): Promise<{ data: { status: string } }> => {
        assert.deepEqual(params, {
          owner: 'copse-dev',
          repo: 'agent-pane',
          basehead: `main...${pr.head.sha}`,
        })
        return { data: { status } }
      }
      const result = await evaluatePullRequest(
        { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
        pr.number,
      )
      assert.equal(stateOf(result), 'success', status)
      assert.deepEqual(written.commitListings, [], 'do not recheck already merged authors')
    }
  })

  it('does not publish success when promotion ancestry cannot be verified', async () => {
    const commits = [commit(null, 'old@unlinked.example')]
    const pr = pull(4000, releaseBot, commits, { headRef: 'promote/main', base: 'release' })
    const { github, written } = fakeGitHub([{ pr, commits }])
    github.rest.repos.compareCommitsWithBasehead = async (): Promise<never> => {
      throw notFound()
    }
    await assert.rejects(
      evaluatePullRequest(
        { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
        pr.number,
      ),
      /Not Found/,
    )
    assert.deepEqual(written.statuses, [])
  })

  it('checks authors when a pinned promotion contains commits outside main', async () => {
    for (const status of ['ahead', 'diverged', 'unknown']) {
      const commits = [commit(outsider, 'eve@example.com')]
      const pr = pull(4000, releaseBot, commits, { headRef: 'promote/main', base: 'release' })
      const { github, written } = fakeGitHub([{ pr, commits }])
      github.rest.repos.compareCommitsWithBasehead = async (): Promise<{
        data: { status: string }
      }> => ({ data: { status } })
      const result = await evaluatePullRequest(
        { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
        pr.number,
      )
      assert.equal(stateOf(result), 'failure', status)
      assert.deepEqual(written.commitListings, [pr.number])
    }
  })

  it('does not grant the pinned promotion exemption to forks, other bases or outside openers', async () => {
    const commits = [commit(outsider, 'eve@example.com')]
    const pulls = [
      pull(4000, releaseBot, commits, { headRef: 'promote/main', base: 'release', fork: true }),
      pull(4001, releaseBot, commits, { headRef: 'promote/main' }),
      pull(4002, outsider, commits, { headRef: 'promote/main', base: 'release' }),
      pull(4003, actionsBot, commits, { headRef: 'promote/main', base: 'release' }),
    ]
    for (const pr of pulls) {
      const { github } = fakeGitHub([{ pr, commits }])
      github.rest.repos.compareCommitsWithBasehead = async (): Promise<never> => {
        assert.fail('ineligible pull requests must use normal author checks')
      }
      const result = await evaluatePullRequest(
        { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
        pr.number,
      )
      assert.equal(stateOf(result), 'failure')
    }
  })

  it('passes the pull requests the repository automation Apps open', async () => {
    // peter-evans/create-pull-request under copse-release-bot (sync-*,
    // release-bump): the commit carries the dispatching or schedule actor's
    // linked noreply address, and CI's autoformat commit follows. Dependabot
    // authors its own commits.
    const sync = [
      commit(maintainer, '1+jk@users.noreply.github.com'),
      commit(actionsBot, ACTIONS_EMAIL),
    ]
    const bumped = await evaluate({ pr: pull(4001, releaseBot, sync), commits: sync })
    assert.equal(stateOf(bumped.result), 'success')
    const bump = [commit(dependabot, DEPENDABOT_EMAIL, 'chore(deps): bump x')]
    const deps = await evaluate({ pr: pull(4013, dependabot, bump), commits: bump })
    assert.equal(stateOf(deps.result), 'success')
  })

  it('lets repository automation answer for Copse, Codex, Claude and Cursor commits', async () => {
    // App-made commits (copse@localhost), container runs (copse@copse.invalid)
    // and agent trailers carry addresses linked to no account; on an
    // automation pull request nobody else could answer for them.
    const commits = [
      commit(null, 'copse@localhost', 'x\n\nCo-authored-by: Codex <codex@openai.com>'),
      commit(null, 'copse@copse.invalid'),
      commit(null, 'copse@copse.dev', 'x\n\nCo-Authored-By: Copse <noreply@copse.dev>'),
      commit(null, 'noreply@openai.com', 'x\n\nCo-authored-by: Cursor <cursoragent@cursor.com>'),
      commit(claude, 'noreply@anthropic.com'),
    ]
    const { result } = await evaluate({ pr: pull(4019, releaseBot, commits), commits })
    assert.equal(stateOf(result), 'success')
  })

  it('still makes an outside opener sign for a Copse- or Codex-authored commit', async () => {
    for (const email of ['copse@localhost', 'codex@openai.com']) {
      const commits = [commit(null, email)]
      const { result } = await evaluate({
        pr: pull(4020, outsider, commits, { fork: true }),
        commits,
      })
      assert.equal(stateOf(result), 'failure', email)
      assert.ok(result.kind === 'evaluated')
      assert.deepEqual(
        result.unsigned.map((u) => u.login),
        ['eve'],
      )
    }
  })

  it('does not treat other addresses at the agent domains as agents', async () => {
    const commits = [commit(null, 'someone@openai.com'), commit(null, 'someone@copse.dev')]
    const { result } = await evaluate({ pr: pull(4021, releaseBot, commits), commits })
    assert.equal(stateOf(result), 'failure')
  })

  it('does not trust an App outside the automation allowlist, even from a same-repository branch', async () => {
    // Anyone can open a pull request from an existing branch here; a branch
    // in this repository says nothing about the App that opened it.
    const helperApp: ClaUser = { login: 'helper[bot]', id: 9, type: 'Bot' }
    const unlinked = [commit(null, 'someone@unlinked.example')]
    const byAddress = await evaluate({ pr: pull(4014, helperApp, unlinked), commits: unlinked })
    assert.equal(stateOf(byAddress.result), 'failure')
    assert.deepEqual(
      byAddress.written.statuses.map((s) => s.state),
      ['failure'],
    )
    const trailer = [
      commit(
        maintainer,
        'jk@example.com',
        'x\n\nCo-authored-by: Someone <someone@unlinked.example>',
      ),
    ]
    const byTrailer = await evaluate({ pr: pull(4015, helperApp, trailer), commits: trailer })
    assert.equal(stateOf(byTrailer.result), 'failure')
    const agent = [commit(claude, 'noreply@anthropic.com')]
    const byAgent = await evaluate({ pr: pull(4016, helperApp, agent), commits: agent })
    assert.equal(stateOf(byAgent.result), 'failure')
    assert.ok(byAgent.result.kind === 'evaluated')
    assert.match(byAgent.result.unresolved.join('\n'), /opened by helper\[bot\]/)
  })

  it('does not let an automation App answer for an unlinked human address', async () => {
    // An App vouches for agent and bot commits on its own branch, but it
    // cannot answer for a person: an unlinked address must be in the
    // signatures file, as a maintainer's own addresses are.
    const commits = [commit(null, 'someone@unlinked.example'), commit(actionsBot, ACTIONS_EMAIL)]
    const unsigned = await evaluate({ pr: pull(4017, releaseBot, commits), commits })
    assert.equal(stateOf(unsigned.result), 'failure')
    const listed = await evaluate(
      { pr: pull(4018, releaseBot, commits), commits },
      { signatures: { signatures: [{ id: 1, emails: ['someone@unlinked.example'] }] } },
    )
    assert.equal(stateOf(listed.result), 'success')
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
    assert.match(result.unresolved.join('\n'), /opened by helper\[bot\]/)
  })

  it('makes an outside opener sign even when every commit claims a maintainer', async () => {
    // A commit's author email is self-declared, and GitHub links it to the
    // maintainer's account; only the opener is authenticated.
    const commits = [commit(maintainer, 'jk@example.com')]
    const spoofed = await evaluate({
      pr: pull(4022, outsider, commits, { fork: true }),
      commits,
    })
    assert.equal(stateOf(spoofed.result), 'failure')
    assert.ok(spoofed.result.kind === 'evaluated')
    assert.deepEqual(
      spoofed.result.unsigned.map((u) => u.login),
      ['eve'],
    )

    const signed = await evaluate(
      { pr: pull(4023, outsider, commits, { fork: true }), commits },
      { signatures: { signatures: [{ id: outsider.id, emails: [] }] } },
    )
    assert.equal(stateOf(signed.result), 'success')
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
    // The listing stops before the head, which has not moved.
    const past = await evaluate({ pr: pull(4012, maintainer, commits), commits })
    assert.equal(stateOf(past.result), 'failure')
  })

  it('does not stamp a truncated listing on a head that moved while its commits were listed', async () => {
    // Read at 249 commits; a push lands before the listing, which then stops
    // at the API's 250. The truncation failure belongs to the new head, not
    // to the 249 the older head carries.
    const commits = Array.from({ length: 251 }, () => commit(maintainer, 'jk@example.com'))
    const scenario: Scenario = { pr: pull(4019, maintainer, commits.slice(0, 249)), commits }
    const { github, written } = fakeGitHub([scenario])
    const listCommits = github.rest.pulls.listCommits
    github.rest.pulls.listCommits = async (params): ReturnType<typeof listCommits> => {
      scenario.pr = pull(4019, maintainer, commits)
      return listCommits(params)
    }
    const result = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log: () => {} },
      { onlyChanged: false },
    )
    assert.deepEqual(
      result.map((r) => r.kind),
      ['skipped'],
    )
    assert.deepEqual(written.statuses, [])
    assert.deepEqual(written.created, [])
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
      {
        pr: pull(3121, maintainer, commits),
        commits,
        comments: [stale],
        statuses: [{ context: CLA_CONTEXT, state: 'failure' }],
      },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: false },
    )
    assert.deepEqual(results.map(stateOf), ['success'])
    assert.equal(written.statuses[0]?.state, 'success')
    assert.equal(written.updated.length, 1)
    assert.match(written.updated[0]?.body ?? '', /All commit authors have signed/)
  })

  it('in the scheduled sweep, re-evaluates every head and writes only a changed verdict', async () => {
    // #3228's head predates the workflow; a GITHUB_TOKEN push lands the same
    // way. #3245's success still holds and is not rewritten.
    const missing = [commit(actionsBot, ACTIONS_EMAIL)]
    const present = [commit(maintainer, 'jk@example.com')]
    const { github, written } = fakeGitHub([
      { pr: pull(3228, maintainer, missing), commits: missing },
      {
        pr: pull(3245, maintainer, present),
        commits: present,
        statuses: [{ context: CLA_CONTEXT, state: 'success' }],
      },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: true },
    )
    assert.deepEqual(results.map(stateOf), ['success', 'success'])
    assert.deepEqual(
      written.statuses.map((s) => s.sha),
      [missing[0]?.sha],
    )
  })

  it('in the scheduled sweep, rewrites a success that a newer rule or signature change fails', async () => {
    // A change to the signatures, the workflow or the script pushed with
    // GITHUB_TOKEN starts no push backfill, so the sweep is what corrects a
    // success computed under the older rule.
    const commits = [commit(outsider, 'eve@example.com')]
    const { github, written } = fakeGitHub([
      {
        pr: pull(22, outsider, commits, { fork: true }),
        commits,
        statuses: [{ context: CLA_CONTEXT, state: 'success' }],
      },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: true },
    )
    assert.deepEqual(results.map(stateOf), ['failure'])
    assert.deepEqual(
      written.statuses.map((s) => s.state),
      ['failure'],
    )
    assert.equal(written.created.length, 1)
  })

  it('does not let a backfill publish a failure after a noreply co-author signs', async () => {
    // An unsigned `<id>+<login>@users.noreply.github.com` co-author is
    // reported as unresolved, not as an unsigned login, but their signing
    // comment still starts its own run that sets the status.
    const commits = [
      commit(
        maintainer,
        'jk@example.com',
        'x\n\nCo-authored-by: Eve <2+eve@users.noreply.github.com>',
      ),
    ]
    const scenario: Scenario = { pr: pull(13, maintainer, commits), commits }
    const { github, written } = fakeGitHub([scenario])
    const listCommits = github.rest.pulls.listCommits
    github.rest.pulls.listCommits = async (params): ReturnType<typeof listCommits> => {
      // The backfill has read the comments; now eve signs.
      scenario.comments = [{ id: 7, user: outsider, body: SIGN_PHRASE }]
      return listCommits(params)
    }
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: false },
    )
    assert.deepEqual(
      results.map((r) => r.kind),
      ['skipped'],
    )
    assert.deepEqual(written.statuses, [])
    assert.deepEqual(written.created, [])
    // The signing comment's own run sees the signature and passes.
    github.rest.pulls.listCommits = listCommits
    const signing = await evaluatePullRequest(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      13,
    )
    assert.equal(stateOf(signing), 'success')
  })

  it('re-evaluates when a signature lands between the last comment read and the failure write', async () => {
    // The signing comment's run may already have written success; the
    // failure written after it must not be the last word.
    const commits = [commit(outsider, 'eve@example.com')]
    const scenario: Scenario = { pr: pull(14, outsider, commits, { fork: true }), commits }
    const { github, written } = fakeGitHub([scenario])
    const createCommitStatus = github.rest.repos.createCommitStatus
    github.rest.repos.createCommitStatus = async (
      params,
    ): ReturnType<typeof createCommitStatus> => {
      const response = await createCommitStatus(params)
      if (params.state === 'failure' && !scenario.comments) {
        scenario.comments = [{ id: 8, user: outsider, body: SIGN_PHRASE }]
      }
      return response
    }
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: false },
    )
    assert.deepEqual(results.map(stateOf), ['success'])
    assert.equal(written.statuses.at(-1)?.state, 'success')
    assert.deepEqual(written.created, [], 'no request to sign after the signature')
  })

  it('does not let a backfill that read comments before a signature overwrite the signing run', async () => {
    // The backfill (concurrency group `cla-backfill`) and the signing
    // comment's run (`cla-<number>`) can overlap on the same head.
    const commits = [commit(outsider, 'eve@example.com')]
    const scenario: Scenario = { pr: pull(12, outsider, commits, { fork: true }), commits }
    const { github, written } = fakeGitHub([scenario])
    const listCommits = github.rest.pulls.listCommits
    let raced = false
    github.rest.pulls.listCommits = async (params): ReturnType<typeof listCommits> => {
      if (!raced) {
        // The backfill has read the comments; now eve signs and that
        // comment's run evaluates and publishes before the backfill does.
        raced = true
        scenario.comments = [{ id: 6, user: outsider, body: SIGN_PHRASE }]
        const signing = await evaluatePullRequest(
          { github, owner: 'copse-dev', repo: 'agent-pane', log },
          12,
        )
        assert.equal(stateOf(signing), 'success')
      }
      return listCommits(params)
    }
    await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: false },
    )
    assert.ok(raced)
    assert.equal(written.statuses.at(-1)?.state, 'success')
    assert.deepEqual(written.created, [], 'no request to sign after the signature')
  })

  it('in the scheduled sweep, re-evaluates a failing head and rewrites only a changed verdict', async () => {
    // A stale failure (from a race or an older rule) must not block merging
    // until the next push; an unchanged failure is not rewritten every sweep.
    const signed = [commit(outsider, 'eve@example.com')]
    const unsigned = [commit(outsider, 'eve@example.com')]
    const failed = [{ context: CLA_CONTEXT, state: 'failure' }]
    const { github, written } = fakeGitHub([
      {
        pr: pull(20, outsider, signed, { fork: true }),
        commits: signed,
        comments: [{ id: 8, user: outsider, body: SIGN_PHRASE }],
        statuses: failed,
      },
      { pr: pull(21, outsider, unsigned, { fork: true }), commits: unsigned, statuses: failed },
    ])
    const results = await evaluateOpenPullRequests(
      { github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: true },
    )
    assert.deepEqual(results.map(stateOf), ['success', 'failure'])
    assert.deepEqual(written.statuses, [
      {
        sha: signed[0]?.sha,
        state: 'success',
        description: 'Every commit author has signed the CLA',
      },
    ])
    assert.deepEqual(written.created, [])
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
        { onlyChanged: false },
      ),
      /CLA evaluation failed for #1/,
    )
    assert.deepEqual(
      written.statuses.map((s) => s.state),
      ['success'],
    )
  })

  it('in the scheduled sweep, corrects a stale failure comment without rewriting the status', async () => {
    // A default-token push moved the head back to a SHA that already failed;
    // the bot comment still describes the later head's authors.
    const commits = [commit(outsider, 'eve@example.com')]
    const stale: ClaComment = {
      id: 31,
      user: actionsBot,
      body: `${COMMENT_MARKER}\nThanks for contributing. ... Waiting on:\n- @mallory (first seen in abc)`,
    }
    const failed = [{ context: CLA_CONTEXT, state: 'failure' }]
    const scenario: Scenario = {
      pr: pull(15, outsider, commits, { fork: true }),
      commits,
      comments: [stale],
      statuses: failed,
    }
    const first = fakeGitHub([scenario])
    await evaluateOpenPullRequests(
      { github: first.github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: true },
    )
    assert.deepEqual(first.written.statuses, [], 'the failure status stands')
    assert.deepEqual(first.written.created, [])
    assert.equal(first.written.updated.length, 1)
    const corrected = first.written.updated[0]?.body ?? ''
    assert.match(corrected, /@eve/)
    assert.doesNotMatch(corrected, /@mallory/)
    // Once the comment is current, the sweep writes nothing at all.
    scenario.comments = [{ ...stale, body: corrected }]
    const second = fakeGitHub([scenario])
    await evaluateOpenPullRequests(
      { github: second.github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: true },
    )
    assert.deepEqual(second.written, {
      statuses: [],
      created: [],
      updated: [],
      commitListings: [15],
    })
  })

  it('leaves an unchanged failure comment alone', async () => {
    const commits = [commit(outsider, 'eve@example.com')]
    const first = fakeGitHub([{ pr: pull(9, outsider, commits, { fork: true }), commits }])
    await evaluateOpenPullRequests(
      { github: first.github, owner: 'copse-dev', repo: 'agent-pane', log },
      { onlyChanged: false },
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
      { onlyChanged: false },
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
