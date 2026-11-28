import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { requestApproval, runWithApprovalOwner } from '../approval.ts'
import { canAskUser, requestUserAnswers, type AskUserResult } from '../ask-user.ts'
import { reviewRemoteStagedDiff } from '../diff-queue.ts'
import { requestSshPrompt } from '../ssh-workspace/ssh-prompt.ts'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import type { ProfileStoreChange } from '../turn-worker/read-only-profile-store.ts'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import { knownSecrets } from '../classifiers/classifier-service.ts'
import { isPidAlive } from '../exec/subprocess-kill.ts'
import { appInference } from './app-inference.ts'
import { readHostDispatchRecord } from './host-dispatch-record.ts'
import { TurnHostLink, type TurnHostLinkDependencies } from './turn-host-link.ts'
import {
  connectTurnHost,
  turnHostSocketPath,
  type HostApprovalAnswer,
} from './turn-host-protocol.ts'
import { threadDirectoryPath, loadProjectThreadMetas, updateMeta } from '../thread-store.ts'

/**
 * Start the profile's turn host if none answers, and open the app's line to it
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host", H2).
 *
 * The host is the app's own binary run as Node, detached in its own process
 * group so the app's exit does not take it along, logging to
 * `<profile>/logs/turn-host.log`. The app never waits on it: turns run in main
 * until the link reports ready.
 */

type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void; pid?: number | undefined }

export interface TurnHostLaunchDependencies {
  /** The app's executable; run as Node through `ELECTRON_RUN_AS_NODE`. */
  execPath: string
  /** `dist/main/turn-host.js`, next to the main bundle. */
  hostPath: string
  userDataPath: string
  appVersion: string
  packaged: boolean
  env: NodeJS.ProcessEnv
  spawn?: Spawn
  log: (line: string) => void
  onThreadTaken: (projectId: string, threadId: string) => void
  /** Paint a host turn's live command output into the window's terminal pane. */
  onShellOutput?: (chunk: string, taskId: string | null) => void
  onInstructionActivation?: (projectKey: string, threadId: string, names: string[]) => void
  sendThreadPrompt?: TurnHostLinkDependencies['sendThreadPrompt']
  callTaskSupervisor?: TurnHostLinkDependencies['callTaskSupervisor']
  onUnfollowedChunk?: TurnHostLinkDependencies['onUnfollowedChunk']
  /** How long to keep trying to reach a host that is still booting. */
  connectWithinMs?: number
}

/** `turn-host.js` beside the main bundle that imports this module. */
export function turnHostPath(): string {
  return join(__dirname, 'turn-host.js')
}

export function turnHostLogPath(userDataPath: string): string {
  return join(userDataPath, 'logs', 'turn-host.log')
}

