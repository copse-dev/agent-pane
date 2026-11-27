import { z } from 'zod'
import {
  connectLocalLine,
  localSocketPath,
  serveLocalLine,
  type LocalLineClient,
  type LocalLineConnection,
  type LocalLineServer,
} from '../local-socket.ts'
import type { StreamChunk, TranscriptSnapshot, TranscriptStamp } from '@shared/types'
import type { ApprovalRequest, ApprovalResponse } from '../approval.ts'

/**
 * The line between the app and the resident turn host
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host").
 *
 * One local line per profile (`local-socket.ts`), newline-delimited JSON. It
 * extends the per-turn worker's line (`turn-worker-socket.ts`) to many threads
 * and adds the verbs a turn needs when it starts in the host rather than being
 * handed over at quit:
 *
 * - `hello` exchanges versions. An app sends turns only to a host of its own
 *   version; a host of another version finishes what it has and retires.
 * - `dispatch` starts a turn: the same project, thread and raw payload the
 *   window sends main on `agent:run`. The host answers `accepted` once the
 *   thread is claimed, or `refused` with a reason, then `ended` when the turn
 *   is over. A refused turn runs in the app as before.
 * - `attach` joins the stream: every chunk and snapshot of every thread the host
 *   runs, in the order an in-process turn reaches the window.
 * - `stop` aborts one thread's turn, as the Stop button does in-process.
 * - `status` asks what became of a dispatch by its operation id, for an app
 *   that lost the answer. A repeated `dispatch` of an id it has seen gets the
 *   same answer and never runs the turn twice.
 * - `approval` asks the window to answer a prompt a host turn raised, and
 *   `approval-answer` carries the user's answer back. A prompt waits for an
 *   answer however long no app is attached, and is asked again of every app
 *   that attaches; `approval-cancel` takes it down once it no longer needs one.
 *
 * Written for any transport: nothing here assumes the two ends share a machine
 * beyond the profile path (`harness-worker-roadmap.md` R2).
 */

export const TURN_HOST_PROTOCOL = 1

export type AppToHost =
  | { t: 'hello'; version: string; protocol: number }
  | { t: 'dispatch'; id: string; projectId: string; threadId: string; payload: string }
  | { t: 'attach' }
  | { t: 'stop'; threadId: string }
  | { t: 'status'; id: string }
  | { t: 'approval-answer'; id: string; response: HostApprovalAnswer }

/** The part of an approval answer that crosses the line. */
export interface HostApprovalAnswer {
  approved: ApprovalResponse['approved']
  remember: ApprovalResponse['remember']
  grantScope?: ApprovalResponse['grantScope'] | undefined
}

/** What became of a dispatch, by its operation id. */
export type DispatchState = 'running' | 'ended' | 'refused' | 'unknown'

export type HostToApp =
  | { t: 'hello'; version: string; protocol: number; pid: number }
  | { t: 'accepted'; id: string; threadId: string }
  | { t: 'refused'; id: string; threadId: string; reason: string }
  | { t: 'ended'; id: string; threadId: string; error?: string | undefined }
  | { t: 'status'; id: string; state: DispatchState }
  | { t: 'chunk'; threadId: string; chunk: StreamChunk; stamp?: TranscriptStamp | undefined }
  | { t: 'snapshot'; snapshot: TranscriptSnapshot }
  | { t: 'approval'; id: string; projectId: string; threadId: string; request: ApprovalRequest }
  | { t: 'approval-cancel'; id: string }

const id = z.string().min(1).max(256)

const appToHostSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), version: z.string().max(128), protocol: z.number().int() }),
  z.object({
    t: z.literal('dispatch'),
    id,
    projectId: id,
    threadId: id,
    // The raw `agent:run` payload; the host parses it as main does.
    payload: z.string(),
  }),
  z.object({ t: z.literal('attach') }),
  z.object({ t: z.literal('stop'), threadId: id }),
  z.object({ t: z.literal('status'), id }),
  z.object({
    t: z.literal('approval-answer'),
    id,
    response: z.object({
      approved: z.boolean(),
      remember: z.boolean(),
      grantScope: z.enum(['once', 'turn-tree']).optional(),
    }),
  }),
])

const objectLike = <T>(): z.ZodType<T> =>
  z.custom<T>((value) => typeof value === 'object' && value !== null)

// Chunks and snapshots come from this user's own host, written by the same
// code that writes them in-process; the envelope is checked, the payload is not.
const hostToAppSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    version: z.string().max(128),
    protocol: z.number().int(),
    pid: z.number().int(),
  }),
  z.object({ t: z.literal('accepted'), id, threadId: id }),
  z.object({ t: z.literal('refused'), id, threadId: id, reason: z.string().max(2_000) }),
  z.object({ t: z.literal('ended'), id, threadId: id, error: z.string().max(4_000).optional() }),
  z.object({
    t: z.literal('status'),
    id,
    state: z.enum(['running', 'ended', 'refused', 'unknown']),
  }),
  z.object({
    t: z.literal('chunk'),
    threadId: id,
    chunk: objectLike<StreamChunk>(),
    stamp: objectLike<TranscriptStamp>().optional(),
  }),
  z.object({ t: z.literal('snapshot'), snapshot: objectLike<TranscriptSnapshot>() }),
  z.object({
    t: z.literal('approval'),
    id,
    projectId: id,
    threadId: id,
    // Raised by the same gate code as an in-process prompt; the fields the
    // window lays out first are checked, the rest pass as the gate wrote them.
    request: z
      .looseObject({
        title: z.string().max(10_000),
        body: z.string().max(1_000_000),
        type: z.enum(['shell', 'mcp', 'web', 'pii', 'review-spend']),
      })
      .transform((request) => request as ApprovalRequest),
  }),
  z.object({ t: z.literal('approval-cancel'), id }),
])

/** The host's socket in this profile. One host serves the whole profile. */
export function turnHostSocketPath(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return localSocketPath(userDataPath, 'turn-host', 'host', platform)
}

export type TurnHostClient = LocalLineClient<HostToApp>
export type TurnHostServer = LocalLineServer<HostToApp>

export function serveTurnHost(
  path: string,
  onMessage: (message: AppToHost, client: TurnHostClient) => void,
  onLeave: () => void,
): Promise<TurnHostServer> {
  return serveLocalLine<AppToHost, HostToApp>(path, appToHostSchema, onMessage, onLeave)
}

export type TurnHostConnection = LocalLineConnection<AppToHost>

/**
 * Connect to the profile's host. Resolves `null` when nothing is listening;
 * `onClose` runs once when a live connection ends.
 */
export function connectTurnHost(
  path: string,
  onMessage: (message: HostToApp) => void,
  onClose: () => void,
): Promise<TurnHostConnection | null> {
  return connectLocalLine<HostToApp, AppToHost>(path, hostToAppSchema, onMessage, onClose)
}
