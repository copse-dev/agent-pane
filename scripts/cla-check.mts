// The `CLA` commit status: success when every commit author on a pull request
// has signed the Copse Contributor Licence Agreement (CLA.md), failure with a
// comment explaining how to sign otherwise. Copse is dual-licensed
// (LICENSING.md), and a commercial licence can only include code whose author
// granted the rights in CLA.md section 2; the DCO sign-off in CONTRIBUTING.md
// certifies provenance but grants nothing beyond the AGPL.
//
// Loaded by .github/workflows/cla.yml through actions/github-script, which
// passes its authenticated Octokit in. Two entry points share one evaluation:
//   - evaluatePullRequest: one pull request, on its own events;
//   - evaluateOpenPullRequests: every open pull request, for the backfill that
//     covers heads no event reached (a push made with the default
//     GITHUB_TOKEN starts no workflow) and results computed by an older rule
//     or before a signature landed. The scheduled sweep recomputes every head,
//     success included, because a signature or rule change pushed to main
//     with GITHUB_TOKEN starts no push backfill either.
//
// Node builtins only, and not even those: the workflow checks out this one
// file from the trusted base commit, with no install, so it must not import
// anything. It never reads pull request code, only the API.
//
// An author counts as signed when any of these holds:
//   - they have push access to this repository (the copyright holder and
//     collaborators, whose terms are settled outside this check);
//   - their GitHub user id is in .github/cla-signatures.json on the default
//     branch;
//   - they have commented the signing sentence on this pull request.
//
// Tools are not authors. A commit authored under an agent or bot identity (an
// address in NON_AUTHOR_EMAIL, or one GitHub resolves to a Bot account) is
// answered for by whoever opened the pull request, because the address is
// self-declared: nothing more when the opener is trusted, otherwise the opener
// must have signed, and an untrusted bot opener cannot sign at all. Agent and
// bot Co-authored-by trailers are skipped; they only ever add authors, and the
// commit's own author is checked separately.
//
// A trusted opener is a person with push access, or one of this repository's
// automation Apps (TRUSTED_AUTOMATION) opening from a branch in this
// repository. Any other bot or App is untrusted, even from a branch here:
// anyone can open a pull request from an existing branch, so the branch says
// nothing about the App that opened it. A maintainer opener also answers for
// an author or co-author whose email is not linked to any GitHub account
// (maintainers' own commits and trailers often carry unlinked addresses); an
// App cannot answer for a person, so on its pull requests such an address
// must be in the signatures file. Authors that do resolve to an account are
// checked as that account either way.

export const CLA_CONTEXT = 'CLA'
export const SIGN_PHRASE = 'I have read the Copse CLA Document and I hereby sign the CLA'
export const COMMENT_MARKER = '<!-- copse-cla-check -->'
export const SIGNATURES_PATH = '.github/cla-signatures.json'

/** Trailers and commit addresses our agents, bots and release tooling use. */
export const NON_AUTHOR_EMAIL =
  /@anthropic\.com$|@cursor\.com$|^noreply@copse\.dev$|\[bot\]@users\.noreply\.github\.com$/i
const NOREPLY_ID = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/i
const CO_AUTHOR_TRAILER = /^Co-authored-by:.*<([^>]+)>\s*$/gim

/**
 * The Apps that open pull requests here, by account id (a login can be
 * renamed; an id cannot be reused): copse-release-bot, through its
 * installation token in release-bump, promote-develop and the sync-*
 * workflows, and Dependabot. github-actions[bot] is absent because this
 * organization blocks GITHUB_TOKEN from opening pull requests.
 */
export const TRUSTED_AUTOMATION: ReadonlyMap<number, string> = new Map([
  [304038887, 'copse-release-bot[bot]'],
  [49699333, 'dependabot[bot]'],
])

/** `pulls.listCommits` stops at this many; a longer pull request cannot be checked. */
export const MAX_LISTED_COMMITS = 250

const SUCCESS_DESCRIPTION = 'Every commit author has signed the CLA'
const SIGNED_COMMENT_TEXT = 'All commit authors have signed'

export interface ClaUser {
  login: string
  id: number
  type?: string | undefined
}

