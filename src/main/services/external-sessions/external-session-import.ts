import { randomUUID } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  ExternalSessionImportResult,
  ExternalSessionList,
  ExternalSessionSource,
  ExternalSessionSummary,
  Thread,
} from '@shared/types'
import { acpModelValue } from '@shared/acp.ts'
import { errorMessage } from '@shared/errors.ts'
import {
  claudeConfigDir,
  listClaudeCodeSessionFiles,
  readClaudeCodeSession,
  readClaudeCodeSessionHeader,
} from './claude-code-sessions.ts'
import {
  codexHomeDir,
  listCodexSessionFiles,
  readCodexSession,
  readCodexSessionHeader,
} from './codex-sessions.ts'
import { cwdWithinRoot, externalSessionKey } from './session-files.ts'
import type { ExternalSessionFile, ParsedExternalSession } from './external-session-types.ts'

/**
 * Import saved Claude Code and Codex CLI sessions as Copse threads.
 *
 * The transcript is copied into an ordinary thread. When the matching coding
 * agent is set up in Copse, the thread is also bound to the original session
 * (`acp-session.json`), so its first turn asks that agent to resume the session
 * itself, with its own memory of every tool call, instead of replaying a text
 * transcript. If the agent cannot resume it, the turn falls back to the
 * transcript and says so.
 */

/** The coding agent that continues each source's sessions. */
const AGENT_FOR_SOURCE: Readonly<Record<ExternalSessionSource, string>> = {
  'claude-code': 'claude-acp',
  codex: 'codex-acp',
}

/** Files larger than this are listed but not imported. */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024

