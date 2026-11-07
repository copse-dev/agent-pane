import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSpineEntries } from '@shared/threads/spine-schema.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import type { PromptEvidence } from './environment-suggestions.ts'

/** Shell tools whose `command` argument is what a shell prompt was about. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['run_shell', 'run_background'])

/** Answers a person gave. Classifier, hook and system verdicts are not evidence of intent. */
const HUMAN_ACTORS: ReadonlySet<string> = new Set(['user', 'mobile-device'])

async function threadDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function modifiedSince(path: string, since: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs >= since
  } catch {
    return false
  }
}

function shellCommand(name: string, args: unknown): string | undefined {
  if (!SHELL_TOOLS.has(name) || !isRecord(args)) return undefined
  const command = args['command']
  return typeof command === 'string' ? command : undefined
}

function threadEvidence(raw: string, threadId: string, since: number): PromptEvidence[] {
  const commands = new Map<string, string>()
  const answered: PromptEvidence[] = []
  const callIds = new Map<PromptEvidence, string>()
  for (const { line } of parseSpineEntries(raw)) {
    if (line?.type === 'message') {
      for (const call of line.toolCalls) {
        const command = shellCommand(call.name, call.args)
        if (command !== undefined) commands.set(call.id, command)
      }
      continue
    }
    if (line?.type !== 'decision' || line.at < since || !HUMAN_ACTORS.has(line.actor)) continue
    if (line.verdict !== 'approved' && line.verdict !== 'denied') continue
    const item: PromptEvidence = {
      at: line.at,
      threadId,
      verdict: line.verdict,
      kind: line.kind,
      subject: line.subject,
      ...(line.cause !== undefined ? { cause: line.cause } : {}),
    }
    answered.push(item)
    if (line.toolCallId !== undefined) callIds.set(item, line.toolCallId)
  }
  // The prompt is recorded before its tool call settles, so join after the whole spine is read.
  return answered.map((item) => {
    const callId = callIds.get(item)
    const command = callId === undefined ? undefined : commands.get(callId)
    return command === undefined ? item : { ...item, command }
  })
}

/**
 * Every prompt a person answered in `projectId` since `since`, joined to its
 * shell command where it had one. Durable shell decisions omit the command text
 * on purpose (`SHELL_DECISION_SUBJECT`), so the command comes from the tool call
 * the decision names, which the thread already stores. Threads untouched since
 * the window began are skipped without being read.
 */
export async function readPromptEvidence(
  projectId: string,
  since: number,
): Promise<PromptEvidence[]> {
  const root = projectStoreDir(projectId)
  const out: PromptEvidence[] = []
  for (const threadId of await threadDirs(root)) {
    const path = join(root, threadId, 'events.jsonl')
    if (!(await modifiedSince(path, since))) continue
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    out.push(...threadEvidence(raw, threadId, since))
  }
  return out
}
