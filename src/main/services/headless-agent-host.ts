import { randomUUID } from 'node:crypto'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import type { LLMMessage, LLMProvider, StreamChunk, UserContent } from '@shared/types'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
import { runAgent, abortAgent } from './agent-service.ts'
import { AgentDispatcher } from './agent-dispatcher.ts'
import { appendMachineContinuation } from './thread-store.ts'
import { createRegistry, registerSkillTools } from './registry-bootstrap.ts'
import { runWithExplicitSettings } from './storage/settings-context.ts'
import { runWithWorkspaceRoot, canonicalWorkspaceRoot } from './workspace.ts'
import { localWorkspaceFs } from './workspace-fs/local-workspace-fs.ts'
import { runWithDiscoveredSkills, listSkills } from './skills/skills-registry.ts'
import { runWithToolAvailability, type ExplicitToolAvailability } from './tool-availability.ts'
import { loadMcpServers } from './mcp/mcp-registry.ts'
import { runWithWorkspaceTrust } from './security/workspace-trust.ts'
import { runWithApprovalHandler, type ApprovalHandler, type ApprovalResponse } from './approval.ts'
import { runWithAskUserHandler, type AskUserHandler, type AskUserResult } from './ask-user.ts'
import {
  runWithSshPromptHandler,
  type SshPromptHandler,
  type SshPromptResponse,
} from './ssh-workspace/ssh-prompt.ts'
import { runWithStagedDiffResolver, type StagedDiffResolver } from './diff-queue.ts'
import {
  backgroundCompletionPrompt,
  runWithBackgroundCompletionWakeHandler,
} from './exec/background-completion-wake.ts'
import {
  runWithBackgroundProcessSupervisor,
  stopSupervisedBackgroundProcessesForThread,
} from './exec/supervised-background-process.ts'
import { getTaskSupervisor, type TaskSupervisor } from './supervisor/task-supervisor.ts'

export interface HeadlessInteractionProfile {
  readonly approve?: ApprovalHandler
  readonly askUser?: AskUserHandler
  readonly sshPrompt?: SshPromptHandler
  readonly stagedDiff?: StagedDiffResolver
}

export interface HeadlessAgentProfile {
  /** Trusted local workspace the product file/shell tools are confined to. */
  readonly workspaceRoot: string
  /** Product model selection passed through the ordinary provider resolver. */
  readonly model: string
  /** User-visible settings for this run; absent keys use product defaults, never persisted values. */
  readonly settings: Readonly<Record<string, unknown>>
  /** Provider credentials for this run; no persisted or environment keys are inherited. */
  readonly apiKeys?: Readonly<Record<string, string>>
  /** Exact first-party plugins enabled for this run. */
  readonly enabledPluginIds: readonly string[]
  /** Optional plugin-scoped settings, keyed by plugin id then manifest setting id. */
  readonly pluginSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Deterministic executable availability supplied by the host environment. */
  readonly toolAvailability: ExplicitToolAvailability
  /** Whether to discover/connect the product's configured MCP servers. */
  readonly loadMcpServers: boolean
  /** Explicit trust posture used by MCP, hooks, shell routing, and permission policy. */
  readonly workspaceTrusted: boolean
  /** Host interaction channels; omitted channels resolve deterministically without ambient UI. */
  readonly interaction?: HeadlessInteractionProfile
  /** Optional product-loop tighteners used by benchmark profiles. */
  readonly limits?: { readonly maxSteps?: number; readonly maxLlmCalls?: number }
}

export interface HeadlessAgentRun {
  readonly prompt: UserContent
  readonly priorMessages?: readonly LLMMessage[]
  readonly invokedSkills?: readonly string[]
  readonly threadId?: string
  readonly projectId?: string
  readonly signal?: AbortSignal
  readonly onChunk?: (chunk: StreamChunk) => void
  /** Wait for this many production completion wakes before returning. */
  readonly waitForMachineContinuations?: {
    readonly count: number
    readonly timeoutMs: number
  }
}

export interface HeadlessAgentDependencies {
  /** Deterministic provider seam for tests; ordinary hosts omit it and use product resolution. */
  readonly provider?: LLMProvider
  /** Context window paired with an injected provider. */
  readonly contextWindow?: number
  /** Supervisor seam for isolated hosts and tests; desktop/headless production uses the singleton. */
  readonly taskSupervisor?: TaskSupervisor
}

export interface HeadlessAgentResult {
  readonly threadId: string
  readonly chunks: readonly StreamChunk[]
  readonly messages: readonly LLMMessage[]
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  /** Effective product construction, exposed for profile-resolution/hash tests. */
  readonly toolNames: readonly string[]
  readonly skillNames: readonly string[]
}

