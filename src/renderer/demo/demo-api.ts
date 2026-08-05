import type { StreamChunk, Thread } from '@shared/types'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import { workingBriefFromUserContent } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { DemoScenario } from './scenarios.ts'
import { playTrace, type TracePlayerOptions } from './trace-player.ts'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'

const DEMO_MODEL = 'mock:demo'
const DEMO_TIME = '2026-07-17T09:00:00.000Z'

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

  const emitChunk = (threadId: string, chunk: StreamChunk): void => {
    for (const handler of chunkHandlers) handler(threadId, chunk)
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
      readFile: () => resolved(''),
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
      onShowDiff: subscribe,
      onQueued: subscribe,
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
    skills: { list: emptyArray },
    plugins: { list: emptyArray },
    hooks: {
      list: () => resolved({ hooks: [], warnings: [] }),
      test: unsupported,
      runDetail: () => resolved({ found: false }),
    },
    packs: {
      list: () => resolved({ packs: [] }),
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
      create: () => resolved('demo-terminal'),
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
      popout: resolvedVoid,
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