export interface ClaPullRequest {
  number: number
  state: string
  user: ClaUser | null
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { ref: string; repo: { full_name: string; default_branch: string } }
}

export interface ClaComment {
  id: number
  body?: string | undefined
  user: ClaUser | null
}

export interface ClaCommit {
  sha: string
  author: ClaUser | null
  commit: { message: string; author: { email?: string | undefined } | null }
}

interface RepoParams {
  owner: string
  repo: string
}

type StatusState = 'success' | 'failure'

/**
 * The slice of github-script's Octokit this module calls. Function properties,
 * so a test double must accept everything the real client is sent.
 */
export interface ClaOctokit {
  paginate: <P, T>(method: (params: P) => Promise<{ data: T[] }>, params: P) => Promise<T[]>
  rest: {
    pulls: {
      get: (p: RepoParams & { pull_number: number }) => Promise<{ data: ClaPullRequest }>
      list: (
        p: RepoParams & { state: 'open'; per_page: number },
      ) => Promise<{ data: ClaPullRequest[] }>
      listCommits: (
        p: RepoParams & { pull_number: number; per_page: number },
      ) => Promise<{ data: ClaCommit[] }>
    }
    issues: {
      listComments: (
        p: RepoParams & { issue_number: number; per_page: number },
      ) => Promise<{ data: ClaComment[] }>
      createComment: (p: RepoParams & { issue_number: number; body: string }) => Promise<unknown>
      updateComment: (p: RepoParams & { comment_id: number; body: string }) => Promise<unknown>
    }
    repos: {
      getContent: (p: RepoParams & { path: string; ref: string }) => Promise<{ data: unknown }>
      getCollaboratorPermissionLevel: (
        p: RepoParams & { username: string },
      ) => Promise<{ data: { permission: string } }>
      getCombinedStatusForRef: (
        p: RepoParams & { ref: string; per_page: number },
      ) => Promise<{ data: { statuses: { context: string; state: string }[] } }>
      createCommitStatus: (
        p: RepoParams & {
          sha: string
          state: StatusState
          context: string
          target_url: string
          description: string
        },
      ) => Promise<unknown>
    }
    users: {
      getByUsername: (p: { username: string }) => Promise<{ data: ClaUser }>
    }
  }
}

export interface ClaContext {
  github: ClaOctokit
  owner: string
  repo: string
  log: (message: string) => void
}

export type ClaResult =
  | { kind: 'skipped'; number: number; reason: string }
  | {
      kind: 'evaluated'
      number: number
      sha: string
      state: StatusState
      description: string
      unsigned: { login: string; sha: string }[]
      unresolved: string[]
    }

/** What an evaluation read from the pull request's comments. */
interface Reading {
  signings: Set<number>
  comments: ClaComment[]
}

interface Signatures {
  ids: Set<number>
  emails: Set<string>
}

function httpStatus(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
}

function isBot(user: ClaUser): boolean {
  return user.type === 'Bot' || user.login.endsWith('[bot]')
}

function isTrustedAutomation(user: ClaUser): boolean {
  return TRUSTED_AUTOMATION.get(user.id) === user.login
}

function sameRepository(pr: ClaPullRequest): boolean {
  return pr.head.repo?.full_name === pr.base.repo.full_name
}

/** Decodes .github/cla-signatures.json. Invalid content throws: fix it on main. */
export function decodeSignatures(text: string): Signatures {
  const parsed: unknown = JSON.parse(text)
  const ids = new Set<number>()
  const emails = new Set<string>()
  if (typeof parsed !== 'object' || parsed === null || !('signatures' in parsed)) {
    return { ids, emails }
  }
  const { signatures } = parsed
  if (!Array.isArray(signatures)) return { ids, emails }
  const entries: readonly unknown[] = signatures
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    if ('id' in entry) {
      const id = Number(entry.id)
      if (Number.isFinite(id)) ids.add(id)
    }
    if ('emails' in entry && Array.isArray(entry.emails)) {
      const addresses: readonly unknown[] = entry.emails
      for (const email of addresses) {
        if (typeof email === 'string') emails.add(email.toLowerCase())
      }
    }
  }
  return { ids, emails }
}