function runWithHeadlessInteractions<T>(
  interaction: HeadlessInteractionProfile | undefined,
  fn: () => T,
): T {
  const approve: ApprovalHandler =
    interaction?.approve ??
    ((): Promise<ApprovalResponse> => Promise.resolve({ approved: false, remember: false }))
  const askUser: AskUserHandler =
    interaction?.askUser ??
    ((request): Promise<AskUserResult> =>
      Promise.resolve({ answers: request.questions.map(() => '') }))
  const sshPrompt: SshPromptHandler =
    interaction?.sshPrompt ?? ((): Promise<SshPromptResponse> => Promise.resolve({ value: '' }))
  const stagedDiff: StagedDiffResolver =
    interaction?.stagedDiff ?? ((): Promise<boolean> => Promise.resolve(false))
  return runWithApprovalHandler(approve, () =>
    runWithAskUserHandler(askUser, () =>
      runWithSshPromptHandler(sshPrompt, () => runWithStagedDiffResolver(stagedDiff, fn)),
    ),
  )
}

/**
 * Run the product's complete local agent surface from an explicit profile.
 *
 * This is bootstrap only: provider/prompt/tool/permission/loop behavior stays in
 * `runAgent`, the same orchestrator the Electron renderer drives. Async-local
 * scopes keep concurrent headless runs isolated without replacing desktop state.
 */
