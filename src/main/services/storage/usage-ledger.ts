import { loadAllProjectThreadMetas } from '../thread-store.ts'
import type { StreamChunk } from '@shared/types'
import {
  storageAppendFile,
  storageDelete,
  storageGet,
  storageListFiles,
  storageReadFile,
  storageRemoveFile,
  storageWriteFile,
} from './storage.ts'
import {
  buildUsageSummary,
  parseUsageEvents,
  pruneUsageEvents,
  type UsageSummary,
} from '@shared/usage/aggregate-usage.ts'
import { safeJsonParse } from '@shared/safe-json.ts'
import { resolveModelPricing } from '../providers/model-pricing-store.ts'
import {
  LEGACY_USAGE_EVENTS_STORAGE_KEY,
  USAGE_EVENTS_DIR,
  USAGE_EVENTS_MIGRATED_FILE,
  type UsageRecordInput,
  type UsageEvent,
} from '@shared/usage/usage-event.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'

// The ledger is a directory of append-only day files (see USAGE_EVENTS_DIR).
// Recording is a single small asynchronous append, so it never blocks the main
// process and never rewrites anything; expiry deletes whole files.

/** Appends and the one-time migration that have started and not yet finished. */
const inFlight = new Set<Promise<void>>()
let migration: Promise<void> | null = null
let housekeepingStarted = false

const segmentFile = (name: string): string => `${USAGE_EVENTS_DIR}/${name}`
const dayFileName = (at: number): string => `${new Date(at).toISOString().slice(0, 10)}.jsonl`

function toUsageEvent(input: UsageRecordInput): UsageEvent {
  const {
    model,
    source,
    projectId,
    threadId,
    at,
    estimated,
    requestedServiceTier,
    responseServiceTier,
    serviceTierUsage,
    hostingProvider,
    ...usage
  } = input
  if (!usage.inputTokens && !usage.outputTokens) {
    throw new Error('Usage record must include at least one non-zero token count')
  }
  return {
    at: at ?? Date.now(),
    model,
    source,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(estimated ? { estimated: true } : {}),
    ...(requestedServiceTier !== undefined ? { requestedServiceTier } : {}),
    ...(responseServiceTier !== undefined ? { responseServiceTier } : {}),
    ...(serviceTierUsage !== undefined ? { serviceTierUsage } : {}),
    ...(hostingProvider !== undefined ? { hostingProvider } : {}),
  }
}

/**
 * Each record is written as `\n{json}`, so a record torn by a crash costs only
 * itself: the next append starts on a fresh line instead of being glued onto it.
 */
function serializeEvents(events: readonly UsageEvent[]): string {
  return events.map((event) => `\n${JSON.stringify(event)}`).join('')
}

function parseLedger(text: string): UsageEvent[] {
  const records: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    // A torn or hand-damaged line is skipped rather than failing the whole ledger.
    const record = safeJsonParse(line)
    if (record !== null) records.push(record)
  }
  return parseUsageEvents(records)
}

/** Run `work` to completion without ever rejecting, remembering it until it settles. */
function track(work: Promise<void>): void {
  inFlight.add(work)
  void work.then(() => inFlight.delete(work))
}

