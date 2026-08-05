// The `hooks:runDetail` IPC: read the raw record behind one hook card.
//
// A hook card (decision 10) is a compact summary — "Added context", "307 chars"
// — derived from the spine `hook_run` line. That answers *what happened* but not
// *what was in it*, which is the question anyone debugging a hook actually has.
// The bodies were already being captured as blobs (decision 6); this is the read
// path that puts them in front of the user, on demand, without the transcript
// ever holding a second copy.
//
// Read-only by construction: it resolves the thread from the id the renderer is
// showing, reads the spine, and returns text. Nothing here re-runs a hook — the
// G2 dry-run tester (`dry-run.ts`) owns that, deliberately separately.
import { readHookRun } from '../thread-store.ts'
import type { HookRunDetail } from '@shared/types/hooks.ts'

/**
 * Ceiling on a single stream returned to the renderer. Capture already bounds
 * payload / outcome blobs, but raw command-hook stdout/stderr are stored under
 * the runner's much larger cap (1 MB each) — an inspector open should never ship
 * a megabyte over IPC into a `<pre>`. Truncation is marked, never silent.
 */
const MAX_DETAIL_CHARS = 64_000

function bounded(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text
  const dropped = text.length - MAX_DETAIL_CHARS
  return `${text.slice(0, MAX_DETAIL_CHARS)}\n… [truncated ${String(dropped)} more chars]`
}

/**
 * Assemble the inspector payload for one recorded hook execution. An id with no
 * recorded run — a live card whose spine append has not landed, or a pruned
 * thread — comes back as `{ found: false }` rather than an error, so the
 * inspector can say so plainly instead of surfacing a failed IPC.
 */
export async function readHookRunDetail(
  projectId: string,
  threadId: string,
  runId: string,
): Promise<HookRunDetail> {
  const stored = await readHookRun(projectId, threadId, runId)
  if (!stored) return { found: false }

  const { line } = stored
  const missing: string[] = []
  const stream = (blob: { ref: string; text: string | null } | null): string | undefined => {
    if (!blob) return undefined
    if (blob.text === null) {
      missing.push(blob.ref)
      return undefined
    }
    return bounded(blob.text)
  }

  // Read every stream before building the result: `stream` accumulates `missing`
  // as a side effect, so the list is only complete once all four have run.
  const payload = stream(stored.payload)
  const stdout = stream(stored.stdout)
  const stderr = stream(stored.stderr)
  const outcome = stream(stored.outcome)

  return {
    found: true,
    event: line.event,
    hookId: line.hookId,
    executor: line.executor,
    ...(line.turnId !== undefined ? { turnId: line.turnId } : {}),
    ...(line.step !== undefined ? { step: line.step } : {}),
    startedAt: line.startedAt,
    durationMs: line.durationMs,
    ...(line.exitCode !== undefined ? { exitCode: line.exitCode } : {}),
    parseOk: line.parseOk,
    ...(line.toolset !== undefined ? { toolset: line.toolset } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  }
}
