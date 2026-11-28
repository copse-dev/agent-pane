import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { TurnHostLinkDependencies } from './turn-host-link.ts'
import type { HostApprovalAnswer, HostInferRequest } from './turn-host-protocol.ts'

const refused = (): Error => new Error('This host has no turn of that thread from this app.')

/** What a host on another machine may act for. */
export interface HostAdmission {
  /** Whether it may ask, show or write for this thread now. */
  thread: (threadId: string, projectId?: string) => boolean
  /** Why this model call is not made for it, or null when it is. */
  call: (request: HostInferRequest) => string | null
}

/** A link's handlers that act only for what `admission` lets the host act for. */
export function admitted(
  deps: TurnHostLinkDependencies,
  admission: HostAdmission,
): TurnHostLinkDependencies {
  const admits = admission.thread
  const { askUser, askQuestions, reviewDiff, infer, onUnfollowedChunk, onInstructionActivation } =
    deps
  const gated: TurnHostLinkDependencies = {
    ...deps,
    ...(askUser && {
      askUser: (prompt, signal): Promise<HostApprovalAnswer> => {
        if (!admits(prompt.threadId, prompt.projectId)) return Promise.reject(refused())
        // What the dialog only shows, not what it acts on here: trusting a
        // folder, or bookkeeping for this computer's own tool calls, is never
        // the other machine's to name.
        const request = { ...prompt.request }
        delete request.workspaceTrustOffer
        delete request.toolCallId
        delete request.bridgeExecutionId
        return askUser({ ...prompt, request }, signal)
      },
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
        const refusal = admission.call(request)
        if (refusal !== null) throw new Error(refusal)
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