/** Wait for every append (and migration) started so far. */
async function settle(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/**
 * Move a ledger that still lives in config.json into a file, once.
 *
 * The file is written atomically, so its existence means the copy is complete: if
 * the process dies before the config key is deleted, the next call sees the file
 * and only has to delete the key. Ledger files that already exist are never merged
 * with the key — they hold newer events.
 */
function migrateLegacyLedger(): Promise<void> {
  if (migration !== null) return migration
  const legacy = storageGet(LEGACY_USAGE_EVENTS_STORAGE_KEY)
  if (legacy === undefined || legacy === null) return Promise.resolve()
  const running = (async (): Promise<void> => {
    try {
      if ((await storageListFiles(USAGE_EVENTS_DIR)).length === 0) {
        const events = pruneUsageEvents(parseUsageEvents(legacy))
        await storageWriteFile(segmentFile(USAGE_EVENTS_MIGRATED_FILE), serializeEvents(events))
      }
      storageDelete(LEGACY_USAGE_EVENTS_STORAGE_KEY)
    } catch (error) {
      // Leave the key in place; the next call retries.
      console.warn('[usage] could not move the usage ledger out of config.json:', error)
    } finally {
      migration = null
    }
  })()
  migration = running
  return running
}

interface Segment {
  readonly file: string
  readonly events: UsageEvent[]
}

async function readSegments(): Promise<Segment[]> {
  const names = (await storageListFiles(USAGE_EVENTS_DIR)).filter((name) => name.endsWith('.jsonl'))
  return Promise.all(
    names.sort().map(async (name) => {
      const text = await storageReadFile(segmentFile(name))
      return { file: segmentFile(name), events: text === null ? [] : parseLedger(text) }
    }),
  )
}

/**
 * Delete day files whose every event is past the retention window. A file with
 * no readable event is left alone: it may be one an append has just created.
 */
async function dropExpiredSegments(segments: readonly Segment[]): Promise<void> {
  for (const { file, events } of segments) {
    if (events.length > 0 && pruneUsageEvents(events).length === 0) await storageRemoveFile(file)
  }
}

/** Every recorded event still inside the retention window, oldest first. */
export async function readUsageEvents(): Promise<UsageEvent[]> {
  await migrateLegacyLedger()
  await settle()
  const segments = await readSegments()
  await dropExpiredSegments(segments)
  return pruneUsageEvents(segments.flatMap((segment) => segment.events)).sort(
    (left, right) => left.at - right.at,
  )
}

async function appendEvent(event: UsageEvent): Promise<void> {
  try {
    await migrateLegacyLedger()
    await storageAppendFile(segmentFile(dayFileName(event.at)), serializeEvents([event]))
    // Once per launch, so the ledger stays bounded even if nobody opens Usage.
    if (!housekeepingStarted) {
      housekeepingStarted = true
      await dropExpiredSegments(await readSegments())
    }
  } catch (error) {
    // Usage accounting must never break the call being accounted for.
    console.warn('[usage] could not record a usage event:', error)
  }
}

/**
 * Record one usage event. Fire-and-forget: the append is asynchronous, and readers
 * ({@link readUsageEvents}, {@link getUsageSummary}) wait for those in flight.
 */
export function recordUsageEvent(input: UsageRecordInput): void {
  if (!input.inputTokens && !input.outputTokens) return
  track(appendEvent(toUsageEvent(input)))
}

/** Record token usage from an agent run usage chunk (main process). */
export function recordAgentUsageChunk(
  threadId: string,
  chunk: Extract<StreamChunk, { type: 'usage' }>,
): void {
  if (!chunk.inputTokens && !chunk.outputTokens) return
  const executionContext = getThreadExecutionContext()
  const projectId =
    executionContext?.threadId === threadId
      ? executionContext.projectId
      : storageGet('activeProjectId')
  recordUsageEvent({
    model: chunk.model,
    source: chunk.usageSource === 'advisor' ? 'advisor' : 'agent',
    inputTokens: chunk.inputTokens,
    outputTokens: chunk.outputTokens,
    threadId,
    ...(typeof projectId === 'string' && projectId.length > 0 ? { projectId } : {}),
    ...(chunk.cacheReadTokens !== undefined ? { cacheReadTokens: chunk.cacheReadTokens } : {}),
    ...(chunk.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: chunk.cacheCreationTokens }
      : {}),
    ...(chunk.estimated ? { estimated: true } : {}),
    ...(chunk.requestedServiceTier !== undefined
      ? { requestedServiceTier: chunk.requestedServiceTier }
      : {}),
    ...(chunk.responseServiceTier !== undefined
      ? { responseServiceTier: chunk.responseServiceTier }
      : {}),
    ...(chunk.serviceTierUsage !== undefined ? { serviceTierUsage: chunk.serviceTierUsage } : {}),
    ...(chunk.hostingProvider !== undefined ? { hostingProvider: chunk.hostingProvider } : {}),
  })
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const events = await readUsageEvents()
  const threads = await loadAllProjectThreadMetas()
  return buildUsageSummary(events, threads, Date.now(), resolveModelPricing())
}

export async function getUsageEventCount(): Promise<number> {
  return (await readUsageEvents()).length
}