export interface ExternalSessionImportDeps {
  projectRoot: (projectId: string) => string | null
  /** Threads already in the project, for the already-imported marks. */
  loadThreadMetas: (projectId: string) => Promise<Thread[]>
  createThread: (projectId: string, thread: Thread) => Promise<void>
  /** Whether a coding agent with this id is set up and enabled. */
  agentEnabled: (agentId: string) => boolean
  /** Where a thread's scoped Claude config lives (`CLAUDE_CONFIG_DIR` for its agent). */
  claudeThreadConfigDir: (projectId: string, threadId: string, agentId: string) => string
  saveBinding: (
    projectId: string,
    threadId: string,
    binding: { agentId: string; sessionId: string; cwd: string },
  ) => Promise<void>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

interface FoundSession {
  file: ExternalSessionFile
  header: ParsedExternalSession
  key: string
  relativeCwd: string
}

async function findSessions(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ sessions: FoundSession[]; sourcesFound: ExternalSessionSource[] }> {
  const [claudeFiles, codexFiles] = await Promise.all([
    listClaudeCodeSessionFiles(root, claudeConfigDir(env)),
    listCodexSessionFiles(codexHomeDir(env)),
  ])
  const sourcesFound: ExternalSessionSource[] = []
  if (claudeFiles) sourcesFound.push('claude-code')
  if (codexFiles) sourcesFound.push('codex')
  const files = [...(claudeFiles ?? []), ...(codexFiles ?? [])]
  const sessions: FoundSession[] = []
  for (const file of files) {
    const header =
      file.source === 'claude-code'
        ? await readClaudeCodeSessionHeader(file).catch(() => null)
        : await readCodexSessionHeader(file).catch(() => null)
    if (!header) continue
    const relativeCwd = cwdWithinRoot(header.cwd, root)
    if (relativeCwd === null) continue
    sessions.push({
      file,
      header,
      key: externalSessionKey(file.source, header.sessionId),
      relativeCwd,
    })
  }
  sessions.sort((a, b) => b.header.updatedAt - a.header.updatedAt)
  return { sessions, sourcesFound }
}

function importedThreadsByKey(threads: Thread[]): Map<string, string> {
  const byKey = new Map<string, string>()
  for (const thread of threads) {
    if (thread.importedSession) byKey.set(thread.importedSession.key, thread.id)
  }
  return byKey
}

export async function listExternalSessions(
  deps: ExternalSessionImportDeps,
  projectId: string,
): Promise<ExternalSessionList> {
  const root = deps.projectRoot(projectId)
  if (!root) return { sessions: [], sourcesFound: [] }
  const [{ sessions, sourcesFound }, threads] = await Promise.all([
    findSessions(root, deps.env ?? process.env),
    deps.loadThreadMetas(projectId),
  ])
  const imported = importedThreadsByKey(threads)
  return {
    sourcesFound,
    sessions: sessions.map(({ header, key, relativeCwd }): ExternalSessionSummary => {
      const threadId = imported.get(key)
      return {
        source: header.source,
        key,
        title: header.title,
        relativeCwd,
        ...(header.gitBranch ? { gitBranch: header.gitBranch } : {}),
        startedAt: header.startedAt,
        updatedAt: header.updatedAt,
        ...(threadId ? { importedThreadId: threadId } : {}),
      }
    }),
  }
}

function buildThread(
  session: ParsedExternalSession,
  key: string,
  model: string | null,
  now: number,
): Thread {
  const lastPrompt = session.messages.findLast((message) => message.role === 'user')
  return {
    id: randomUUID(),
    title: session.title,
    status: 'idle',
    messages: session.messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(model ? { model } : {}),
    // The session ran in the project's own checkout; continue it there rather
    // than moving it into a new worktree.
    worktreeChoice: 'shared',
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    importedSession: { source: session.source, key, importedAt: now },
    ...(lastPrompt ? { lastPromptAt: lastPrompt.createdAt } : {}),
    createdAt: session.startedAt,
    updatedAt: session.updatedAt,
  }
}

/**
 * Give a Claude thread its own copy of the session file, where its scoped
 * `CLAUDE_CONFIG_DIR` will look for it. The user's original session is left
 * untouched: continuing in Copse forks it, as `claude --resume --fork-session`
 * would.
 */
async function copyClaudeSessionForThread(
  deps: ExternalSessionImportDeps,
  projectId: string,
  threadId: string,
  agentId: string,
  file: ExternalSessionFile,
): Promise<void> {
  const configDir = deps.claudeThreadConfigDir(projectId, threadId, agentId)
  const target = join(configDir, 'projects', basename(dirname(file.path)), basename(file.path))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(file.path, target)
}

export async function importExternalSessions(
  deps: ExternalSessionImportDeps,
  projectId: string,
  keys: readonly string[],
): Promise<ExternalSessionImportResult> {
  const result: ExternalSessionImportResult = { imported: [], alreadyImported: [], failed: [] }
  const root = deps.projectRoot(projectId)
  if (!root) {
    result.failed = keys.map((key) => ({ key, reason: 'This project has no local folder.' }))
    return result
  }
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const [{ sessions }, threads] = await Promise.all([
    findSessions(root, env),
    deps.loadThreadMetas(projectId),
  ])
  const imported = importedThreadsByKey(threads)
  const byKey = new Map(sessions.map((session) => [session.key, session]))
  for (const key of new Set(keys)) {
    const existing = imported.get(key)
    if (existing) {
      result.alreadyImported.push({ key, threadId: existing })
      continue
    }
    const found = byKey.get(key)
    if (!found) {
      result.failed.push({ key, reason: 'The session is no longer on this machine.' })
      continue
    }
    if (found.file.bytes > MAX_IMPORT_BYTES) {
      result.failed.push({ key, reason: 'The session file is too large to import.' })
      continue
    }
    try {
      const session =
        found.file.source === 'claude-code'
          ? await readClaudeCodeSession(found.file)
          : await readCodexSession(found.file)
      if (!session) {
        result.failed.push({ key, reason: 'The session has no conversation to import.' })
        continue
      }
      const agentId = AGENT_FOR_SOURCE[session.source]
      const agentReady = deps.agentEnabled(agentId)
      const thread = buildThread(session, key, agentReady ? acpModelValue(agentId) : null, now())
      await deps.createThread(projectId, thread)
      if (agentReady) {
        try {
          if (session.source === 'claude-code') {
            await copyClaudeSessionForThread(deps, projectId, thread.id, agentId, found.file)
          }
          await deps.saveBinding(projectId, thread.id, {
            agentId,
            sessionId: session.sessionId,
            cwd: session.cwd,
          })
        } catch (error) {
          // The thread still has its transcript; the agent will start from that.
          console.warn(
            `[external-sessions] could not link an imported thread to its original session: ${errorMessage(error)}`,
          )
        }
      }
      imported.set(key, thread.id)
      result.imported.push(thread)
    } catch (error) {
      result.failed.push({ key, reason: errorMessage(error) })
    }
  }
  result.imported.sort((a, b) => b.updatedAt - a.updatedAt)
  return result
}
