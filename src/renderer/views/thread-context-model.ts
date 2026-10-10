import type { Project, Thread } from '@shared/types'
import { githubPrKey, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import { sideChatsOf, type SideChatRow } from '@shared/threads/side-chat.ts'
import {
  collectThreadLinks,
  mergeThreadLinks,
  type ThreadBacklink,
} from '@shared/threads/thread-links.ts'

/**
 * What the per-thread Context panel shows (prototype #3538): the repo(s) the
 * thread works in, the links and references it has accumulated, its side chats,
 * and its subagents. Everything here is derived from thread metadata plus, when
 * it is loaded, the transcript. Nothing is stored for the panel itself.
 */

export interface ContextRepo {
  name: string
  path: string
  branch?: string
  checkout: 'worktree' | 'shared'
}

export interface ContextLink {
  kind: 'pr' | 'thread' | 'url'
  /** Stable key for selection and rendering. */
  key: string
  label: string
  /** PR ref for `pr`, thread id for `thread`, URL for `url`. */
  target: string
  pr?: GithubPrRef
  /** A thread link whose target is not in the loaded project. */
  unresolved?: boolean
}

export interface ContextSubagent {
  id: string
  kind: string
  status: 'running' | 'done' | 'error'
  prompt: string
  model?: string
}

/** Present when the open thread is itself a side chat. */
export interface ContextSideOf {
  parentThreadId: string
  parentTitle: string
  /** First line of the message it branched from, when the parent is loaded. */
  anchorExcerpt?: string
}

export interface ThreadContextModel {
  threadId: string
  title?: string
  sideOf?: ContextSideOf
  repos: ContextRepo[]
  links: ContextLink[]
  /** Other active threads that link to this one; recorded links only. */
  mentionedIn: ThreadBacklink[]
  /** Active side chats first, archived after; oldest first within each. */
  sideChats: SideChatRow[]
  subagents: ContextSubagent[]
}

export interface ThreadContextInput {
  thread: Thread
  project: Pick<Project, 'name' | 'path'> | undefined
  /** Every thread of the project, for resolving titles and listing side chats. */
  threads: readonly Thread[]
  mentionedIn?: readonly ThreadBacklink[]
}

function firstLine(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  return line.length <= 90 ? line : `${line.slice(0, 89)}…`
}

function prLabel(ref: GithubPrRef): string {
  return `${ref.owner}/${ref.repo}#${String(ref.number)}`
}

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}`
  } catch {
    return url
  }
}

export function deriveThreadContext(input: ThreadContextInput): ThreadContextModel {
  const { thread, project, threads } = input
  const loaded = thread.messagesLoaded !== false

  const repos: ContextRepo[] = []
  if (project) {
    const checkout = thread.worktree ? 'worktree' : 'shared'
    const branch = thread.worktree?.branch ?? thread.gitBranch
    repos.push({
      name: project.name,
      path: project.path,
      ...(branch !== undefined ? { branch } : {}),
      checkout,
    })
  }

  // Recorded links survive without the transcript; a loaded transcript adds
  // anything not yet recorded (a link streamed this turn).
  const merged = mergeThreadLinks(
    thread.links ?? [],
    loaded ? collectThreadLinks({ id: thread.id, messages: thread.messages }) : [],
  ).links
  const titleById = new Map(threads.map((candidate) => [candidate.id, candidate.title]))

  const links: ContextLink[] = []
  const seenPr = new Set<string>()
  for (const pr of [...(thread.prRefs ?? []), ...(thread.prProductions ?? []).map((p) => p.pr)]) {
    const key = githubPrKey(pr)
    if (seenPr.has(key)) continue
    seenPr.add(key)
    links.push({ kind: 'pr', key: `pr:${key}`, label: prLabel(pr), target: pr.url, pr })
  }
  for (const link of merged) {
    if (link.kind === 'thread') {
      const title = titleById.get(link.target)
      links.push({
        kind: 'thread',
        key: `thread:${link.target}`,
        label: title ?? 'Thread not in this project',
        target: link.target,
        ...(title === undefined ? { unresolved: true } : {}),
      })
    } else {
      links.push({
        kind: 'url',
        key: `url:${link.target}`,
        label: hostLabel(link.target),
        target: link.target,
      })
    }
  }

  const subagents: ContextSubagent[] = []
  if (loaded) {
    for (const message of thread.messages) {
      for (const toolCall of message.toolCalls) {
        const session = toolCall.subagent
        if (!session) continue
        subagents.push({
          id: session.id,
          kind: session.kind,
          status: session.status,
          prompt: firstLine(session.prompt),
          ...(session.model !== undefined ? { model: session.model } : {}),
        })
      }
    }
  }

  const sideChats = sideChatsOf(threads, thread.id, true).sort(
    (a, b) => Number(a.archived) - Number(b.archived),
  )

  let sideOf: ContextSideOf | undefined
  if (thread.sideChat) {
    const parent = threads.find((candidate) => candidate.id === thread.sideChat?.parentThreadId)
    const anchor = parent?.messages.find((m) => m.id === thread.sideChat?.anchorMessageId)
    sideOf = {
      parentThreadId: thread.sideChat.parentThreadId,
      parentTitle: parent?.title ?? 'Parent thread',
      ...(anchor ? { anchorExcerpt: firstLine(anchor.content) } : {}),
    }
  }

  return {
    threadId: thread.id,
    title: thread.title,
    ...(sideOf ? { sideOf } : {}),
    repos,
    links,
    mentionedIn: [...(input.mentionedIn ?? [])],
    sideChats,
    subagents,
  }
}
