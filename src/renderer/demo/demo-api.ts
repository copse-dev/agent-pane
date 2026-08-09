import type { StreamChunk, Thread } from '@shared/types'
import type { PackContributionsSummary, PackSummary } from '@shared/types/packs.ts'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import { workingBriefFromUserContent } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { DemoScenario } from './scenarios.ts'
import { playTrace, type TracePlayerOptions } from './trace-player.ts'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { detectLanguage } from '../controller/files.ts'
import { isRecord } from '@shared/unknown-value.ts'

const DEMO_MODEL = 'mock:demo'
const DEMO_TIME = '2026-07-17T09:00:00.000Z'

/**
 * Packs shown in the browser demo's Settings → Packs list. The real list comes
 * from the host registry, which the demo has no access to, so a small stand-in
 * covers the shapes the row has to render: a first-party pack, one that is
 * experimental and carries a setting, and a user-installed one that is off.
 */
const DEMO_PACK_CONTRIBUTIONS: PackContributionsSummary = {
  toolNames: [],
  modelRoutes: [],
  browserOrigins: [],
  blockingHooks: [],
  asyncHooks: [],
  commandHooks: [],
  promptBlocks: [],
  ui: [],
  capabilities: [],
  permissions: [],
}

const DEMO_PACKS: readonly PackSummary[] = [
  {
    id: 'copse.todos',
    trust: 'first-party',
    stability: 'stable',
    name: 'Todos',
    version: '1.0.0',
    description:
      'Plan and track multi-step work inside a thread. Adds the todo tool, the plan panel, and the prompt block that teaches the agent when to keep a list.',
    enabled: true,
    contributions: { ...DEMO_PACK_CONTRIBUTIONS, toolNames: ['todo_write', 'todo_read'] },
    settings: [],
  },
  {
    id: 'copse.advisor-strategy',
    trust: 'first-party',
    stability: 'experimental',
    name: 'Advisor strategy',
    version: '0.3.1',
    description:
      'Pairs a second model with the executor to review strategy before long or risky work starts.',
    enabled: true,
    contributions: { ...DEMO_PACK_CONTRIBUTIONS, toolNames: ['consult_advisor'] },
    settings: [
      {
        id: 'maxReviewCycles',
        kind: 'number',
        title: 'Max review cycles',
        description: 'How many times a failing review may buy the agent another turn.',
        default: 2,
        value: 2,
      },
    ],
  },
  {
    id: 'personal.reference-tools',
    trust: 'user',
    stability: 'experimental',
    name: 'Reference tools',
    version: '0.1.0',
    description: 'A locally installed pack from a selected directory.',
    enabled: false,
    contributions: DEMO_PACK_CONTRIBUTIONS,
    settings: [],
  },
]

/**
 * Provider slug for a model id, matching the conventions used elsewhere:
 * `<slug>:<model>` carries its slug, and built-in cloud ids are inferred from
 * their prefix.
 */
function providerSlug(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const colon = model.indexOf(':')
  if (colon > 0) return model.slice(0, colon)
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt')) return 'openai'
  return undefined
}

export interface DemoApiOptions {
  /** Playback tuning for a scenario's recorded trace (see `trace-player.ts`). */
  trace?: TracePlayerOptions
}

type ShowDiffHandler = (
  projectId: string,
  threadId: string,
  path: string,
  before: string,
  after: string,
  lang: string,
) => void

type QueuedHandler = (
  projectId: string,
  threadId: string,
  entries: { path: string; language: string }[],
) => void

/**
 * A string tool argument. Unlike the display helper in `tools/tool-display.ts`
 * this keeps the empty string: `str_replace` with an empty `new_string` is a
 * deletion, and `write_file` with empty `content` truncates a file.
 */
function stringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) return undefined
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The file a replayed tool call proposes to change, and what it would look like
 * afterwards — `undefined` for any tool that does not edit a file.
 *
 * `written` is what the turn has already written, so a second edit to the same
 * file diffs against the first rather than against an empty buffer. The real
 * `write_file` reads the previous content off disk for exactly this reason
 * (`main/tools/write-file-tool.ts`); the demo has no disk, so the turn's own
 * writes are the only history there is.
 */
