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
import type { ThreadPromptCommand, ThreadPromptResult } from '@shared/thread-prompt.ts'
import {
  supervisedTaskMetaSchema,
  type SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import type { HostTaskCall, HostTaskCallResult } from './host-task-supervisor.ts'
import type { ApprovalRequest, ApprovalResponse } from '../approval.ts'
import type { QueueEntry } from '../diff-queue.ts'
import type { ProfileStoreChange } from '../turn-worker/read-only-profile-store.ts'
import type { SshPromptRequest, SshPromptResponse } from '../ssh-workspace/ssh-prompt.ts'

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
 * - `approval`, `review-diff` and `ssh-prompt` ask the window to answer a
 *   prompt a host turn raised: an approval, a staged edit for the diff panel,
 *   or an SSH password or host-key question. Each has its own `-answer` back.
 *   A prompt waits however long no app is attached, and is asked again of every
 *   app that attaches; `approval-cancel` takes any of them down once it no
 *   longer needs an answer.
 * - `shell-output` mirrors a host turn's live command output to the window's
 *   terminal pane, as the app's own shell output sink does for its turns.
 * - `instruction-activation` tells the app which nested instruction files a
 *   host turn activated, for Settings → Sources.
 * - `store-write` carries a change a host turn made to a shared profile store
 *   (settings, config) to the app, which owns those files and applies it.
 *   `profile-changed` tells the host the app wrote the profile, so it reads it
 *   again before its next turn starts.
 *
 * - `test-scenario` (e2e builds only) sets, releases, clears or reads a scripted
 *   model scenario in the host, where host turns claim their responses; the
 *   host answers `test-scenario-result`. A release build's host refuses it.
 *
 * Written for any transport: nothing here assumes the two ends share a machine
 * beyond the profile path (`harness-worker-roadmap.md` R2).
 */

export const TURN_HOST_PROTOCOL = 1

export type AppToHost =
  | { t: 'hello'; version: string; protocol: number }
  | { t: 'dispatch'; id: string; projectId: string; threadId: string; payload: string }
  | { t: 'attach' }
  | { t: 'stop'; threadId: string; reason?: 'quit' | undefined }
  | { t: 'status'; id: string }
  | { t: 'approval-answer'; id: string; response: HostApprovalAnswer }
  | { t: 'review-diff-answer'; id: string; approved: boolean }
  | { t: 'ssh-prompt-answer'; id: string; response: SshPromptResponse }
  | { t: 'profile-changed' }
  | { t: 'test-scenario'; id: string; op: TestScenarioOp }
  | { t: 'thread-prompt-answer'; id: string; result: ThreadPromptResult }
  | { t: 'task-call-answer'; id: string; result: HostTaskCallResult }
  | { t: 'task-changed'; task: SupervisedTaskMeta }
  | {
      t: 'process'
      id: string
      op: HostProcessOp
      processId: string
      projectId: string
      threadId: string
    }

/** A scripted model scenario operation, for e2e builds (`mock-script.ts`). */
export type TestScenarioOp =
  | { kind: 'set'; scenarioId: string; scenario: unknown; scope?: string | undefined }
  | { kind: 'release'; scenarioId: string; hold: string }
  | { kind: 'clear' }
  | { kind: 'status'; scenarioId: string }

/** Where a scripted scenario stands (`mockScenarioStatus`). */
export interface TestScenarioStatus {
  complete: boolean
  turn: number
  response: number
  waitingFor: string | null
  cancelledTurns: number
  errors: string[]
}

/** The host's answer to a `test-scenario`: the scenario's status, or why it failed. */
export interface TestScenarioResult {
  status?: TestScenarioStatus | undefined
  error?: string | undefined
}

/** The part of an approval answer that crosses the line. */
export interface HostApprovalAnswer {
  approved: ApprovalResponse['approved']
  remember: ApprovalResponse['remember']
  grantScope?: ApprovalResponse['grantScope'] | undefined
}

/**
 * A host turn's prompt to another thread (\`send_thread_prompt\`, a subthread
 * start): the window submits it, as for an in-process turn (\`thread-prompts.ts\`).
 */
export type HostThreadPromptCommand = Omit<ThreadPromptCommand, 'id' | 'expiresAt'>

/**
 * What the app asks of a host turn's background command: stop it, whether it
 * still runs (at the app's start), or its retained output.
 */
export type HostProcessOp = 'stop' | 'alive' | 'logs'

export interface HostProcessLogs {
  logs: string
  running: boolean
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
  | { t: 'review-diff'; id: string; projectId: string; threadId: string; entry: QueueEntry }
  | {
      t: 'ssh-prompt'
      id: string
      projectId: string
      threadId: string
      request: SshPromptRequest
    }
  | {
      t: 'thread-prompt'
      id: string
      projectId: string
      threadId: string
      command: HostThreadPromptCommand
    }
  | { t: 'task-call'; id: string; projectId: string; threadId: string; call: HostTaskCall }
  | { t: 'taken'; projectId: string; threadId: string }
  | { t: 'process-result'; id: string; ok: boolean; logs?: HostProcessLogs | null | undefined }
  | { t: 'approval-cancel'; id: string }
  | { t: 'store-write'; store: string; changes: ProfileStoreChange[] }
  | { t: 'shell-output'; chunk: string; taskId: string | null }
  | { t: 'instruction-activation'; projectKey: string; threadId: string; names: string[] }
  | ({ t: 'test-scenario-result'; id: string } & TestScenarioResult)

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
  z.object({ t: z.literal('stop'), threadId: id, reason: z.literal('quit').optional() }),
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
  z.object({ t: z.literal('review-diff-answer'), id, approved: z.boolean() }),
  z.object({
    t: z.literal('ssh-prompt-answer'),
    id,
    response: z
      .object({ value: z.string().max(64_000), remember: z.boolean().optional() })
      .transform(({ value, remember }): SshPromptResponse =>
        remember === undefined ? { value } : { value, remember },
      ),
  }),
  z.object({ t: z.literal('profile-changed') }),
  z.object({
    t: z.literal('task-call-answer'),
    id,
    result: z.union([
      z.object({ error: z.string().max(4_000) }),
      z.object({ task: supervisedTaskMetaSchema.nullable() }),
    ]),
  }),
  z.object({ t: z.literal('task-changed'), task: supervisedTaskMetaSchema }),
  z.object({
    t: z.literal('process'),
    id,
    op: z.enum(['stop', 'alive', 'logs']),
    processId: id,
    projectId: id,
    threadId: id,
  }),
  z.object({
    t: z.literal('thread-prompt-answer'),
    id,
    result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), queued: z.boolean() }),
      z.object({ ok: z.literal(false), error: z.string().max(2_000) }),
    ]),
  }),
  z.object({
    t: z.literal('test-scenario'),
    id,
    op: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('set'),
          scenarioId: id,
          scenario: z.unknown(),
          scope: id.optional(),
        })
        .transform(({ scope, ...op }): TestScenarioOp => ({
          ...op,
          ...(scope === undefined ? {} : { scope }),
        })),
      z.object({ kind: z.literal('release'), scenarioId: id, hold: id }),
      z.object({ kind: z.literal('clear') }),
      z.object({ kind: z.literal('status'), scenarioId: id }),
    ]),
  }),
])

