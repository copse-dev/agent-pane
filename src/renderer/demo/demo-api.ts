import type { StreamChunk, Thread } from '@shared/types'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import { workingBriefFromUserContent } from '@copse/agent/working-brief.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { DemoScenario } from './scenarios.ts'

const DEMO_MODEL = 'mock:demo'
const DEMO_TIME = '2026-07-17T09:00:00.000Z'

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

export function createDemoApi(scenario: DemoScenario): ApiClient {
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
      onOpened: subscribe,
    },
    browser: {
      onOpenTab: subscribe,
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
        emitChunk(threadId, {
          type: 'text',
          text: `Demo response to: ${prompt}\n\nThis response is streamed through the real renderer event path.`,
        })
        emitChunk(threadId, {
          type: 'usage',
          model: DEMO_MODEL,
          inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
          outputTokens: 18,
          estimated: true,
        })
        emitChunk(threadId, { type: 'done', stopReason: 'end_turn' })
        return resolvedVoid()
      },
      prepareCheckout: unsupported,
      previewCheckout: unsupported,
      estimateContext: (_projectId: string, _threadId: string, payload: string) =>
        resolved({
          segments: [
            { key: 'message', label: 'Your message', tokens: Math.ceil(payload.length / 4) },
          ],
          totalTokens: Math.ceil(payload.length / 4),
          contextWindow: 200_000,
        }),
      abort: resolvedVoid,
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
    sshPrompt: {
      respond: resolvedVoid,
      onRequest: subscribe,
    },
    updatePrompt: {
      respond: resolvedVoid,
      onRequest: subscribe,
      onDevNotice: subscribe,
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
      // The demo has no provider history sidecar to inherit; the forked thread's
      // transcript copy (which the renderer owns) is the whole demo story.
      fork: () => resolved({ source: 'empty' as const, messageCount: 0 }),
      catalog: emptyArray,
      listOrphans: emptyArray,
    },
    openRouter: { models: emptyArray },
    models: {
      chatDefaultContextHealth: () =>
        resolved({
          hasDecentChatDefault: true,
          minimum: 100_000,
          bestAvailableContext: 200_000,
        }),
      bestValueDefault: () => resolved('lmstudio:qwen/qwen3.6-35b-a3b'),
    },
    intellect: {
      liveModels: () => resolved({ ok: false, models: [], error: 'Unavailable in demo' }),
    },
    lmStudio: {
      test: () => resolved({ ok: false, error: 'Unavailable in demo' }),
      models: emptyArray,
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
      getKey: () => resolved(false),
      getKeyEncrypted: () => resolved(null),
      setKey: () => resolved({ ok: true }),
      availableProviders: () => resolved({ mock: true }),
      validateKey: () => resolved({ ok: false, error: 'Unavailable in demo' }),
      scanEnvKeys: emptyArray,
      importEnvKeys: () => resolved({ imported: [], skipped: [] }),
      extraProviders: emptyArray,
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
      delete: () => resolved(false),
      export: unsupported,
      issueUrl: () => resolved(null),
      openIssues: () => resolved({ slug: 'copse-dev/agent-pane', issues: [] }),
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
    skills: { list: emptyArray },
    plugins: { list: emptyArray },
    hooks: {
      list: () => resolved({ hooks: [], warnings: [] }),
      test: unsupported,
    },
    packs: {
      list: () => resolved({ packs: [] }),
      setEnabled: () => resolved({ packs: [] }),
      setSetting: () => resolved({ packs: [] }),
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
    },
    git: {
      isAvailable: () => resolved(true),
      status: () => resolved({ staged: [], unstaged: [] }),
      changeStats: () => resolved(null),
      fileDiff: () => resolved(null),
      workingFileDiff: () => resolved(null),
      branchStatus: (forBranch?: string) =>
        resolved({
          currentBranch: forBranch ?? currentBranch,
          pr: null,
        }),
      checkoutBranch: (branch: string) => {
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