export async function runHeadlessAgent(
  profile: HeadlessAgentProfile,
  run: HeadlessAgentRun,
  dependencies: HeadlessAgentDependencies = {},
): Promise<HeadlessAgentResult> {
  const workspaceRoot = await canonicalWorkspaceRoot(profile.workspaceRoot, localWorkspaceFs)
  const threadId = nonEmptyStringOr(run.threadId, `headless-${randomUUID()}`)
  const projectId = nonEmptyStringOr(run.projectId, `headless-project-${randomUUID()}`)
  const enabledPluginIds = new Set(profile.enabledPluginIds)
  const pluginRegistry = createFirstPartyPluginRegistry()

  for (const plugin of pluginRegistry.all()) {
    if (!enabledPluginIds.has(plugin.id)) pluginRegistry.disable(plugin.id)
  }
  for (const id of enabledPluginIds) {
    if (!pluginRegistry.has(id)) throw new Error(`Unknown enabled plugin: ${id}`)
  }
  for (const [pluginId, values] of Object.entries(profile.pluginSettings ?? {})) {
    if (!pluginRegistry.has(pluginId)) throw new Error(`Unknown plugin settings owner: ${pluginId}`)
    const storage = pluginRegistry.storage(pluginId)
    for (const [key, value] of Object.entries(values)) storage.set(key, value)
  }

  return runWithBackgroundProcessSupervisor(
    dependencies.taskSupervisor ?? getTaskSupervisor(),
    () =>
      runWithExplicitSettings(
        { values: profile.settings, ...(profile.apiKeys ? { apiKeys: profile.apiKeys } : {}) },
        () =>
          runWithWorkspaceRoot(workspaceRoot, () =>
            runWithWorkspaceTrust(workspaceRoot, profile.workspaceTrusted, () =>
              runWithDefaultPluginRegistry(pluginRegistry, () =>
                runWithToolAvailability(profile.toolAvailability, () =>
                  runWithHeadlessInteractions(profile.interaction, () =>
                    runWithDiscoveredSkills(async () => {
                      const registry = createRegistry()
                      registerSkillTools(registry)
                      if (profile.loadMcpServers) await loadMcpServers(registry)

                      const chunks: StreamChunk[] = []
                      const host: AgentHost<StreamChunk> = {
                        emit: (_emittingThreadId, chunk) => {
                          chunks.push(chunk)
                          run.onChunk?.(chunk)
                        },
                      }
                      const onAbort = (): void => {
                        abortAgent(threadId)
                      }
                      run.signal?.addEventListener('abort', onAbort, { once: true })

                      try {
                        const turnTreeId = randomUUID()
                        const executionContext = {
                          projectId,
                          threadId,
                          projectRoot: workspaceRoot,
                          root: workspaceRoot,
                          checkoutMode: 'shared' as const,
                          branch: null,
                        }
                        let messages: LLMMessage[] = [...(run.priorMessages ?? [])]
                        let inputTokens = 0
                        let outputTokens = 0
                        const dispatcher = new AgentDispatcher(host, registry, {
                          loadHistory: (): Promise<LLMMessage[]> => Promise.resolve(messages),
                          saveHistory: (_projectId, _threadId, nextMessages): Promise<void> => {
                            messages = nextMessages
                            return Promise.resolve()
                          },
                          // Headless runs carry their history in `messages`
                          // above rather than a thread transcript, so there is
                          // no second source to recover an empty one from.
                          recoverHistory: (): Promise<LLMMessage[]> => Promise.resolve([]),
                          loadEpoch: (): Promise<null> => Promise.resolve(null),
                          saveEpoch: (): Promise<void> => Promise.resolve(),
                          appendMachineContinuation,
                          now: Date.now,
                          createId: randomUUID,
                          prepareExecutionContext: (): Promise<typeof executionContext> =>
                            Promise.resolve(executionContext),
                          run: async (
                            dispatchThreadId,
                            userContent,
                            priorMessages,
                            dispatchHost,
                            dispatchRegistry,
                            options,
                          ): Promise<Awaited<ReturnType<typeof runAgent>>> => {
                            const result = await runAgent(
                              dispatchThreadId,
                              userContent,
                              priorMessages,
                              dispatchHost,
                              dispatchRegistry,
                              {
                                ...options,
                                model: profile.model,
                                resolvePluginSetting: (pluginId, key) =>
                                  pluginRegistry.has(pluginId)
                                    ? pluginRegistry.storage(pluginId).get(key)
                                    : undefined,
                                ...(dependencies.provider
                                  ? { provider: dependencies.provider }
                                  : {}),
                                ...(dependencies.contextWindow !== undefined
                                  ? { contextWindow: dependencies.contextWindow }
                                  : {}),
                                ...(profile.limits?.maxSteps !== undefined
                                  ? { maxSteps: profile.limits.maxSteps }
                                  : {}),
                                ...(profile.limits?.maxLlmCalls !== undefined
                                  ? { maxLlmCalls: profile.limits.maxLlmCalls }
                                  : {}),
                              },
                            )
                            inputTokens += result.usage.inputTokens
                            outputTokens += result.usage.outputTokens
                            return result
                          },
                        })
                        const wait = run.waitForMachineContinuations
                        let machineContinuations = 0
                        let resolveMachineWait: (() => void) | null = null
                        const machineWait = wait
                          ? new Promise<void>((resolve) => {
                              resolveMachineWait = resolve
                            })
                          : null
                        const dispatchAndWait = async (): Promise<void> => {
                          await dispatcher.dispatch({
                            projectId,
                            threadId,
                            payload: {
                              userContent: run.prompt,
                              invokedSkills: [...(run.invokedSkills ?? [])],
                              priorTodos: [],
                              turnTreeId,
                            },
                          })
                          if (wait && machineWait) {
                            let timer: ReturnType<typeof setTimeout> | undefined
                            try {
                              await Promise.race([
                                machineWait,
                                new Promise<never>((_resolve, reject) => {
                                  timer = setTimeout(() => {
                                    reject(
                                      new Error(
                                        `Timed out waiting for ${String(wait.count)} machine continuations`,
                                      ),
                                    )
                                  }, wait.timeoutMs)
                                }),
                              ])
                            } finally {
                              if (timer) clearTimeout(timer)
                            }
                          }
                        }
                        if (wait) {
                          await runWithBackgroundCompletionWakeHandler(async (completion) => {
                            const result = await dispatcher.dispatchMachine({
                              projectId: completion.owner.projectId,
                              threadId: completion.owner.threadId,
                              operationId: completion.operationId,
                              turnTreeId: completion.turnTreeId,
                              payload: {
                                userContent: backgroundCompletionPrompt(completion),
                                invokedSkills: [],
                                priorTodos: [],
                              },
                            })
                            if (result === 'completed') {
                              machineContinuations += 1
                              if (machineContinuations >= wait.count) {
                                resolveMachineWait?.()
                              }
                            }
                            return result
                          }, dispatchAndWait)
                        } else {
                          await dispatchAndWait()
                        }
                        return {
                          threadId,
                          chunks,
                          messages,
                          usage: { inputTokens, outputTokens },
                          toolNames: registry.names(),
                          skillNames: listSkills().map((skill) => skill.name),
                        }
                      } finally {
                        if (run.waitForMachineContinuations) {
                          await stopSupervisedBackgroundProcessesForThread({
                            projectId,
                            threadId,
                          })
                        }
                        run.signal?.removeEventListener('abort', onAbort)
                      }
                    }),
                  ),
                ),
              ),
            ),
          ),
      ),
  )
}