function proposedEdit(
  name: string,
  args: unknown,
  written: ReadonlyMap<string, string>,
): { path: string; before: string; after: string } | undefined {
  const path = stringArg(args, 'path')
  if (path === undefined) return undefined
  const before = written.get(path) ?? ''
  if (name === 'write_file') {
    const content = stringArg(args, 'content')
    return content === undefined ? undefined : { path, before, after: content }
  }
  if (name === 'str_replace') {
    const oldString = stringArg(args, 'old_string')
    const newString = stringArg(args, 'new_string')
    if (oldString === undefined || newString === undefined) return undefined
    return { path, before, after: before.replace(oldString, newString) }
  }
  return undefined
}

function resolvedVoid(): Promise<void> {
  return Promise.resolve()
}

const emptyArray = (): Promise<never[]> => Promise.resolve([])

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value)
}

function subscribe(_handler: unknown): () => void {
  return (): void => undefined
}

function unsupported(): Promise<never> {
  return Promise.reject(new Error('This operation is not available in the browser demo.'))
}

export function createDemoApi(scenario: DemoScenario, options: DemoApiOptions = {}): ApiClient {
  const settings = new Map(Object.entries(scenario.settings))
  const storage = new Map<string, unknown>([
    ['projects', [scenario.project]],
    ['activeProjectId', scenario.project.id],
  ])
  let workspaceRoot = scenario.project.path
  let threads: Thread[] = structuredClone(scenario.threads)
  let currentBranch = threads[0]?.gitBranch ?? 'demo/browser-renderer'
  const chunkHandlers = new Set<(threadId: string, chunk: StreamChunk) => void>()
  const showDiffHandlers = new Set<ShowDiffHandler>()
  const queuedHandlers = new Set<QueuedHandler>()
  /** Files the replayed turn has written, oldest first — the demo's whole disk. */
  const writtenFiles = new Map<string, string>()
  /** Original homes for controls moved into an expanded pane's toolbar. */
  const expandedPaneButtons = new Map<
    string,
    { button: HTMLButtonElement; parent: HTMLElement; nextSibling: ChildNode | null }
  >()

  const emitChunk = (threadId: string, chunk: StreamChunk): void => {
    for (const handler of chunkHandlers) handler(threadId, chunk)
  }

  /**
   * Push a replayed file edit down the same path the main process uses for a
   * real one: queue the diff, then hand over its content. `agent.ts` opens the
   * Changes panel on that second event and `git-changes-pane.ts` jumps to the
   * file, so a trace that edits something shows the diff without the demo
   * touching the panel itself.
   */
  const emitProposedDiff = (threadId: string, chunk: StreamChunk): void => {
    if (chunk.type !== 'tool_call') return
    const edit = proposedEdit(chunk.toolCall.name, chunk.toolCall.args, writtenFiles)
    if (!edit) return
    writtenFiles.set(edit.path, edit.after)
    const language = detectLanguage(edit.path)
    // The queue is the full set of pending diffs, not just the newest: the
    // Changes pane drops a selection whose path has left the queue.
    const entries = [...writtenFiles.keys()].map((path) => ({
      path,
      language: detectLanguage(path),
    }))
    for (const handler of queuedHandlers) handler(scenario.project.id, threadId, entries)
    for (const handler of showDiffHandlers) {
      handler(scenario.project.id, threadId, edit.path, edit.before, edit.after, language)
    }
  }

  // One in-flight replay at a time, cancellable through `agent.abort` (the Stop
  // button) exactly like a real run.
  let replay: AbortController | undefined
  const scenarioModel = scenario.settings['model']
  const scenarioProvider = providerSlug(
    typeof scenarioModel === 'string' ? scenarioModel : undefined,
  )

  const api: ApiClient = {
    workspace: {
      open: () => resolved(workspaceRoot),
      get: () => resolved(workspaceRoot),
      set: (root: string) => {
        workspaceRoot = root
        return resolved(root)
      },
      isTrusted: () => resolved(true),
      setTrusted: emptyArray,
      unsandboxedProjectHooks: emptyArray,
      // The demo bundle is browser-targeted (no `node:path`), and demo paths are
      // display-only POSIX strings, so join by hand rather than importing path.
      createNewProject: (name: string, parentDir: string) =>
        resolved(`${parentDir.replace(/\/+$/, '')}/${name}`),
      pickParentDirectory: () => resolved(null),
      getHomeDirectory: () => resolved(''),
      onOpened: subscribe,
    },
    browser: {
      onOpenTab: subscribe,
      sharePageText: unsupported,
      shareScreenshot: unsupported,
      onShareText: subscribe,
      onShareImage: subscribe,
      onPackTabRequest: subscribe,
    },
    security: {
      getGuardedYolo: (threadId) =>
        resolved({ threadId, phase: 'off', containment: 'unsandboxed', expiresAt: null }),
      enableGuardedYolo: (threadId) =>
        resolved({ threadId, phase: 'off', containment: 'unsandboxed', expiresAt: null }),
      disableGuardedYolo: (threadId) =>
        resolved({ threadId, phase: 'off', containment: 'unsandboxed', expiresAt: null }),
      onGuardedYoloChanged: subscribe,
    },
    fs: {
      readFile: (_projectId: string, _threadId: string, path: string) =>
        resolved(writtenFiles.get(path) ?? ''),
      writeFile: resolvedVoid,
      readdir: () => resolved(['src', 'tests', 'package.json']),
      listDir: () =>
        resolved([
          { name: 'src', isDir: true },
          { name: 'tests', isDir: true },
          { name: 'package.json', isDir: false },
        ]),
      watch: resolvedVoid,
      unwatch: resolvedVoid,
      onChanged: subscribe,
    },
    agent: {
      run: (_projectId: string, threadId: string, payload: string) => {
        const { userContent } = parseAgentRunPayload(payload)
        const prompt = workingBriefFromUserContent(userContent) ?? 'image prompt'
        // A scenario's recorded trace answers the prompt it was recorded for.
        // Anything else a visitor types is off-script, and gets the stub reply
        // rather than an answer to a question they did not ask.
        const trace = scenario.trace
        if (trace && prompt.trim() === trace.prompt.trim()) {
          replay?.abort()
          const controller = new AbortController()
          replay = controller
          const emit = (chunk: StreamChunk): void => {
            emitChunk(threadId, chunk)
            emitProposedDiff(threadId, chunk)
          }
          void playTrace(trace, emit, {
            ...options.trace,
            signal: controller.signal,
          })
          return resolvedVoid()
        }
        emitChunk(threadId, {
          type: 'text',
          text: `Demo response to: ${prompt}\n\nThis response is streamed through the real renderer event path.`,
        })
        emitChunk(threadId, {
          type: 'usage',
          model: DEMO_MODEL,
          inputTokens: Math.max(1, Math.ceil(prompt.length / CHARS_PER_TOKEN)),
          outputTokens: 18,
          estimated: true,
        })
        emitChunk(threadId, { type: 'done', stopReason: 'end_turn' })
        return resolvedVoid()
      },
      describeImages: () => resolved({ text: 'Demo image description.' }),
      // The first message on a blank thread commits a checkout decision before
      // it dispatches, so these cannot stay `unsupported` — rejecting here puts
      // a retry error where the demo's answer should be. Nothing is checked out
      // in a browser; the demo always stays on the shared branch.
      prepareCheckout: (_projectId: string, _threadId: string, _prompt: string, choice) =>
        resolved({ checkoutMode: 'shared' as const, choice, branch: currentBranch }),
      previewCheckout: () => resolved({ checkoutMode: 'shared' as const }),
      estimateContext: (_projectId: string, _threadId: string, payload: string) =>
        resolved({
          segments: [
            {
              key: 'message',
              label: 'Your message',
              tokens: Math.ceil(payload.length / CHARS_PER_TOKEN),
            },
          ],
          totalTokens: Math.ceil(payload.length / CHARS_PER_TOKEN),
          contextWindow: 200_000,
        }),
      abort: () => {
        replay?.abort()
        return resolvedVoid()
      },
      runningThreadIds: emptyArray,
      retryReview: resolvedVoid,
      retryComparison: resolvedVoid,
      clearHistory: resolvedVoid,
      refreshModelContext: resolvedVoid,
      suggestTitle: () => resolved(null),
      suggestTerminalTitle: () => resolved(null),
      suggestCommandSummary: () => resolved(null),
      suggestToolTurnSummary: () => resolved(null),
      suggestFollowUps: emptyArray,
      onChunk: (handler: (threadId: string, chunk: StreamChunk) => void) => {
        chunkHandlers.add(handler)
        return (): void => {
          chunkHandlers.delete(handler)
        }
      },
      onApprovalRequest: subscribe,
      onApprovalCancelled: subscribe,
      onAskUserRequest: subscribe,
      onShellOutput: subscribe,
      onRefreshContextEstimate: subscribe,
      onHookQueueMessage: subscribe,
    },
    diff: {
      approve: resolvedVoid,
      reject: resolvedVoid,
      approveAll: resolvedVoid,
      rejectAll: resolvedVoid,
      content: () => resolved(null),
      onShowDiff: (handler: ShowDiffHandler) => {
        showDiffHandlers.add(handler)
        return (): void => {
          showDiffHandlers.delete(handler)
        }
      },
      onQueued: (handler: QueuedHandler) => {
        queuedHandlers.add(handler)
        return (): void => {
          queuedHandlers.delete(handler)
        }
      },
      onConflict: subscribe,
    },
    approval: { respond: resolvedVoid },
    ask: { respond: resolvedVoid },
    alerts: { threadFinished: resolvedVoid },
    sshPrompt: {
      respond: resolvedVoid,
      onRequest: subscribe,
    },
    updatePrompt: {
      respond: resolvedVoid,
      onRequest: subscribe,
      onDevNotice: subscribe,
    },
    closeConfirm: {
      respond: resolvedVoid,
      onRequest: subscribe,
    },
    sshWorkspace: {
      listHosts: emptyArray,
      listConfigAliases: emptyArray,
      getStates: emptyArray,
      connect: emptyArray,
      disconnect: emptyArray,
      reconnect: emptyArray,
      listDirectory: emptyArray,
      registerRoot: () => resolved('/demo'),
      onConnectionChanged: subscribe,
    },
    mcp: {
      list: emptyArray,
      reload: emptyArray,
      setEnabled: emptyArray,
      listCurated: emptyArray,
      setCuratedEnabled: emptyArray,
      onStatusChanged: subscribe,
    },
    canvas: { onArtefact: subscribe },
    storage: {
      get: (key: string) => resolved(storage.get(key)),
      set: (key: string, value: unknown) => {
        storage.set(key, value)
        return resolvedVoid()
      },
    },
    // The browser demo has no chat store on disk to hold an archive.
    archive: { attach: unsupported },
    threads: {
      loadProject: (projectId: string) =>
        resolved(projectId === scenario.project.id ? structuredClone(threads) : []),
      create: (_projectId: string, thread: Thread) => {
        threads = [thread, ...threads.filter((candidate) => candidate.id !== thread.id)]
        return resolvedVoid()
      },
      appendMessage: (
        _projectId: string,
        threadId: string,
        message: Thread['messages'][number],
      ) => {
        const thread = threads.find((candidate) => candidate.id === threadId)
        if (thread && !thread.messages.some((candidate) => candidate.id === message.id)) {
          thread.messages.push(message)
        }
        return resolvedVoid()
      },
      updateMeta: (
        _projectId: string,
        threadId: string,
        patch: Partial<Omit<Thread, 'messages'>>,
      ) => {
        const thread = threads.find((candidate) => candidate.id === threadId)
        if (thread) Object.assign(thread, patch)
        return resolvedVoid()
      },
      delete: (_projectId: string, threadId: string) => {
        threads = threads.filter((candidate) => candidate.id !== threadId)
        return resolvedVoid()
      },
      // The browser demo has no chat store on disk to zip up.
      exportArchive: unsupported,
      // The demo has no provider history sidecar to inherit; the forked thread's
      // transcript copy (which the renderer owns) is the whole demo story.
      fork: () => resolved({ source: 'empty' as const, messageCount: 0 }),
      catalog: emptyArray,
      listOrphans: emptyArray,
    },
    openRouter: { models: emptyArray },
    models: {
      bestValueDefault: () => resolved('lmstudio:qwen/qwen3.6-35b-a3b'),
      resolveDynamic: (value: string) =>
        resolved(value.startsWith('auto:') ? 'lmstudio:qwen/qwen3.6-35b-a3b' : value),
    },
    intellect: {
      liveModels: () => resolved({ ok: false, models: [], error: 'Unavailable in demo' }),
    },
    // No network in the demo, so nothing resolves and the value map shows no
    // card links — the same state as a probe that found nothing.
    modelCards: {
      resolve: (modelIds: string[]) =>
        resolved(Object.fromEntries(modelIds.map((id) => [id, null]))),
    },
    lmStudio: {
      test: () => resolved({ ok: false, error: 'Unavailable in demo' }),
      models: emptyArray,
      modelInfo: emptyArray,
      detect: () =>
        resolved({
          serverRunning: false,
          serverUrl: 'http://127.0.0.1:1234/v1',
          installDetected: false,
          models: [],
          modelContexts: {},
          preferredPresent: [],
          preferredMissing: [],
        }),
      download: () => resolved({ ok: false, error: 'Unavailable in demo' }),
      downloadStatus: (jobId: string) =>
        resolved({
          ok: false,
          jobId,
          error: 'Unavailable in demo',
        }),
    },
    remoteAgent: {
      downloadArtifact: unsupported,
      artifactImageDataUrl: unsupported,
      models: emptyArray,
      discoverExternal: (_projectId?: string) =>
        resolved({
          imported: [],
          scanned: 0,
          skippedLinked: 0,
          skippedWrongRepo: 0,
          skippedInactive: 0,
        }),
    },
    acp: {
      detectAgents: emptyArray,
      probeAgent: unsupported,
      autoSetup: () =>
        resolved({
          installed: [],
          upgraded: [],
          registered: [],
          modelsDetected: [],
          failed: [],
        }),
    },
    menu: {
      onSettings: subscribe,
      onNewThread: subscribe,
      onTogglePanel: subscribe,
      onShowExplorer: subscribe,
      onShowTerminal: subscribe,
      onShowChanges: subscribe,
      onShowBrowser: subscribe,
      onFocusBrowserUrlBar: subscribe,
      onKeyboardShortcuts: subscribe,
      onUiScaleZoomIn: subscribe,
      onUiScaleZoomOut: subscribe,
      onUiScaleReset: subscribe,
    },
    settings: {
      get: (key: string) => resolved(settings.get(key)),
      set: (key: string, value: unknown) => {
        settings.set(key, value)
        return resolvedVoid()
      },
      setSecurity: resolvedVoid,
      // The demo stands in for a configured install: the provider behind the
      // scenario's model reads as available, so the footer names the model that
      // answered instead of labelling it "(no key)".
      getKey: (provider: string) => resolved(provider === scenarioProvider),
      getKeyEncrypted: () => resolved(null),
      setKey: () => resolved({ ok: true }),
      availableProviders: () =>
        resolved({ mock: true, ...(scenarioProvider ? { [scenarioProvider]: true } : {}) }),
      validateKey: () => resolved({ ok: false, error: 'Unavailable in demo' }),
      scanEnvKeys: emptyArray,
      importEnvKeys: () => resolved({ imported: [], skipped: [] }),
      extraProviders: emptyArray,
      // The demo's scenario models are all in the static cloud catalog, so the
      // footer prices them without any fetched rates.
      modelPricing: () => resolved({}),
      saveExtraProvider: emptyArray,
      deleteExtraProvider: emptyArray,
      fetchProviderModels: () => resolved({ ok: false, models: [], error: 'Unavailable in demo' }),
      refreshHuggingFaceModels: () =>
        resolved({ ok: false, count: 0, error: 'Unavailable in demo' }),
    },
    appIcon: { apply: resolvedVoid },
    usage: {
      record: resolvedVoid,
      getSummary: () => {
        const emptyPeriod = {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        }
        return resolved({
          day: emptyPeriod,
          month: emptyPeriod,
          period90d: emptyPeriod,
          allTime: emptyPeriod,
          trackingStartedAt: null,
          ledgerEventCount: 0,
        })
      },
      getPlanUsage: () => resolved({ providers: [], checkedAt: DEMO_TIME }),
      getPlanWorthIt: () =>
        resolved({
          worthIt: {
            verdict: 'insufficient_history',
            reason:
              'Need a couple of completed weekly windows — keep Copse signed into Claude and reopen Usage after resets.',
            apiEquivalentBurnPerWeek: null,
            planFeePerWeek: null,
            monthlyFeeUsd: null,
            feeHint: null,
            completedWeeklyCount: 0,
            inferenceFrontierNote: null,
          },
          windowExhaustion: [],
          historySampleCount: 0,
          completedWeeklyCount: 0,
        }),
      setClaudePlanMonthlyFee: () =>
        resolved({
          worthIt: {
            verdict: 'insufficient_history',
            reason:
              'Need a couple of completed weekly windows — keep Copse signed into Claude and reopen Usage after resets.',
            apiEquivalentBurnPerWeek: null,
            planFeePerWeek: null,
            monthlyFeeUsd: null,
            feeHint: null,
            completedWeeklyCount: 0,
            inferenceFrontierNote: null,
          },
          windowExhaustion: [],
          historySampleCount: 0,
          completedWeeklyCount: 0,
        }),
    },
    index: {
      query: (pattern: string) =>
        resolved(
          ['src/renderer/main.ts', 'src/renderer/demo/demo-api.ts', 'package.json'].filter((path) =>
            path.toLowerCase().includes(pattern.toLowerCase()),
          ),
        ),
      resolveFileReferences: emptyArray,
      status: () =>
        resolved({
          fileIndex: { phase: 'ready' },
          semantic: { phase: 'unavailable' },
        }),
      onStatusChanged: subscribe,
    },
    memories: {
      list: emptyArray,
      create: unsupported,
      update: () => resolved(null),
      delete: () => resolved(false),
    },
    roadmap: {
      list: emptyArray,
      create: unsupported,
      update: () => resolved(null),
      setStatus: () => resolved(null),
      setCategory: () => resolved(null),
      delete: () => resolved(false),
      export: unsupported,
      issueUrl: () => resolved(null),
      openIssues: () => resolved({ slug: 'copse-dev/agent-pane', issues: [], hasMore: false }),
      importIssues: emptyArray,
      matchOpenIssues: emptyArray,
      checkFit: unsupported,
      attachmentData: () => resolved(null),
      prepareReview: unsupported,
      lastReviewAt: () =>
        resolved({
          lastReviewAt: null,
          lastAcknowledgedBulkRun: null,
          pendingBulkRun: null,
        }),
      reviewItem: unsupported,
      reviewItemDeep: unsupported,
      completeReview: () => resolved(false),
      abortReview: () => resolved(false),
      onChanged: subscribe,
      setThread: () => resolved(null),
    },
    supervisor: {
      list: () => resolved({ tasks: [] }),
      cancel: () => resolved({ task: null }),
      onChanged: subscribe,
    },
    // The browser demo has no repository behind it, so it owns no checkouts to
    // list and nothing that could be measured or deleted.
    worktrees: {
      list: emptyArray,
      size: (_projectId: string, path: string) =>
        resolved({ path, bytes: 0, fileCount: 0, truncated: false }),
      remove: unsupported,
    },
    skills: { list: emptyArray },
    plugins: { list: emptyArray },
    hooks: {
      list: () => resolved({ hooks: [], warnings: [] }),
      test: unsupported,
      runDetail: () => resolved({ found: false }),
    },
    packs: {
      list: () => resolved({ packs: DEMO_PACKS }),
      setEnabled: () => resolved({ packs: [] }),
      setSetting: () => resolved({ packs: [] }),
      addSource: () => resolved({ packs: [] }),
    },
    decisions: {
      list: emptyArray,
      export: () => resolved({ path: '', count: 0 }),
    },
    automations: {
      list: emptyArray,
      upsert: unsupported,
      remove: unsupported,
      runNow: unsupported,
      onTriggered: subscribe,
    },
    instructions: { list: emptyArray },
    cursorRules: { list: emptyArray },
    terminal: {
      create: () =>
        resolved<{ sessionId: string; checkoutMode: 'shared' | 'worktree' }>({
          sessionId: 'demo-terminal',
          checkoutMode: 'shared',
        }),
      write: resolvedVoid,
      resize: resolvedVoid,
      destroy: resolvedVoid,
      setMeta: resolvedVoid,
      setActive: resolvedVoid,
      onOutput: subscribe,
      onExit: subscribe,
      onRunCommand: subscribe,
    },
    git: {
      isAvailable: () => resolved(true),
      status: () => resolved({ staged: [], unstaged: [] }),
      changeStats: () => resolved(null),
      fileDiff: () => resolved(null),
      workingFileDiff: () => resolved(null),
      // These take (projectId, threadId, …) — dropping the leading two made
      // `branchStatus` answer with the *project id* as the current branch, which
      // reads as a branch mismatch and blocks every send behind the composer's
      // "this thread is for branch …" guard.
      branchStatus: (_projectId: string, _threadId: string, forBranch?: string) =>
        resolved({
          currentBranch: forBranch ?? currentBranch,
          pr: null,
        }),
      promptState: () => resolved({ startingCommit: null, dirty: false }),
      checkoutBranch: (_projectId: string, _threadId: string, branch: string) => {
        currentBranch = branch
        return resolvedVoid()
      },
      listBranches: () =>
        resolved([
          { name: currentBranch, lastCommitDate: DEMO_TIME },
          { name: 'main', lastCommitDate: DEMO_TIME },
        ]),
      getDefaultBranch: () => resolved('main'),
      sessionBackup: () => resolved(null),
      restoreBackup: () => resolved(false),
    },
    gh: {
      status: () =>
        resolved({
          installed: false,
          authenticated: false,
          username: null,
          message: 'Unavailable in browser demo',
        }),
      listMyOpenPrs: () => resolved([]),
      listWorkspaceOpenPrs: emptyArray,
      prChecks: () => resolved<'no_checks'>('no_checks'),
      prDetails: () => resolved(null),
      prFileDiff: () => resolved(null),
      resolvePrUrl: () => resolved(null),
      agentPrLinks: emptyArray,
      rerunFailedRuns: () =>
        resolved({ ok: false, message: 'Unavailable in demo', backend: 'mock' }),
      approvePr: () => resolved({ ok: false, message: 'Unavailable in demo', backend: 'mock' }),
      markPrReady: () => resolved({ ok: false, message: 'Unavailable in demo', backend: 'mock' }),
      enableAutoMerge: () =>
        resolved({ ok: false, message: 'Unavailable in demo', backend: 'mock' }),
    },
    shell: { openExternal: resolvedVoid },
    editors: {
      list: () => resolved({ editors: [], lastUsedId: null }),
      open: resolvedVoid,
    },
    panes: {
      popout: (mode) => {
        const root = document.documentElement
        const expanded = root.dataset['demoExpandedPane'] === mode
        const button = document.querySelector<HTMLButtonElement>(
          `.pane-popout-btn[data-pane-mode="${mode}"]`,
        )
        if (expanded) {
          root.classList.remove('is-demo-pane-expanded')
          delete root.dataset['demoExpandedPane']
          const placement = expandedPaneButtons.get(mode)
          if (placement) {
            if (placement.nextSibling?.parentNode === placement.parent) {
              placement.parent.insertBefore(placement.button, placement.nextSibling)
            } else {
              placement.parent.append(placement.button)
            }
            expandedPaneButtons.delete(mode)
          }
        } else {
          root.classList.add('is-demo-pane-expanded')
          root.dataset['demoExpandedPane'] = mode
          const toolbar = document.querySelector<HTMLElement>(
            `#${mode}-viewer-host .browser-tab-panel.is-active .browser-toolbar`,
          )
          if (mode === 'browser' && button?.parentElement && toolbar) {
            expandedPaneButtons.set(mode, {
              button,
              parent: button.parentElement,
              nextSibling: button.nextSibling,
            })
            toolbar.insertBefore(button, toolbar.querySelector('.browser-menu-wrap'))
          }
        }
        for (const button of document.querySelectorAll<HTMLButtonElement>(
          `.pane-popout-btn[data-pane-mode="${mode}"]`,
        )) {
          button.textContent = expanded ? '⛶' : '↙'
          button.setAttribute('aria-label', `${expanded ? 'Expand' : 'Restore'} ${mode}`)
          button.title = expanded ? 'Expand pane' : 'Restore app layout'
        }
        return resolvedVoid()
      },
      takePopoutSeed: () => Promise.resolve(null),
      onSwitchMode: () => () => {},
    },
    // The demo build has no main process to store a file, so attaching a video
    // rejects rather than handing back a path nothing could read.
    video: {
      attach: () => Promise.reject(new Error('Video attachments are unavailable in the demo')),
      read: () => Promise.reject(new Error('Video playback is unavailable in the demo')),
    },
  }

  return api
}