function decodeContentBase64(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('content' in data)) return null
  return typeof data.content === 'string'
    ? Buffer.from(data.content, 'base64').toString('utf8')
    : null
}

/**
 * Evaluates pull requests against one repository. Caches what does not change
 * between pull requests in one run: the signature file and permission lookups.
 */
export interface ClaEvaluator {
  /** The verdict for one pull request, without writing anything. */
  decide: (pr: ClaPullRequest) => Promise<ClaResult>
  /**
   * Decides, then sets the status on the head and syncs the comment. With
   * `current` (the head's `CLA` state now), an unchanged verdict writes nothing.
   */
  evaluate: (pr: ClaPullRequest, current?: string) => Promise<ClaResult>
}

export function createClaEvaluator(ctx: ClaContext): ClaEvaluator {
  const { github, owner, repo, log } = ctx
  const signatureCache = new Map<string, Promise<Signatures>>()
  const pushCache = new Map<string, Promise<boolean>>()
  const botCache = new Map<string, Promise<boolean>>()

  // Signatures on the default branch — never read from the pull request,
  // which could add its own author.
  function signaturesOn(ref: string): Promise<Signatures> {
    let cached = signatureCache.get(ref)
    if (!cached) {
      cached = (async (): Promise<Signatures> => {
        try {
          const { data } = await github.rest.repos.getContent({
            owner,
            repo,
            path: SIGNATURES_PATH,
            ref,
          })
          const text = decodeContentBase64(data)
          if (text === null) throw new Error(`${SIGNATURES_PATH} on ${ref} is not a file`)
          return decodeSignatures(text)
        } catch (error) {
          if (httpStatus(error) !== 404) throw error
          return { ids: new Set<number>(), emails: new Set<string>() }
        }
      })()
      signatureCache.set(ref, cached)
    }
    return cached
  }

  function canPush(login: string): Promise<boolean> {
    let cached = pushCache.get(login)
    if (!cached) {
      cached = (async (): Promise<boolean> => {
        try {
          const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
            owner,
            repo,
            username: login,
          })
          return data.permission === 'admin' || data.permission === 'write'
        } catch (error) {
          if (httpStatus(error) !== 404) throw error
          return false
        }
      })()
      pushCache.set(login, cached)
    }
    return cached
  }

  /** Whether a noreply trailer's login is a Bot account (Copilot, for one). */
  function isBotLogin(login: string): Promise<boolean> {
    let cached = botCache.get(login)
    if (!cached) {
      cached = (async (): Promise<boolean> => {
        try {
          const { data } = await github.rest.users.getByUsername({ username: login })
          return isBot(data)
        } catch (error) {
          if (httpStatus(error) !== 404) throw error
          return false
        }
      })()
      botCache.set(login, cached)
    }
    return cached
  }

  /**
   * Who opened the pull request: a person with push access, this repository's
   * automation on a branch here, or anyone else.
   */
  async function openerKind(pr: ClaPullRequest): Promise<'maintainer' | 'automation' | 'other'> {
    if (!pr.user) return 'other'
    if (isBot(pr.user)) {
      return isTrustedAutomation(pr.user) && sameRepository(pr) ? 'automation' : 'other'
    }
    return (await canPush(pr.user.login)) ? 'maintainer' : 'other'
  }

  /**
   * The verdict, recording in `reading` the comments it read and the id of
   * every signing comment it counted, so that publish can tell a signature
   * posted after this read.
   */
  async function decideReading(pr: ClaPullRequest, reading: Reading): Promise<ClaResult> {
    const { number } = pr
    // A promotion (main -> release, opened by copse-release-bot) carries only
    // commits already on the default branch, each of which merged there
    // through this check. The `release` ruleset does not require CLA, and a
    // promotion regularly exceeds the 250 commits the API will list.
    if (sameRepository(pr) && pr.head.ref === pr.base.repo.default_branch) {
      return {
        kind: 'evaluated',
        number,
        sha: pr.head.sha,
        state: 'success',
        description: `Promotes ${pr.head.ref}, whose commits pass CLA before they merge there`,
        unsigned: [],
        unresolved: [],
      }
    }

    const signatures = await signaturesOn(pr.base.repo.default_branch)
    const signedIds = new Set(signatures.ids)
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    })
    reading.comments = comments
    for (const c of comments) {
      if (c.user && c.body?.includes(SIGN_PHRASE)) {
        signedIds.add(c.user.id)
        reading.signings.add(c.id)
      }
    }

    const commits = await github.paginate(github.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    })
    // The head moved between reading the pull request and listing its
    // commits. The push that moved it raised its own event (or the backfill
    // reaches it), so do not stamp this list's verdict on the older head. A
    // listing cut off at MAX_LISTED_COMMITS ends before the head, so there
    // the pull request is read again: a push that took it from under the
    // limit to the limit must not stamp the truncation failure on the old
    // head.
    const last = commits.at(-1)
    if (last && last.sha !== pr.head.sha) {
      const now =
        commits.length < MAX_LISTED_COMMITS
          ? last.sha
          : (await github.rest.pulls.get({ owner, repo, pull_number: number })).data.head.sha
      if (now !== pr.head.sha) {
        return { kind: 'skipped', number, reason: `head moved from ${pr.head.sha} to ${now}` }
      }
    }

    const opener = await openerKind(pr)
    const trusted = opener !== 'other'
    // Only a person answers for a person's unlinked address.
    const answersForUnlinked = opener === 'maintainer'
    const unsigned = new Map<string, string>() // login -> first sha
    const unresolved: string[] = []

    async function checkPerson(user: ClaUser, sha: string): Promise<void> {
      if (signedIds.has(user.id) || (await canPush(user.login))) return
      if (!unsigned.has(user.login)) unsigned.set(user.login, sha)
    }

    // An agent or bot wrote this commit (its address can map to an account,
    // e.g. noreply@anthropic.com to @claude). Whoever opened the pull request
    // answers for it; the address is self-declared, so an outside opener must
    // have signed, and any other bot has no one to sign for it.
    async function answeredByOpener(sha: string): Promise<void> {
      if (trusted) return
      if (!pr.user || isBot(pr.user)) {
        unresolved.push(
          `agent or bot commit ${sha} in a pull request opened by ${pr.user?.login ?? 'an unknown account'}, which is not this repository's automation`,
        )
        return
      }
      await checkPerson(pr.user, sha)
    }

    for (const c of commits) {
      const sha = c.sha.slice(0, 9)
      const authorEmail = (c.commit.author?.email ?? '').toLowerCase()
      if (NON_AUTHOR_EMAIL.test(authorEmail) || (c.author && isBot(c.author))) {
        await answeredByOpener(sha)
      } else if (c.author) {
        await checkPerson(c.author, sha)
      } else if (!answersForUnlinked && !signatures.emails.has(authorEmail)) {
        unresolved.push(`${authorEmail || 'no email'} (${sha})`)
      }
      for (const m of c.commit.message.matchAll(CO_AUTHOR_TRAILER)) {
        const email = (m[1] ?? '').toLowerCase()
        if (NON_AUTHOR_EMAIL.test(email) || signatures.emails.has(email)) continue
        const noreply = NOREPLY_ID.exec(email)
        if (noreply) {
          const id = Number(noreply[1])
          const login = noreply[2] ?? ''
          if (signedIds.has(id) || (await canPush(login)) || (await isBotLogin(login))) continue
        } else if (answersForUnlinked) {
          continue
        }
        unresolved.push(`co-author ${email} (${sha})`)
      }
    }
    if (commits.length >= MAX_LISTED_COMMITS) {
      unresolved.push(
        `${String(MAX_LISTED_COMMITS)} or more commits; GitHub lists only the first ${String(MAX_LISTED_COMMITS)}, so split the pull request`,
      )
    }

    const ok = unsigned.size === 0 && unresolved.length === 0
    return {
      kind: 'evaluated',
      number,
      sha: pr.head.sha,
      state: ok ? 'success' : 'failure',
      description: ok
        ? SUCCESS_DESCRIPTION
        : `${String(unsigned.size + unresolved.length)} author(s) need to sign or be identified`,
      unsigned: [...unsigned].map(([login, first]) => ({ login, sha: first })),
      unresolved,
    }
  }

  function failureBody(result: Extract<ClaResult, { kind: 'evaluated' }>, claUrl: string): string {
    const lines = [
      COMMENT_MARKER,
      `Thanks for contributing. Copse is dual-licensed, so before this pull request can merge, every commit author needs to sign the [Copse Contributor Licence Agreement](${claUrl}). You keep the copyright in your work.`,
      '',
    ]
    if (result.unsigned.length > 0) {
      lines.push(
        'To sign, read the agreement and post this exact sentence as a comment here:',
        '',
        `> ${SIGN_PHRASE}`,
        '',
        'Waiting on:',
        ...result.unsigned.map(({ login, sha }) => `- @${login} (first seen in ${sha})`),
        '',
      )
    }
    if (result.unresolved.length > 0) {
      lines.push(
        'These authors could not be matched to a GitHub account that can sign. Link the email under **Settings → Emails** on GitHub, or rewrite the commits with a linked address, then push again:',
        ...result.unresolved.map((u) => `- ${u}`),
        '',
      )
    }
    return lines.join('\n')
  }

  function decide(pr: ClaPullRequest): Promise<ClaResult> {
    return decideReading(pr, { signings: new Set<number>(), comments: [] })
  }

  function claUrlOf(pr: ClaPullRequest): string {
    return `https://github.com/${owner}/${repo}/blob/${pr.base.repo.default_branch}/CLA.md`
  }

  /**
   * The write that brings the bot comment in line with `result`, or null when
   * it already is: a failure creates or updates it; a success updates one
   * left from a failure and creates none.
   */
  function commentWrite(
    result: Extract<ClaResult, { kind: 'evaluated' }>,
    comments: readonly ClaComment[],
    claUrl: string,
  ): { id: number | undefined; body: string } | null {
    const existing = comments.find(
      (c) => c.user?.type === 'Bot' && c.body?.includes(COMMENT_MARKER),
    )
    if (result.state === 'success') {
      if (!existing || existing.body?.includes(SIGNED_COMMENT_TEXT)) return null
      return {
        id: existing.id,
        body: `${COMMENT_MARKER}\n${SIGNED_COMMENT_TEXT} the [Copse CLA](${claUrl}). Thank you.`,
      }
    }
    const body = failureBody(result, claUrl)
    return existing?.body === body ? null : { id: existing?.id, body }
  }

  /**
   * Sets the status on the head it was computed for and syncs the comment.
   * Writes nothing when a failure may have gone stale: a signing comment the
   * evaluation did not count (`signings`) has since been posted, whoever
   * posted it (an unsigned author, or a co-author the failure lists as
   * unresolved). That comment starts its own run, in another concurrency
   * group from the backfill, which sets the status; a failure written after
   * it would stand on a signed head. A signature that lands between that
   * read and the failure write is caught by reading the comments once more
   * after it: the pull request is then evaluated again (once, `retry`) and
   * that verdict published, so the last status written reflects it. Without
   * `writeStatus` (the verdict is unchanged) only an existing comment is
   * corrected.
   */
  async function publish(
    pr: ClaPullRequest,
    result: Extract<ClaResult, { kind: 'evaluated' }>,
    signings: ReadonlySet<number>,
    options: { writeStatus: boolean; retry: boolean },
  ): Promise<ClaResult> {
    const claUrl = claUrlOf(pr)
    const listComments = (): Promise<ClaComment[]> =>
      github.paginate(github.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pr.number,
        per_page: 100,
      })
    const uncounted = (list: ClaComment[]): ClaUser | null | undefined =>
      list.find((c) => c.user && !signings.has(c.id) && c.body?.includes(SIGN_PHRASE))?.user
    const comments = await listComments()
    if (result.state === 'failure') {
      const signer = uncounted(comments)
      if (signer) {
        return {
          kind: 'skipped',
          number: pr.number,
          reason: `${signer.login} signed while this was evaluated; the signing comment's run sets the status`,
        }
      }
    }
    if (options.writeStatus) {
      await github.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: result.sha,
        context: CLA_CONTEXT,
        target_url: claUrl,
        state: result.state,
        description: result.description.slice(0, 140),
      })
    }
    if (result.state === 'failure' && options.writeStatus && options.retry) {
      const late = uncounted(await listComments())
      if (late) {
        log(
          `#${String(pr.number)}: ${late.login} signed as the failure was written; evaluating again`,
        )
        return evaluateOnce(pr, undefined, false)
      }
    }

    const write = commentWrite(result, comments, claUrl)
    if (write?.id === undefined) {
      // An unchanged verdict corrects a comment but does not post one: a
      // maintainer may have deleted it.
      if (write && options.writeStatus) {
        await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: write.body,
        })
      }
    } else {
      await github.rest.issues.updateComment({
        owner,
        repo,
        comment_id: write.id,
        body: write.body,
      })
    }
    return result
  }

  async function evaluateOnce(
    pr: ClaPullRequest,
    current: string | undefined,
    retry: boolean,
  ): Promise<ClaResult> {
    if (pr.state !== 'open') return { kind: 'skipped', number: pr.number, reason: 'not open' }
    const reading: Reading = { signings: new Set<number>(), comments: [] }
    const result = await decideReading(pr, reading)
    if (result.kind !== 'evaluated') return result
    if (result.state !== current) {
      return publish(pr, result, reading.signings, { writeStatus: true, retry })
    }
    // The verdict stands, but the comment may describe another head: one a
    // default-token push moved away from and back to this failed SHA. Sync
    // it, through publish's signature guard, only when it is out of date.
    if (commentWrite(result, reading.comments, claUrlOf(pr))?.id === undefined) return result
    return publish(pr, result, reading.signings, { writeStatus: false, retry: false })
  }

  function evaluate(pr: ClaPullRequest, current?: string): Promise<ClaResult> {
    return evaluateOnce(pr, current, true)
  }

  return { decide, evaluate }
}