const objectLike = <T>(): z.ZodType<T> =>
  z.custom<T>((value) => typeof value === 'object' && value !== null)

/** The fields of a host turn's task call the app reads before its supervisor does. */
const hostTaskCallShape = z.discriminatedUnion('op', [
  z.looseObject({
    op: z.literal('adopt'),
    input: z.looseObject({ projectId: id, threadId: id, handler: id }),
    processHandle: id,
  }),
  z.looseObject({ op: z.literal('complete'), projectId: id, taskId: id }),
  z.looseObject({ op: z.literal('fail'), projectId: id, taskId: id, reason: z.string() }),
  z.looseObject({ op: z.literal('cancel'), projectId: id, taskId: id }),
])

/** The fields of a host turn's thread prompt the app reads before the window does. */
const threadPromptCommandShape = z.looseObject({
  sourceThreadId: id,
  projectId: id,
  text: z.string().max(1_000_000),
  thread: z.looseObject({ id }),
})

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
  z.object({
    t: z.literal('review-diff'),
    id,
    projectId: id,
    threadId: id,
    entry: z
      .object({
        path: z.string().min(1).max(4_096),
        before: z.string(),
        after: z.string(),
        language: z.string().max(128),
        op: z.enum(['write', 'delete', 'rename', 'mkdir']).optional(),
        renameTo: z.string().max(4_096).optional(),
      })
      .transform(({ op, renameTo, ...entry }): QueueEntry => ({
        ...entry,
        ...(op === undefined ? {} : { op }),
        ...(renameTo === undefined ? {} : { renameTo }),
      })),
  }),
  z.object({
    t: z.literal('ssh-prompt'),
    id,
    projectId: id,
    threadId: id,
    request: z
      .object({
        prompt: z.string().max(4_000),
        kind: z.enum(['confirm', 'secret']),
        canRememberOnDevice: z.boolean().optional(),
      })
      .transform(({ canRememberOnDevice, ...request }): SshPromptRequest =>
        canRememberOnDevice === undefined ? request : { ...request, canRememberOnDevice },
      ),
  }),
  z.object({
    t: z.literal('thread-prompt'),
    id,
    projectId: id,
    threadId: id,
    // Built by the same tool code as an in-process prompt; the window checks
    // the destination and the grant again before it submits.
    command: z.custom<HostThreadPromptCommand>(
      (value) => threadPromptCommandShape.safeParse(value).success,
    ),
  }),
  z.object({
    t: z.literal('task-call'),
    id,
    projectId: id,
    threadId: id,
    // Made by the same supervised-command code as an in-process call; the
    // app's supervisor checks the record as it writes it.
    call: z.custom<HostTaskCall>((value) => hostTaskCallShape.safeParse(value).success),
  }),
  z.object({
    t: z.literal('process-result'),
    id,
    ok: z.boolean(),
    logs: z
      .object({ logs: z.string().max(16_000_000), running: z.boolean() })
      .nullable()
      .optional(),
  }),
  z.object({ t: z.literal('taken'), projectId: id, threadId: id }),
  z.object({ t: z.literal('approval-cancel'), id }),
  z.object({
    t: z.literal('shell-output'),
    chunk: z.string().max(4_000_000),
    taskId: id.nullable(),
  }),
  z.object({
    t: z.literal('instruction-activation'),
    projectKey: z.string().min(1).max(4096),
    threadId: z.string().max(256),
    names: z.array(z.string().max(4096)).max(10_000),
  }),
  z
    .object({
      t: z.literal('test-scenario-result'),
      id,
      status: z
        .object({
          complete: z.boolean(),
          turn: z.number().int(),
          response: z.number().int(),
          waitingFor: z.string().max(256).nullable(),
          cancelledTurns: z.number().int(),
          errors: z.array(z.string().max(4_000)).max(64),
        })
        .optional(),
      error: z.string().max(4_000).optional(),
    })
    .transform(({ status, error, ...rest }): Extract<HostToApp, { t: 'test-scenario-result' }> => ({
      ...rest,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
    })),
  z.object({
    t: z.literal('store-write'),
    store: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    changes: z
      .array(
        z.union([
          z.object({ key: z.string().min(1).max(256), deleted: z.literal(true) }),
          z
            .object({ key: z.string().min(1).max(256), value: z.unknown() })
            .transform(({ key, value }): ProfileStoreChange => ({ key, value })),
        ]),
      )
      .max(1_000),
  }),
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