function startHost(deps: TurnHostLaunchDependencies): void {
  mkdirSync(join(deps.userDataPath, 'logs'), { recursive: true })
  const log = openSync(turnHostLogPath(deps.userDataPath), 'a', 0o600)
  const child = (deps.spawn ?? spawn)(
    deps.execPath,
    [
      deps.hostPath,
      '--user-data',
      deps.userDataPath,
      '--app-version',
      deps.appVersion,
      ...(deps.packaged ? ['--packaged'] : []),
    ],
    {
      env: { ...deps.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', log, log],
      // Its own process group: the app's exit, or a signal to its group, must
      // not take the host and its turns with it.
      detached: true,
    },
  )
  child.unref()
  deps.log(`[turn-host] started pid ${String(child.pid ?? 'unknown')}`)
}

/** The link to the profile's host, wired to its stores. */
/** Settle a thread left running interrupted, so Continue is the user's call. */
export async function settleInterrupted(projectId: string, threadId: string): Promise<void> {
  const meta = (await loadProjectThreadMetas(projectId)).find((m) => m.id === threadId)
  if (meta?.status !== 'running') return
  await updateMeta(projectId, threadId, { status: 'idle', interruptedTurnAt: Date.now() })
}

export function createTurnHostLink(
  deps: TurnHostLaunchDependencies,
  /** A host elsewhere (an SSH host's worker) replaces how it is reached. */
  elsewhere: Partial<
    Pick<
      TurnHostLinkDependencies,
      | 'connect'
      | 'readRecord'
      | 'isAlive'
      | 'onThreadTaken'
      | 'applyStoreWrite'
      | 'sendThreadPrompt'
      | 'callTaskSupervisor'
      | 'askSsh'
    >
  > & {
    /**
     * Whether the host may act for this thread now (null: for no thread in
     * particular, a model call). Left out, it may for any; an SSH host only
     * for a turn this app sent it.
     */
    admits?: (threadId: string | null, projectId?: string) => boolean
  } = {},
): TurnHostLink {
  const socketPath = turnHostSocketPath(deps.userDataPath)
  const { admits, ...replaced } = elsewhere
  const linkDeps: TurnHostLinkDependencies = {
    version: deps.appVersion,
    connect: (onMessage, onClose) => connectTurnHost(socketPath, onMessage, onClose),
    readRecord: (projectId, threadId) =>
      readHostDispatchRecord(threadDirectoryPath(projectId, threadId)),
    isAlive: isPidAlive,
    settleUncertain: settleInterrupted,
    // Filed under the host turn's thread, so it shows on that thread and on
    // the user's other devices as an in-process turn's prompt does.
    askUser: async ({ projectId, threadId, request }, signal): Promise<HostApprovalAnswer> => {
      const response = await runWithApprovalOwner({ projectId, threadId }, () =>
        requestApproval(request, signal),
      )
      return {
        approved: response.approved,
        remember: response.remember,
        grantScope: response.grantScope,
      }
    },
    // The window's question dialog, filed under the host turn's thread.
    // With no window to ask, or one that closed before an answer, the host
    // keeps the question for the next window rather than taking blanks.
    askQuestions: async (
      { projectId, threadId, request },
      signal,
    ): Promise<AskUserResult | null> => {
      if (!canAskUser()) return null
      const result = await requestUserAnswers({ ...request, projectId, threadId }, signal)
      return result.windowClosed ? null : result
    },
    // The thread's diff panel shows it; deciding there answers the host.
    reviewDiff: ({ projectId, threadId, entry }, signal) =>
      reviewRemoteStagedDiff({ projectId, threadId }, entry, signal),
    // The window's own SSH dialog. It has no cancel, so a host that stops
    // waiting leaves it to be dismissed; the answer is then dropped.
    askSsh: ({ request }) => requestSshPrompt(request),
    applyStoreWrite: ({ store, changes }): void => {
      applyHostStoreWrite(store, changes, deps.log)
    },
    onThreadTaken: deps.onThreadTaken,
    // Only a worker without keys asks; the profile's own host has them.
    infer: appInference,
    redact: (text) => redactSecrets(text, knownSecrets()),
    ...(deps.onShellOutput ? { onShellOutput: deps.onShellOutput } : {}),
    ...(deps.onInstructionActivation
      ? { onInstructionActivation: deps.onInstructionActivation }
      : {}),
    ...(deps.sendThreadPrompt ? { sendThreadPrompt: deps.sendThreadPrompt } : {}),
    ...(deps.callTaskSupervisor ? { callTaskSupervisor: deps.callTaskSupervisor } : {}),
    ...(deps.onUnfollowedChunk ? { onUnfollowedChunk: deps.onUnfollowedChunk } : {}),
    log: deps.log,
    ...replaced,
  }
  return new TurnHostLink(admits === undefined ? linkDeps : admitted(linkDeps, admits))
}

const refused = (): Error => new Error('This host has no turn of that thread from this app.')

/** A link's handlers that act only for threads `admits` lets the host act for. */
function admitted(
  deps: TurnHostLinkDependencies,
  admits: (threadId: string | null, projectId?: string) => boolean,
): TurnHostLinkDependencies {
  const { askUser, askQuestions, reviewDiff, infer, onUnfollowedChunk, onInstructionActivation } =
    deps
  const gated: TurnHostLinkDependencies = {
    ...deps,
    ...(askUser && {
      askUser: (prompt, signal) =>
        admits(prompt.threadId, prompt.projectId)
          ? askUser(prompt, signal)
          : Promise.reject(refused()),
    }),
    ...(askQuestions && {
      askQuestions: (prompt, signal) =>
        admits(prompt.threadId, prompt.projectId)
          ? askQuestions(prompt, signal)
          : Promise.resolve(null),
    }),
    ...(reviewDiff && {
      reviewDiff: (prompt, signal) =>
        admits(prompt.threadId, prompt.projectId)
          ? reviewDiff(prompt, signal)
          : Promise.resolve(false),
    }),
    ...(infer && {
      infer: (request, signal): AsyncIterable<ProviderStreamChunk> => {
        if (!admits(null)) throw refused()
        return infer(request, signal)
      },
    }),
    ...(onUnfollowedChunk && {
      onUnfollowedChunk: (message): void => {
        if (admits(message.threadId)) onUnfollowedChunk(message)
      },
    }),
    ...(onInstructionActivation && {
      onInstructionActivation: (projectKey, threadId, names): void => {
        if (admits(threadId)) onInstructionActivation(projectKey, threadId, names)
      },
    }),
  }
  // Output for the app's own task pane: a host's processes stay there.
  delete gated.onShellOutput
  return gated
}

/**
 * Reach the profile's host, starting one if nothing answers, and keep trying
 * while it boots. Resolves whether a host of this app's version is on the line.
 * A host of another version is left to retire: it was told this app's version
 * in `hello`, finishes its turns and exits, and the next launch starts one.
 */
export async function connectOrStartTurnHost(
  link: TurnHostLink,
  deps: TurnHostLaunchDependencies,
): Promise<boolean> {
  if (await link.ensureConnected()) return true
  startHost(deps)
  const deadline = Date.now() + (deps.connectWithinMs ?? 60_000)
  while (Date.now() < deadline) {
    await delay(250)
    if (await link.ensureConnected()) return true
  }
  deps.log('[turn-host] the host did not answer; turns run in the app')
  return false
}

/**
 * Save a host turn's change to a shared store as the app's own write would be
 * (decision 5). Settings go through their schemas. Keys are never written from
 * here: a host only ever reads them, so a key change from one is refused, as is
 * any store the app does not keep for it.
 */
export function applyHostStoreWrite(
  store: string,
  changes: readonly ProfileStoreChange[],
  log: (line: string) => void,
): void {
  for (const change of changes) {
    if (change.key === 'apiKey' || change.key.startsWith('apiKey.')) {
      log(`[turn-host] refused a host write to ${store}.json "${change.key}"`)
      continue
    }
    const deleted = 'deleted' in change
    if (store === 'config') {
      if (deleted) storageDelete(change.key)
      else storageSet(change.key, change.value)
    } else if (store === 'settings') {
      const saved = deleted ? deleteSetting(change.key) : setSetting(change.key, change.value)
      saved.catch((error: unknown) => {
        log(`[turn-host] could not save setting "${change.key}": ${String(error)}`)
      })
    } else {
      log(`[turn-host] kept no host write to ${store}.json "${change.key}"`)
    }
  }
}