function summarize(result: ClaResult): string {
  return result.kind === 'skipped'
    ? `#${String(result.number)}: skipped (${result.reason})`
    : `#${String(result.number)}: ${result.state} on ${result.sha.slice(0, 12)} — ${result.description}`
}

/** One pull request, on its own `pull_request_target` or signing-comment event. */
export async function evaluatePullRequest(ctx: ClaContext, number: number): Promise<ClaResult> {
  const { data: pr } = await ctx.github.rest.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: number,
  })
  const result = await createClaEvaluator(ctx).evaluate(pr)
  ctx.log(summarize(result))
  return result
}

/**
 * Every open pull request, every head recomputed. With `onlyChanged` (the
 * scheduled sweep), a head's current `CLA` state is read first and a verdict
 * is written only where it differs: a head with no status yet, a stale failure
 * (a backfill that read the comments before a signature can finish after the
 * signing run), or a stale success (a signature or rule change pushed with
 * GITHUB_TOKEN starts no push backfill). Otherwise every verdict is rewritten
 * (after a signature or rule change, or on dispatch). One pull request's
 * failure does not stop the rest; the run fails at the end if any did.
 *
 * Cost per pull request: the status read, one page each of comments and
 * commits (more only past 100 of either), and a permission or user lookup
 * per login not seen before in the run. About 3 requests a head, so ~400 for
 * 120 open pull requests, once every 2 hours, against GITHUB_TOKEN's
 * 1,000 an hour per repository.
 */
export async function evaluateOpenPullRequests(
  ctx: ClaContext,
  options: { onlyChanged: boolean },
): Promise<ClaResult[]> {
  const { github, owner, repo, log } = ctx
  const evaluator = createClaEvaluator(ctx)
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  })
  const results: ClaResult[] = []
  const failed: number[] = []
  for (const pr of pulls) {
    try {
      let current: string | undefined
      if (options.onlyChanged) {
        // The combined status carries the latest status of each context.
        const { data } = await github.rest.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: pr.head.sha,
          per_page: 100,
        })
        current = data.statuses.find((s) => s.context === CLA_CONTEXT)?.state
      }
      const result = await evaluator.evaluate(pr, current)
      log(summarize(result))
      results.push(result)
    } catch (error) {
      failed.push(pr.number)
      log(
        `#${String(pr.number)}: error — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  log(`Evaluated ${String(results.length)} of ${String(pulls.length)} open pull request(s).`)
  if (failed.length > 0) {
    throw new Error(`CLA evaluation failed for ${failed.map((n) => `#${String(n)}`).join(', ')}`)
  }
  return results
}
