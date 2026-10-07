import { z } from 'zod'
import { extractGithubPrUrls, parseGithubPrUrl, type GithubPrRef } from './github-pr-url.ts'
import type { Thread } from './thread-types.ts'

export const prRefSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.url(),
})
export const prProductionSchema = z.object({
  pr: prRefSchema,
  eventId: z.string().min(1),
  source: z.literal('pr-create'),
  createdAt: z.number().int().nonnegative(),
})
export const commitProductionSchema = z.object({
  repository: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/u),
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  eventId: z.string().min(1),
  source: z.literal('git-commit'),
  createdAt: z.number().int().nonnegative(),
})
export type PrProduction = z.infer<typeof prProductionSchema>
export type CommitProduction = z.infer<typeof commitProductionSchema>
export type PrRelationshipKind = 'produced' | 'referenced' | 'agent-linked'
export interface PrThreadRelationship {
  threadId: string
  title: string
  kinds: PrRelationshipKind[]
  productions: PrProduction[]
}
export interface ThreadPrRelationship {
  pr: GithubPrRef
  kinds: PrRelationshipKind[]
}
export type RelationshipThread = Pick<
  Thread,
  | 'id'
  | 'title'
  | 'prRefs'
  | 'prProductions'
  | 'commitProductions'
  | 'remoteAgentLink'
  | 'archivedAt'
>

/** Provider-returned identity, including enterprise hosts; not a prose URL detector. */
export function parsePrRelationUrl(raw: string): GithubPrRef | null {
  try {
    const url = new URL(raw)
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/u.exec(url.pathname)
    const [, owner, repo, number] = match ?? []
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !owner || !repo || !number)
      return null
    if (!Number.isSafeInteger(Number(number))) return null
    return { owner, repo, number: Number(number), url: raw }
  } catch {
    return null
  }
}

export function prRepositoryKey(pr: GithubPrRef): string {
  return `${new URL(pr.url).hostname.replace(/^www\./iu, '').toLowerCase()}/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`
}

export function prRelationKey(pr: GithubPrRef): string {
  return `${prRepositoryKey(pr)}#${String(pr.number)}`
}

/** All related PRs, without promoting a URL mention or legacy agent link to production. */
export function threadPrRelationships(
  thread: RelationshipThread,
  messages: readonly { content: string }[] = [],
): ThreadPrRelationship[] {
  const refs = new Map<string, ThreadPrRelationship>()
  const add = (pr: GithubPrRef, kind: PrRelationshipKind): void => {
    const parsed = parsePrRelationUrl(pr.url)
    if (
      !parsed ||
      parsed.owner.toLowerCase() !== pr.owner.toLowerCase() ||
      parsed.repo.toLowerCase() !== pr.repo.toLowerCase() ||
      parsed.number !== pr.number
    )
      return
    const key = prRelationKey(pr)
    let entry = refs.get(key)
    if (!entry) {
      entry = { pr, kinds: [] }
      refs.set(key, entry)
    }
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind)
  }
  for (const pr of thread.prRefs ?? []) add(pr, 'referenced')
  for (const message of messages)
    for (const pr of extractGithubPrUrls(message.content)) add(pr, 'referenced')
  if (thread.remoteAgentLink?.prUrl) {
    const pr = parseGithubPrUrl(thread.remoteAgentLink.prUrl)
    if (pr) add(pr, 'agent-linked')
  }
  for (const production of thread.prProductions ?? []) add(production.pr, 'produced')
  return [...refs.values()]
}

/** Rebuildable, project-scoped index. Each PR/commit keeps all matching threads. */
export class ThreadPrRelationshipIndex {
  #threads = new Map<string, RelationshipThread>()
  #byPr = new Map<string, Set<string>>()
  #byCommit = new Map<string, Set<string>>()
  #refs = new Map<string, ThreadPrRelationship[]>()

  constructor(threads: readonly RelationshipThread[] = []) {
    for (const thread of threads) this.upsert(thread)
  }

  upsert(thread: RelationshipThread): void {
    this.remove(thread.id)
    if (thread.archivedAt != null) return
    this.#threads.set(thread.id, thread)
    const refs = threadPrRelationships(thread)
    this.#refs.set(thread.id, refs)
    for (const { pr } of refs) this.#add(this.#byPr, prRelationKey(pr), thread.id)
    for (const commit of thread.commitProductions ?? []) {
      this.#add(this.#byCommit, `${commit.repository}@${commit.sha}`, thread.id)
    }
  }

  #add(map: Map<string, Set<string>>, key: string, threadId: string): void {
    let ids = map.get(key)
    if (!ids) {
      ids = new Set()
      map.set(key, ids)
    }
    ids.add(threadId)
  }

  remove(threadId: string): void {
    const remove = (map: Map<string, Set<string>>, key: string): void => {
      const ids = map.get(key)
      ids?.delete(threadId)
      if (ids?.size === 0) map.delete(key)
    }
    for (const { pr } of this.#refs.get(threadId) ?? []) remove(this.#byPr, prRelationKey(pr))
    for (const commit of this.#threads.get(threadId)?.commitProductions ?? []) {
      remove(this.#byCommit, `${commit.repository}@${commit.sha}`)
    }
    this.#threads.delete(threadId)
    this.#refs.delete(threadId)
  }

  forPr(pr: GithubPrRef): PrThreadRelationship[] {
    const key = prRelationKey(pr)
    const rows: PrThreadRelationship[] = []
    for (const id of this.#byPr.get(key) ?? []) {
      const thread = this.#threads.get(id)
      const ref = this.#refs.get(id)?.find((item) => prRelationKey(item.pr) === key)
      if (!thread || !ref) continue
      rows.push({
        threadId: id,
        title: thread.title,
        kinds: [...ref.kinds],
        productions: (thread.prProductions ?? []).filter((item) => prRelationKey(item.pr) === key),
      })
    }
    return rows.sort((a, b) => a.threadId.localeCompare(b.threadId))
  }

  forThread(threadId: string): ThreadPrRelationship[] {
    return (this.#refs.get(threadId) ?? []).map((item) => ({
      pr: { ...item.pr },
      kinds: [...item.kinds],
    }))
  }

  forCommit(
    repository: string,
    sha: string,
  ): Array<{ threadId: string; title: string; evidence: CommitProduction[] }> {
    const rows: Array<{ threadId: string; title: string; evidence: CommitProduction[] }> = []
    for (const id of this.#byCommit.get(`${repository.toLowerCase()}@${sha.toLowerCase()}`) ?? []) {
      const thread = this.#threads.get(id)
      if (!thread) continue
      rows.push({
        threadId: id,
        title: thread.title,
        evidence: (thread.commitProductions ?? []).filter(
          (item) => item.repository === repository.toLowerCase() && item.sha === sha.toLowerCase(),
        ),
      })
    }
    return rows
  }
}
