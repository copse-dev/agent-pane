import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  readFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { e2eGitBranch } from './e2e-env.ts'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Message } from '../../../src/shared/types/index.ts'
import type { AcpAgentConfig } from '../../../src/shared/types/acp.ts'
import { explodeThread } from '../../../src/shared/threads/fold.ts'
import {
  SPINE_SCHEMA_VERSION,
  serializeSpine,
  serializeSpineLine,
  type SpineHookRunLine,
} from '../../../src/shared/threads/spine-schema.ts'

/** Mirrors `app.setPath('userData', …)` in `src/main/app-init.ts`. */
function copsePanelUserDataDir(): string {
  const override = process.env.COPSE_PANEL_USER_DATA?.trim()
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'copse-panel')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'copse-panel')
  }
  return join(homedir(), '.config', 'copse-panel')
}

const USER_DATA = copsePanelUserDataDir()
const CONFIG_PATH = join(USER_DATA, 'config.json')
const SETTINGS_PATH = join(USER_DATA, 'settings.json')

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex')

/** New-format chat-store root; mirrors `thread-store.ts` (COPSE_WORKSPACE_DIR override). */
function e2eWorkspaceDir(): string {
  const override = process.env.COPSE_WORKSPACE_DIR?.trim()
  return override && override.length > 0 ? override : join(USER_DATA, 'workspace')
}

// Fixtures embed loose thread JSON where messages/tool-calls may omit fields the
// real store explode path requires (`toolCalls`, tool `result`). Fill those in
// so the seed matches what the app would have persisted.
function normalizeMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
  return {
    ...msg,
    toolCalls: toolCalls.map((tc) => normalizeToolCall(tc as Record<string, unknown>)),
  }
}

function normalizeToolCall(tc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...tc,
    result: tc.result === undefined ? null : tc.result,
  }
  const sub = tc.subagent as Record<string, unknown> | undefined
  if (sub) {
    const subMessages = Array.isArray(sub.messages) ? sub.messages : []
    out.subagent = {
      ...sub,
      messages: subMessages.map((m) => normalizeMessage(m as Record<string, unknown>)),
    }
  }
  return out
}

/**
 * Write one seeded thread as a self-contained new-format directory under
 * `COPSE_WORKSPACE_DIR/<projectId>/<threadId>/` (issue #644), using the same
 * explode/spine logic the app persists with. The catalog is intentionally not
 * written — the store rebuilds it from the thread dirs on first read.
 */
function seedThreadDir(projectId: string, thread: Record<string, unknown>): void {
  const { messages, ...meta } = thread
  const normalized = (Array.isArray(messages) ? messages : []).map((m) =>
    normalizeMessage(m as Record<string, unknown>),
  )
  const dir = join(e2eWorkspaceDir(), projectId, String(meta.id))
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const { spine, files } = explodeThread(normalized as unknown as Message[], sha256)
  for (const file of files) {
    const full = join(dir, file.ref)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, file.contents)
  }
  writeFileSync(join(dir, 'events.jsonl'), serializeSpine(spine))
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`)
}

/**
 * Drop-in replacement for the fixtures' `writeFileSync(CONFIG_PATH, …)`: any
 * `threads:<projectId>` array in the config is routed to the filesystem-native
 * thread store the app now reads; everything else stays in `config.json`.
 */
export function writeSeedConfig(config: Record<string, unknown>): void {
  mkdirSync(USER_DATA, { recursive: true })
  const remaining: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    const match = /^threads:(.+)$/.exec(key)
    if (match && Array.isArray(value)) {
      for (const thread of value) {
        seedThreadDir(match[1], thread as Record<string, unknown>)
      }
    } else {
      remaining[key] = value
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(remaining), 'utf8')
}

export function resetUserData(): void {
  rmSync(CONFIG_PATH, { force: true })
  rmSync(SETTINGS_PATH, { force: true })
  writeSettings({})
}

/** `~/.cursor/hooks.json` — mirrors `userHooksConfigPath()` in hooks/cursor-adapter.ts. */
const USER_CURSOR_HOOKS_PATH = join(homedir(), '.cursor', 'hooks.json')
const USER_CURSOR_HOOKS_BACKUP = `${USER_CURSOR_HOOKS_PATH}.e2e-backup`

/**
 * Seed a user-scope Cursor `hooks.json` for the Sources → Hooks e2e. Any real
 * file at that path is backed up first; call {@link restoreUserCursorHooks}
 * in `after` to put it back (or remove the seeded one).
 */
export function seedUserCursorHooks(config: unknown): void {
  mkdirSync(dirname(USER_CURSOR_HOOKS_PATH), { recursive: true })
  if (existsSync(USER_CURSOR_HOOKS_PATH) && !existsSync(USER_CURSOR_HOOKS_BACKUP)) {
    copyFileSync(USER_CURSOR_HOOKS_PATH, USER_CURSOR_HOOKS_BACKUP)
  }
  const contents = typeof config === 'string' ? config : JSON.stringify(config, null, 2)
  writeFileSync(USER_CURSOR_HOOKS_PATH, contents, 'utf8')
}

/** Undo {@link seedUserCursorHooks}: restore the backup or remove the seeded file. */
export function restoreUserCursorHooks(): void {
  if (existsSync(USER_CURSOR_HOOKS_BACKUP)) {
    copyFileSync(USER_CURSOR_HOOKS_BACKUP, USER_CURSOR_HOOKS_PATH)
    rmSync(USER_CURSOR_HOOKS_BACKUP, { force: true })
  } else {
    rmSync(USER_CURSOR_HOOKS_PATH, { force: true })
  }
}

/** Fresh profile that triggers the first-run onboarding wizard. */
export function seedOnboardingFixture(): void {
  resetUserData()
  writeSettings({ onboardingCompleted: false })
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(USER_DATA, { recursive: true })
  // Pin appearance so reference screenshots are deterministic: the app now
  // defaults to `system` theme (which resolves to whatever prefers-color-scheme
  // the CI runner reports) and a pink interface tint — both would make shots
  // depend on the host / drift with brand tweaks. Force the historical
  // neutral-dark look here; individual specs can override via `settings`.
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      ...settings,
    }),
    'utf8',
  )
}

/** Pin Electron window size for deterministic e2e reference screenshots. Call before reloadSession(). */
export function seedE2eViewport(
  bounds: { width: number; height: number } = { width: 1280, height: 800 },
): void {
  writeSettings({ windowBounds: bounds })
}

/** Workspace + pinned theme for the preload boot-theme e2e (#41). */
export function seedThemeBootFixture(workspaceRoot: string, theme: 'light' | 'dark'): void {
  resetUserData()
  writeSeedConfig({
    projects: [{ id: 'p1', path: workspaceRoot, name: 'workspace' }],
    activeProjectId: 'p1',
  })
  writeSettings({ theme, uiTintStrength: 'off' })
}

/** Layout for three-pane reference screenshots. Call before reloadSession(). */
export function seedE2eThreePaneLayout(
  overrides: Partial<{
    projectsPaneWidth: number
    filesPaneWidth: number
    fileTreeWidth: number
  }> = {},
): void {
  writeSettings({
    layout: {
      projectsPaneWidth: 260,
      filesPaneWidth: 480,
      fileTreeWidth: 200,
      ...overrides,
    },
  })
}

/** SSH workspace settings for remote-folder / SSH settings UI e2e specs. */
export function seedSshWorkspaceSettings(options?: {
  /** `false` = none; omit/`true` = default fixture host; or pass an explicit host list. */
  hosts?: boolean | Array<{ id: string; label: string; host: string; user?: string }>
  enabled?: boolean
}): void {
  const defaultHost = { id: 'dev', label: 'Dev Server', host: 'dev.example', user: 'ubuntu' }
  const hosts =
    options?.hosts === false ? [] : Array.isArray(options?.hosts) ? options.hosts : [defaultHost]
  writeSettings({
    sshWorkspaceEnabled: options?.enabled !== false,
    sshWorkspaceHosts: hosts,
  })
}

export function seedEmptyProject(
  workspaceRoot: string,
  projectId: string,
  options?: {
    subagentsEnabled?: boolean
    mockFollowUps?: boolean
    model?: string
    advisorModel?: string
    localServerUrl?: string
    localDefaultModel?: string
    subagentModel?: string
    localSubagentsEnabled?: boolean
    autoPortraitRightPanel?: boolean
    rightPanelPosition?: 'auto' | 'side' | 'bottom'
    /**
     * Opt into the `copse.okf-memories` pack (its `remember`/`recall` tools, the
     * memory prompt block, and the Memories pane). The feature migrated off the
     * retired `okfMemoriesEnabled` setting; `migrateOkfMemoriesEnablement()`
     * treats an absent legacy value as "keep the experimental feature off" and
     * disables the pack on first boot — so a test that needs the Memories pane
     * visible seeds the legacy opt-in. Written to `config.json` (the unvalidated
     * `electron-store` the migration reads via `storageGet`), not `settings.json`
     * (whose writable schema retired the flag), mirroring `modelComparisonEnabled`.
     */
    okfMemoriesEnabled?: boolean
    /**
     * Opt into the `copse.roadmap-plans` pack (its `roadmap_plan` tool + the
     * Roadmap pane). Like `modelComparisonEnabled`, the one-time
     * `migrateRoadmapPlansEnablement()` treats an absent legacy
     * `roadmapPlansEnabled` as "keep the experimental feature off" and disables
     * the pack on first boot — so a roadmap test must seed the legacy opt-in.
     * Written to `config.json` (the unvalidated `electron-store` the migration
     * reads via `storageGet`), not `settings.json` (whose writable schema
     * retired the flag), mirroring pack-service.test.ts.
     */
    roadmapPlansEnabled?: boolean
    registeredAcpAgents?: AcpAgentConfig[]
    windowBounds?: { width: number; height: number }
    /** Bind the seeded project to an SSH host id (requires matching sshWorkspaceHosts). */
    sshHost?: string
    /**
     * Pack ids to force-disable at boot. Written to the `packDisabled` list the
     * host pack service reads (P3). Use this to opt out of packs that ship
     * enabled by default (e.g. drop the `copse.model-comparison` pack for a test
     * that must not surface the `compare_models` tool).
     */
    packDisabled?: readonly string[]
    /**
     * Opt into the `copse.model-comparison` pack (and its `compare_models`
     * tool). P5's one-time `migrateP5Enablement()` treats an absent legacy
     * `modelComparisonEnabled` as "keep the experimental tool off" and disables
     * the pack on first boot — so a test exercising the comparison approval flow
     * must seed the legacy opt-in. Written to `config.json` (the unvalidated
     * `electron-store` the migration reads via `storageGet`), not `settings.json`
     * (whose writable schema retired the flag), mirroring pack-service.test.ts.
     */
    modelComparisonEnabled?: boolean
  },
): void {
  mkdirSync(USER_DATA, { recursive: true })
  const project: Record<string, unknown> = {
    id: projectId,
    path: workspaceRoot,
    name: 'workspace',
  }
  if (options?.sshHost) project.sshHost = options.sshHost
  const seedConfig: Record<string, unknown> = {
    projects: [project],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [],
  }
  // Seed the legacy opt-in into `config.json` (the store `migrateP5Enablement`
  // reads) so the migration keeps `copse.model-comparison` enabled instead of
  // disabling it as a previously opt-in tool.
  if (options?.modelComparisonEnabled) {
    seedConfig.modelComparisonEnabled = true
  }
  // Same for the `copse.roadmap-plans` pack: seed the legacy opt-in into
  // `config.json` so `migrateRoadmapPlansEnablement` keeps the pack (and its
  // Roadmap pane) enabled instead of disabling it as a previously opt-in tool.
  if (options?.roadmapPlansEnabled) {
    seedConfig.roadmapPlansEnabled = true
  }
  // Same as modelComparisonEnabled: seed the retired `okfMemoriesEnabled` legacy
  // opt-in into `config.json` so `migrateOkfMemoriesEnablement()` keeps the
  // `copse.okf-memories` pack enabled instead of disabling it as a previously
  // opt-in feature (which is what reveals the Memories pane).
  if (options?.okfMemoriesEnabled) {
    seedConfig.okfMemoriesEnabled = true
  }
  writeSeedConfig(seedConfig)
  const settings: Record<string, unknown> = {}
  if (options?.subagentsEnabled !== undefined) {
    settings.subagentsEnabled = options.subagentsEnabled
  }
  if (options?.mockFollowUps) {
    settings.mockFollowUps = true
  }
  if (options?.model) {
    settings.model = options.model
  }
  if (options?.packDisabled !== undefined) {
    settings.packDisabled = [...options.packDisabled]
  }
  if (options?.advisorModel) {
    settings.advisorModel = options.advisorModel
  }
  if (options?.localServerUrl) {
    settings.localServerUrl = options.localServerUrl
  }
  if (options?.localDefaultModel) {
    settings.localDefaultModel = options.localDefaultModel
  }
  if (options?.subagentModel) {
    settings.subagentModel = options.subagentModel
  }
  if (options?.localSubagentsEnabled !== undefined) {
    settings.localSubagentsEnabled = options.localSubagentsEnabled
  }
  if (options?.autoPortraitRightPanel !== undefined) {
    settings.autoPortraitRightPanel = options.autoPortraitRightPanel
  }
  if (options?.rightPanelPosition !== undefined) {
    settings.rightPanelPosition = options.rightPanelPosition
  }
  if (options?.registeredAcpAgents !== undefined) {
    settings.registeredAcpAgents = options.registeredAcpAgents
  }
  if (options?.windowBounds !== undefined) {
    settings.windowBounds = options.windowBounds
  }
  if (Object.keys(settings).length > 0) {
    writeSettings(settings)
  } else {
    writeSettings({})
  }
}

/**
 * Seed OKF roadmap notes for a workspace, mirroring the knowledge store's
 * on-disk layout (`~/.copse/knowledge/<slug>-<hash8>/roadmap/<id>.md`,
 * `src/main/services/storage/knowledge-store.ts`). No `index.jsonl` is written —
 * the store heals unindexed note files in on first read. Returns the workspace's
 * knowledge dir so specs can remove it in `after`.
 */
export function seedRoadmapNotes(
  workspaceRoot: string,
  notes: { id: string; title: string; body: string; status?: string }[],
): string {
  const slug =
    workspaceRoot
      .split('/')
      .filter(Boolean)
      .slice(-1)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'workspace'
  const hash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 8)
  const knowledgeDir = join(homedir(), '.copse', 'knowledge', `${slug}-${hash}`)
  const roadmapDir = join(knowledgeDir, 'roadmap')
  mkdirSync(roadmapDir, { recursive: true })
  const iso = new Date().toISOString()
  for (const note of notes) {
    const contents = [
      '---',
      'type: Roadmap',
      `id: ${note.id}`,
      `title: "${note.title}"`,
      'tags: []',
      `status: ${note.status ?? 'ready'}`,
      `createdAt: ${iso}`,
      `updatedAt: ${iso}`,
      '---',
      '',
      note.body,
      '',
    ].join('\n')
    writeFileSync(join(roadmapDir, `${note.id}.md`), contents, 'utf8')
  }
  return knowledgeDir
}

/** Two projects on the same workspace root for project-switch e2e (#502). */
export function seedProjectSwitchFixture(
  workspaceRoot: string,
  options?: { activeProjectId?: 'project-a' | 'project-b' },
): { projectAId: string; projectBId: string } {
  const projectAId = 'e2e-project-switch-a'
  const projectBId = 'e2e-project-switch-b'
  const activeProjectId = options?.activeProjectId === 'project-b' ? projectBId : projectAId
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [
      { id: projectAId, path: workspaceRoot, name: 'Project A' },
      { id: projectBId, path: workspaceRoot, name: 'Project B' },
    ],
    activeProjectId,
    [`threads:${projectAId}`]: [],
    [`threads:${projectBId}`]: [],
  })
  writeSettings({})
  return { projectAId, projectBId }
}

/**
 * Project with a stored OpenRouter API key, a custom model, and a (test-only)
 * `openRouterApiBase` pointing at a local fixture so the picker fetches a known
 * free/tool-capable model list without hitting the real OpenRouter API. The key
 * record matches the base64-plaintext shape `setApiKey` writes when OS secure
 * storage is unavailable, which is all `hasApiKey` needs to report it set.
 */
export function seedOpenRouterFixture(
  workspaceRoot: string,
  options?: { apiBase?: string; freeMode?: boolean },
): void {
  const projectId = 'e2e-openrouter-project'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [],
  })
  writeSettings({
    model: 'openrouter:qwen/qwen3-235b-a22b:free',
    openRouterModel: 'anthropic/claude-3.5-sonnet',
    ...(options?.freeMode ? { openRouterFreeMode: true } : {}),
    ...(options?.apiBase ? { openRouterApiBase: options.apiBase } : {}),
    apiKey: {
      openrouter: {
        v: 1,
        enc: Buffer.from('sk-or-e2e-key', 'utf8').toString('base64'),
        plain: true,
      },
    },
  })
}

/**
 * Seed a Cursor key for the remote-agent model picker e2e. Point
 * `remoteAgentBaseUrl` at a local fixture that serves `GET /v1/models` (Cursor
 * validation + catalog share that base). Claude Cloud Agent rows are covered by
 * unit tests — Anthropic key validation hits the real API and can't be stubbed
 * from seed data alone.
 */
export function seedRemoteAgentModelsFixture(
  workspaceRoot: string,
  options: { apiBase: string; model?: string },
): void {
  const projectId = 'e2e-remote-models-project'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [],
  })
  writeSettings({
    model: options.model ?? 'remote-agent:cursor',
    remoteAgentBaseUrl: options.apiBase,
    apiKey: {
      cursor: {
        v: 1,
        enc: Buffer.from('e2e-cursor-key', 'utf8').toString('base64'),
        plain: true,
      },
    },
  })
}

/** Tool args containing HTML-like strings that break innerHTML <pre> templates. */
export const INNERHTML_TRAP_ARGS = {
  path: 'index.html',
  content: '</pre><img src=x alt="injected"><pre>',
} as const

export function seedInnerHtmlToolArgsFixture(workspaceRoot: string): void {
  const projectId = 'e2e-innerhtml-project'
  const threadId = 'e2e-innerhtml-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'innerHTML trap test',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-innerhtml',
            role: 'assistant',
            content: 'Wrote a file with tricky HTML-like content in the arguments.',
            toolCalls: [
              {
                id: 'tc-write-trap',
                name: 'write_file',
                args: INNERHTML_TRAP_ARGS,
                status: 'done',
                result: 'Wrote index.html',
                editStats: { additions: 1, deletions: 0 },
              },
            ],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Assistant message with sprint retrospective metadata using &nbsp; pipe separators. */
export function seedSprintRetroNbspFixture(workspaceRoot: string): void {
  const projectId = 'e2e-sprint-retro-project'
  const threadId = 'e2e-sprint-retro-thread'
  const sprintMetadataLine =
    '**Sprint Dates:** 2025-01-13 → 2025-01-27 &nbsp;&nbsp;|&nbsp;&nbsp; **Team:** Platform Squad &nbsp;&nbsp;|&nbsp;&nbsp; **Velocity:** 42/55 points'
  const content = [
    "Here's another markdown example — this time a **Sprint Retrospective** with different formatting patterns:",
    '',
    '---',
    '',
    '# 📊 Sprint 24 Retrospective',
    '',
    sprintMetadataLine,
    '',
    '---',
    '',
    '## Sprint Summary',
    '',
    '| Metric | Planned | Completed | % Done |',
    '|--------|---------|-----------|:------:|',
    '| Story Points | 55 | 42 | 76% |',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Sprint retrospective nbsp',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-sprint-retro',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Job description with two consecutive nbsp metadata lines (must not become a table). */
export function seedJobDescriptionMetadataFixture(workspaceRoot: string): void {
  const projectId = 'e2e-jd-metadata-project'
  const threadId = 'e2e-jd-metadata-thread'
  const content = readFileSync(
    join(workspaceRoot, 'tests/fixtures/job-description-metadata.md'),
    'utf8',
  )
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Job description metadata',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-jd-metadata',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Assistant message with a root-relative markdown link to a real workspace file. */
export function seedMarkdownWorkspaceLinkFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-workspace-link-project'
  const threadId = 'e2e-markdown-workspace-link-thread'
  const content =
    'See [Type safety guide](/docs/type-safety.md) for renderer and main-process conventions.'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Workspace markdown link',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-workspace-link',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Thematic breaks (spaced marker runs) + multi-backtick / multi-line code spans. */
export function seedMarkdownConformanceFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-conformance-project'
  const threadId = 'e2e-markdown-conformance-thread'
  const content = [
    'Thematic breaks from spaced markers:',
    '',
    '* * *',
    '',
    'Some prose between breaks.',
    '',
    '- - -',
    '',
    'Inline code spans: a multi-backtick span `` foo ` bar `` keeps the interior backtick,',
    'and ``code`` renders too.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Markdown conformance',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-conformance',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

export function seedBrowserLinkChatFixture(workspaceRoot: string): void {
  const projectId = 'e2e-browser-link-chat-project'
  const threadId = 'e2e-browser-link-chat-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Browser link chat',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-link',
            role: 'assistant',
            content: 'See [Example Domain](https://example.com) for details.',
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/**
 * Two threads where one owns a Cursor cloud run. Used to prove browser/chat
 * navigation to `cursor.com/agents/...` loads the page and does **not** steal
 * the active thread (thread handoff stays on the PR pane button).
 */
export function seedBrowserCursorAgentThreadFixture(workspaceRoot: string): void {
  const projectId = 'e2e-browser-cursor-agent-project'
  const linkedThreadId = 'e2e-browser-cursor-agent-linked-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: 'e2e-browser-cursor-agent-github-thread',
        title: 'Review agent PR on GitHub',
        status: 'idle',
        messages: [
          {
            id: 'msg-github-review',
            role: 'assistant',
            content: 'Reviewing the pull request in the built-in browser.',
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: linkedThreadId,
        title: 'Linked Cursor agent thread',
        status: 'idle',
        messages: [
          {
            id: 'msg-linked-cursor-run',
            role: 'assistant',
            content: 'This thread launched the matching Cursor cloud agent.',
            createdAt: now - 1_000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'bc-e2e-linked-agent',
          createdAt: now - 1_000,
        },
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      },
    ],
  })
}

/** Thread with a GitHub PR markdown link for PR panel e2e. */
export function seedPrPanelChatFixture(workspaceRoot: string): void {
  const projectId = 'e2e-pr-panel-project'
  const threadId = 'e2e-pr-panel-thread'
  const mockPrUrl = 'https://github.com/copse-dev/copse-panel/pull/42'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'PR panel chat',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-pr-link',
            role: 'assistant',
            content: `Track progress in [PR #42](${mockPrUrl}).`,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/**
 * Like {@link seedPrPanelChatFixture}, but the thread also carries a
 * `remoteAgentLink` (issue #690) pointing at the same PR, so the PR pane badges
 * the row as agent-owned and offers an "open thread" jump. The reverse index is
 * rebuilt from this meta on first read (no index file is seeded).
 */
export function seedPrPanelAgentLinkFixture(workspaceRoot: string): void {
  const projectId = 'e2e-pr-agent-link-project'
  const threadId = 'e2e-pr-agent-link-thread'
  const mockPrUrl = 'https://github.com/copse-dev/copse-panel/pull/42'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    // Active thread carries the chat PR link (so the linked section appears)
    // but not the agent ownership — that lives on the quieter thread so the
    // PR "open agent thread" jump has somewhere visible to switch to.
    [`threads:${projectId}`]: [
      {
        id: 'e2e-pr-agent-link-other-thread',
        title: 'Unrelated local work',
        status: 'idle',
        messages: [
          {
            id: 'msg-unrelated-pr-link',
            role: 'assistant',
            content: `Track progress in [PR #42](${mockPrUrl}).`,
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: threadId,
        title: 'Agent PR chat',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-pr-link',
            role: 'assistant',
            content: `Opened [PR #42](${mockPrUrl}) for you.`,
            createdAt: now - 1_000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'e2e-agent-1',
          prUrl: mockPrUrl,
          repo: 'copse-dev/copse-panel',
          createdAt: now - 1_000,
        },
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      },
    ],
  })
}

/** Git tool cards followed by an ordered-list summary (typical post-tool agent reply). */
export function seedGitSummaryMarkdownFixture(workspaceRoot: string): void {
  const projectId = 'e2e-git-summary-md-project'
  const threadId = 'e2e-git-summary-md-thread'
  const summary = [
    "Here's a summary of the three changed files:",
    '',
    '1. `src/main/project-sandbox/sandbox-fs-client.ts`',
    '',
    'Introduces a **sandboxed filesystem client** that routes reads and writes through a worker thread when the project sandbox is active.',
    '',
    '2. `src/main/project-sandbox/sandbox-fs-worker.ts`',
    '',
    'Worker thread that handles file operations under seatbelt constraints and reports results back to the main process.',
    '',
    '3. `src/main/project-sandbox/spawn.ts`',
    '',
    'Adds sandbox spawn helpers and wires ASRT seatbelt initialization for macOS project commands.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Git summary markdown',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-git-summary',
            role: 'user',
            content: 'Can you summarise the git changes?',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-git-tools',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc-git-status',
                name: 'git_status',
                args: {},
                status: 'done',
                result: 'M sandbox-fs-client.ts\nM sandbox-fs-worker.ts\nM spawn.ts',
              },
              {
                id: 'tc-git-diff',
                name: 'git_diff',
                args: {},
                status: 'done',
                result: 'diff --git a/src/main/project-sandbox/spawn.ts',
              },
            ],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-git-summary',
            role: 'assistant',
            content: summary,
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** A representative completed coding turn for conversation hierarchy visual evaluation. */
export function seedConversationVisualHierarchyFixture(workspaceRoot: string): void {
  const projectId = 'e2e-conversation-hierarchy-project'
  const threadId = 'e2e-conversation-hierarchy-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    expandedProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Conversation visual hierarchy',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-hierarchy',
            role: 'user',
            content: 'Can you make sure Prettier passes and commit the formatting fix?',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-check',
            role: 'assistant',
            content: '',
            reasoning:
              'Running the formatter check first, then I will update only the affected file.',
            toolCalls: [
              {
                id: 'tc-format-check',
                name: 'run_shell',
                args: { command: 'npm run format:check' },
                status: 'done',
                result: 'Formatting issues found in tests/e2e/model-picker.e2e.ts',
              },
            ],
            createdAt: now + 1,
          },
          {
            id: 'msg-assistant-result',
            role: 'assistant',
            content: [
              'Prettier is fixed and the formatting change is committed.',
              '',
              '- Formatted `tests/e2e/model-picker.e2e.ts`',
              '- Verified `npm run format:check` passes',
              '- Created commit `abc1234`',
              '- [Open the pull request](https://github.com/copse-dev/agent-pane/pull/899)',
            ].join('\n'),
            toolCalls: [],
            review: {
              status: 'done',
              summary: 'The formatting-only change is scoped correctly. No issues found.',
            },
            createdAt: now + 3,
          },
        ],
        todos: [
          {
            id: 'todo-hierarchy-1',
            content: 'Inspect the affected conversation surfaces',
            status: 'completed',
          },
          {
            id: 'todo-hierarchy-2',
            content: 'Align transcript cards to the reading column',
            status: 'completed',
          },
          {
            id: 'todo-hierarchy-3',
            content: 'Verify the focused screenshot evaluation',
            status: 'completed',
          },
        ],
        comparison: {
          status: 'error',
          models: { a: 'reviewer-a', b: 'reviewer-b', judge: 'judge' },
          reviewA: '',
          reviewB: '',
          synthesis: '',
          error: 'Comparison declined.',
        },
        usage: { inputTokens: 3200, outputTokens: 900 },
        contextSnapshot: {
          contextWindow: 200_000,
          conversationBudget: 180_000,
          conversationTokens: 54_000,
          fillRatio: 0.3,
          updatedAt: now + 3,
        },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

/** Two user turns followed by enough output to exercise the latest-prompt sticky anchor. */
export function seedStickyUserPromptFixture(workspaceRoot: string): void {
  const projectId = 'e2e-sticky-user-prompt-project'
  const threadId = 'e2e-sticky-user-prompt-thread'
  const now = Date.now()
  const firstResult = [
    'The initial pass is complete.',
    '',
    ...Array.from(
      { length: 8 },
      (_, index) =>
        `Initial result ${String(index + 1)}: inspected the relevant renderer and interaction code.`,
    ),
  ].join('\n\n')
  const latestResult = [
    'Applying the follow-up request now.',
    '',
    ...Array.from(
      { length: 32 },
      (_, index) =>
        `- Validation detail ${String(index + 1)} remains visible beneath the active request.`,
    ),
  ].join('\n')

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    expandedProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Sticky user prompt',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-sticky-first',
            role: 'user',
            content: 'Please inspect the current chat layout.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-sticky-first',
            role: 'assistant',
            content: firstResult,
            toolCalls: [],
            createdAt: now + 1,
          },
          {
            id: 'msg-user-sticky-latest',
            role: 'user',
            content: 'Follow-up: keep this latest request visible while the response grows.',
            toolCalls: [],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-sticky-result',
            role: 'assistant',
            content: latestResult,
            toolCalls: [],
            createdAt: now + 3,
          },
        ],
        usage: { inputTokens: 2400, outputTokens: 1600 },
        contextSnapshot: {
          contextWindow: 200_000,
          conversationBudget: 180_000,
          conversationTokens: 36_000,
          fillRatio: 0.2,
          updatedAt: now + 3,
        },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

/**
 * G1 hook-card visual eval (decision 10). Seeds an idle thread whose spine
 * carries always-on `hook_run` records (decision 6) so the store folds them into
 * the display-only hook-card family (executions, deny/ask decisions, halts),
 * plus a hook-originated user turn (`origin` persisted on the message) so the
 * origin marker renders. Written by interleaving the exploded message spine with
 * `hook_run` lines anchored to the message they fired within — exactly the
 * on-disk shape `appendHookRun` produces — so the real fold path is exercised.
 */
export function seedHookCardsFixture(workspaceRoot: string): void {
  const projectId = 'e2e-hook-cards-project'
  const threadId = 'e2e-hook-cards-thread'
  const now = Date.now()
  const messages: Message[] = [
    {
      id: 'msg-user-hook-open',
      role: 'user',
      content: 'Run the test suite and fix any failures.',
      toolCalls: [],
      createdAt: now,
    },
    {
      id: 'msg-assistant-hook',
      role: 'assistant',
      content: 'Running the suite. A pre-commit hook gated the shell command.',
      toolCalls: [
        {
          id: 'tc-run-tests',
          name: 'run_shell',
          args: { command: 'npm test' },
          status: 'done',
          result: 'All tests passed.',
        },
      ],
      createdAt: now + 1,
    },
    {
      id: 'msg-user-hook-followup',
      role: 'user',
      content: 'You still have open todos — finish them before stopping.',
      toolCalls: [],
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      createdAt: now + 2,
    },
    {
      id: 'msg-assistant-hook-2',
      role: 'assistant',
      content: 'A stop hook halted the run.',
      toolCalls: [],
      createdAt: now + 3,
    },
  ]

  const hookRun = (overrides: Partial<SpineHookRunLine> & { id: string }): SpineHookRunLine => ({
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    event: 'beforeShellExecution',
    hookId: 'guard.sh',
    executor: 'command',
    startedAt: now,
    durationMs: 24,
    exitCode: 0,
    parseOk: true,
    decision: {},
    ...overrides,
  })

  // hook_run lines anchor to the message that precedes them in the spine.
  const runsByAnchor: Record<string, SpineHookRunLine[]> = {
    'msg-assistant-hook': [
      hookRun({ id: 'hr-allow', decision: { permission: 'allow' } }),
      hookRun({ id: 'hr-deny', hookId: 'block-prod.sh', decision: { permission: 'deny' } }),
    ],
    'msg-assistant-hook-2': [
      hookRun({
        id: 'hr-halt',
        event: 'stop',
        hookId: 'todo-closeout',
        durationMs: 0,
        decision: { haltRun: true, haltApplied: true, stopReason: 'Open todos remain.' },
      }),
    ],
  }

  const { spine, files } = explodeThread(messages, sha256)
  const lines: string[] = []
  for (const line of spine) {
    lines.push(serializeSpineLine(line))
    for (const run of runsByAnchor[line.id] ?? []) lines.push(serializeSpineLine(run))
  }

  const dir = join(e2eWorkspaceDir(), projectId, threadId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const full = join(dir, file.ref)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, file.contents)
  }
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
  const meta = {
    id: threadId,
    title: 'Hook cards',
    status: 'idle',
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: now,
    updatedAt: now + 3,
  }
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`)

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
  })
}

export function seedCodeBlockCopyFixture(workspaceRoot: string): void {
  const projectId = 'e2e-code-block-copy-project'
  const threadId = 'e2e-code-block-copy-thread'
  const content = [
    'Use this helper:',
    '',
    '```typescript',
    'export function greet(name: string) {',
    '  return `Hello, ${name}!`',
    '}',
    '```',
    '',
    'Then run:',
    '',
    '```bash',
    'npm run check',
    '```',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Code block copy',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-code-blocks',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

export function seedMermaidDiagramFixture(workspaceRoot: string): void {
  const projectId = 'e2e-mermaid-project'
  const threadId = 'e2e-mermaid-thread'
  const content = [
    'Here is the agent loop:',
    '',
    '```mermaid',
    'graph TD',
    '  User --> Agent',
    '  Agent --> Tools',
    '  Tools --> Agent',
    '```',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Mermaid diagram',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-mermaid',
            role: 'assistant',
            content,
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Seeded thread with context snapshot and token usage for footer doughnut validation. */
export function seedContextWheelFixture(workspaceRoot: string): void {
  const projectId = 'e2e-context-wheel-project'
  const threadId = 'e2e-context-wheel-thread'
  const conversationBudget = 180_000
  const conversationTokens = 54_000
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Context wheel test',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            content: 'Explain this codebase.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 1200, outputTokens: 800 },
        contextSnapshot: {
          contextWindow: 200_000,
          conversationBudget,
          conversationTokens,
          fillRatio: conversationTokens / conversationBudget,
          updatedAt: Date.now(),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

export function seedPortraitRightPanelFixture(
  workspaceRoot: string,
  autoPortraitRightPanel: boolean,
  windowBounds: { width: number; height: number } = { width: 760, height: 1180 },
  options?: {
    okfMemoriesEnabled?: boolean
    /**
     * Opt into the `copse.roadmap-plans` pack (Roadmap pane). Seeded into
     * `config.json` so `migrateRoadmapPlansEnablement` keeps the pack enabled —
     * the writable settings schema retired the flag (see `seedEmptyProject`).
     */
    roadmapPlansEnabled?: boolean
    /** Pin panel placement; `bottom` forces portrait chrome without a tall window. */
    rightPanelPosition?: 'auto' | 'side' | 'bottom'
  },
): void {
  const projectId = 'e2e-portrait-right-panel-project'
  const threadId = 'e2e-portrait-right-panel-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    ...(options?.roadmapPlansEnabled ? { roadmapPlansEnabled: true } : {}),
    // The Memories pane is gated by the `copse.okf-memories` pack; seed the
    // retired legacy opt-in into `config.json` so the enablement migration keeps
    // the pack (and its pane) enabled (mirrors `seedEmptyProject`).
    ...(options?.okfMemoriesEnabled ? { okfMemoriesEnabled: true } : {}),
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Portrait right panel layout',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-portrait-layout',
            role: 'user',
            content: 'Open the right panel in a portrait window.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
  writeSettings({
    autoPortraitRightPanel,
    windowBounds,
    ...(options?.rightPanelPosition !== undefined
      ? { rightPanelPosition: options.rightPanelPosition }
      : {}),
  })
}

/**
 * Thread with a completed post-turn review for the inline-review-card e2e (#480).
 * The review is anchored to the assistant message that concluded its turn and
 * must render INSIDE the scrolling `.messages-list` as that message's next
 * sibling (not pinned in a sibling `.conversation-review-host`), so the later
 * follow-up user message stays BELOW it — proving the card sits in position in
 * the transcript rather than at the bottom of the conversation.
 */
export function seedReviewInlineFixture(workspaceRoot: string): void {
  const projectId = 'e2e-review-inline-project'
  const threadId = 'e2e-review-inline-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Inline review test',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-review',
            role: 'user',
            content: 'Add a null check to the JSON parser.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-review',
            role: 'assistant',
            content: 'Added the null guard and a regression test for empty input.',
            toolCalls: [],
            review: {
              status: 'done',
              summary:
                'Reviewed the change to `src/parser.ts`. The null guard is correct and the new test covers the empty-input case. No issues found.',
              issuesFound: false,
            },
            createdAt: now + 1,
          },
          {
            id: 'msg-user-followup',
            role: 'user',
            content: 'Thanks — that looks right.',
            toolCalls: [],
            createdAt: now + 2,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 2,
      },
    ],
  })
}

/**
 * Thread with a completed two-model comparison for the inline-comparison-card
 * e2e. The comparison card mirrors the review card: it must render INSIDE the
 * scrolling `.messages-list` as its last child, with the two reviewer columns,
 * the judge synthesis, and the cost line all present.
 */
export function seedComparisonInlineFixture(workspaceRoot: string): void {
  const projectId = 'e2e-comparison-inline-project'
  const threadId = 'e2e-comparison-inline-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Inline comparison test',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-comparison',
            role: 'user',
            content: 'Add a null check to the JSON parser.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-comparison',
            role: 'assistant',
            content: 'Added the null guard and a regression test for empty input.',
            toolCalls: [],
            createdAt: now + 1,
          },
        ],
        comparison: {
          status: 'done',
          models: { a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' },
          reviewA:
            'The null guard in `src/parser.ts` is correct. Consider also handling a whitespace-only string.',
          reviewB:
            'Looks correct and the new test covers the empty-input case. No blocking issues.',
          synthesis:
            'Both agree the guard is correct. Only A flags whitespace-only input as an untested edge case — worth a quick follow-up test.',
          cost: '~$0.04',
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 1,
      },
    ],
  })
}

export function seedComparisonErrorFixture(workspaceRoot: string): void {
  const projectId = 'e2e-comparison-error-project'
  const threadId = 'e2e-comparison-error-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Failed comparison test',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-comparison-error',
            role: 'user',
            content: 'Add a null check to the JSON parser.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-comparison-error',
            role: 'assistant',
            content: 'Added the null guard and a regression test for empty input.',
            toolCalls: [],
            createdAt: now + 1,
          },
        ],
        comparison: {
          status: 'error',
          models: { a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' },
          reviewA: '',
          reviewB: '',
          synthesis: '',
          error: 'Model comparison failed: spend approval declined.',
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 1,
      },
    ],
  })
}

/** Thread with a completed CI investigator subagent tool card for visual validation. */
export function seedCiInvestigatorFixture(workspaceRoot: string): void {
  const projectId = 'e2e-ci-investigator-project'
  const threadId = 'e2e-ci-investigator-thread'
  const summary = [
    '**Failing check:** `CI / check`',
    '',
    '**Root cause:** `npm run typecheck` failed — `src/main/foo.ts:12` calls `bar()` with a missing argument.',
    '',
    '**Suggested fix:** pass the required `id` argument to `bar()` in `src/main/foo.ts`.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'CI investigator display test',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-ci',
            role: 'assistant',
            content: 'I investigated the failing CI and found the root cause.',
            toolCalls: [
              {
                id: 'tc-investigate-ci-1',
                name: 'investigate_ci',
                args: { pr_number: 42 },
                status: 'done',
                result: summary,
                subagent: {
                  id: 'sub-ci-1',
                  kind: 'investigate_ci',
                  status: 'done',
                  prompt: 'Investigate CI failures for PR #42',
                  summary,
                  messages: [
                    {
                      id: 'sub-ci-msg-1',
                      role: 'assistant',
                      content: 'Reading the **failing run logs** for PR #42.',
                      toolCalls: [
                        {
                          id: 'inner-run-list-1',
                          name: 'gh_run_list',
                          args: { failed_only: true },
                          status: 'done',
                          result: '#1234 CI: FAILURE (feature @ abcdef1)',
                        },
                        {
                          id: 'inner-run-view-1',
                          name: 'gh_run_view',
                          args: { run_id: 1234 },
                          status: 'done',
                          result: 'src/main/foo.ts(12,3): error TS2554: Expected 1 argument.',
                        },
                      ],
                    },
                    {
                      id: 'sub-ci-msg-2',
                      role: 'assistant',
                      content: summary,
                      toolCalls: [],
                    },
                  ],
                },
              },
            ],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

const GIT_CHANGES_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/git-changes-repo')

function buildLargeStagedFile(value: number): string {
  const lines = [
    '// Copyright notice',
    '// Baseline module used by git changes e2e',
    '',
    'export const metadata = { version: 1, kind: "demo" }',
  ]
  for (let i = 1; i <= 25; i++) {
    lines.push(`export function helper${i}(): number { return ${i}; }`)
  }
  lines.push(`export const value = ${value}`)
  for (let i = 26; i <= 50; i++) {
    lines.push(`export function helper${i}(): number { return ${i}; }`)
  }
  return `${lines.join('\n')}\n`
}

function initGitChangesFixtureRepo(): void {
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  mkdirSync(repoRoot, { recursive: true })
  rmSync(join(repoRoot, 'untracked.ts'), { force: true })
  writeFileSync(join(repoRoot, 'staged.ts'), buildLargeStagedFile(1), 'utf8')
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "old"\n', 'utf8')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')
}

/** Reset the committed git-changes fixture to staged + unstaged + untracked state. */
export function resetGitChangesFixtureState(): void {
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
  git('checkout', '-f', 'HEAD')
  git('clean', '-fd')
  writeFileSync(join(repoRoot, 'staged.ts'), buildLargeStagedFile(2), 'utf8')
  git('add', 'staged.ts')
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "new"\n', 'utf8')
  writeFileSync(join(repoRoot, 'untracked.ts'), 'export const fresh = true\n', 'utf8')
}

/**
 * Seeds the stable git-changes fixture as the active project. Returns the repo path.
 */
export function seedGitChangesFixture(): string {
  if (!existsSync(join(GIT_CHANGES_FIXTURE_ROOT, '.git'))) {
    initGitChangesFixtureRepo()
  }
  resetGitChangesFixtureState()
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  const projectId = 'e2e-git-changes-project'
  const threadId = 'e2e-git-changes-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: repoRoot, name: 'git-workspace' }],
    activeProjectId: projectId,
    workspaceRoot: repoRoot,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Git changes test',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })

  writeSettings({})

  return repoRoot
}

export function cleanupGitChangesFixture(repoRoot: string): void {
  if (repoRoot === GIT_CHANGES_FIXTURE_ROOT) {
    resetGitChangesFixtureState()
    return
  }
  rmSync(repoRoot, { recursive: true, force: true })
}

const GIT_IMAGE_FIXTURES = join(process.cwd(), 'tests/e2e/fixtures')

/**
 * Git repo with staged/unstaged/untracked image changes for the Changes panel
 * image preview e2e. Returns the repo path for cleanup.
 */
export function seedGitImageChangesFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'copse-panel-git-img-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })

  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')

  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'staged.png'))
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-blue.png'), join(repoRoot, 'unstaged.png'))
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')

  // Staged: red → blue.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-blue.png'), join(repoRoot, 'staged.png'))
  git('add', 'staged.png')

  // Unstaged: blue → red.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'unstaged.png'))

  // Untracked new image.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'new.png'))

  const projectId = 'e2e-git-image-changes-project'
  const threadId = 'e2e-git-image-changes-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: repoRoot, name: 'git-image-workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Git image changes test',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })

  return repoRoot
}

/** Long thread so the messages list overflows and scroll-to-bottom can be exercised. */
export function seedScrollToBottomFixture(workspaceRoot: string): void {
  const projectId = 'e2e-scroll-bottom-project'
  const threadId = 'e2e-scroll-bottom-thread'
  const messages = Array.from({ length: 24 }, (_, i) => {
    const isUser = i % 2 === 0
    const turn = Math.floor(i / 2) + 1
    return {
      id: `msg-scroll-${i}`,
      role: isUser ? 'user' : 'assistant',
      content: isUser
        ? `Question ${turn}: Can you explain part ${turn} of this feature in detail?`
        : `Answer ${turn}: Here is a detailed explanation for turn ${turn}. `.repeat(8),
      toolCalls: [],
      createdAt: Date.now() + i,
    }
  })

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Scroll to bottom test',
        status: 'idle',
        messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** One completed exchange plus a long history so scrolling up during streaming is meaningful. */
export function seedScrollStreamingFixture(workspaceRoot: string): void {
  const projectId = 'e2e-scroll-stream-project'
  const threadId = 'e2e-scroll-stream-thread'
  const history = Array.from({ length: 20 }, (_, i) => {
    const isUser = i % 2 === 0
    const turn = Math.floor(i / 2) + 1
    return {
      id: `msg-history-${i}`,
      role: isUser ? 'user' : 'assistant',
      content: isUser ? `Earlier question ${turn}` : `Earlier answer ${turn}: `.repeat(10),
      toolCalls: [],
      createdAt: Date.now() + i,
    }
  })
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Scroll while streaming',
        status: 'idle',
        messages: history,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

export function seedTodoPlanFixtures(workspaceRoot: string): {
  planThreadTitle: string
  noPlanThreadTitle: string
} {
  const projectId = 'e2e-todo-project'
  const planThreadId = 'e2e-todo-thread'
  const noPlanThreadId = 'e2e-todo-no-plan-thread'
  const planThreadTitle = 'Todo display test'
  const noPlanThreadTitle = 'No plan thread'
  const todos = [
    { id: 'todo-1', content: 'Refactor renderer.ts fence extraction', status: 'completed' },
    { id: 'todo-2', content: 'Add mermaid lazy loader + post-render hook', status: 'in_progress' },
    {
      id: 'todo-3',
      content: 'Add CSS, unit tests, and e2e coverage',
      status: 'pending',
      assignedModel: 'local',
      check: { kind: 'typecheck' },
    },
    { id: 'todo-4', content: 'Run npm run check + build/e2e', status: 'pending' },
    { id: 'todo-5', content: 'Create GitHub issue for diagram steering', status: 'pending' },
  ]
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: planThreadId,
        title: planThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-todo',
            role: 'user',
            content: 'Implement mermaid and open an issue for diagram steering.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-todo',
            role: 'assistant',
            content: 'Working through the plan.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        todos,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now() + 2,
        updatedAt: Date.now() + 2,
      },
      {
        id: noPlanThreadId,
        title: noPlanThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-no-plan',
            role: 'user',
            content: 'What files are in src/?',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-no-plan',
            role: 'assistant',
            content: 'I can list the src directory for you.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now() + 1,
        updatedAt: Date.now() + 1,
      },
    ],
  })
  return { planThreadTitle, noPlanThreadTitle }
}

/** Running thread with a queued follow-up message for edit / send-now e2e. */
export function seedQueuedMessageFixture(workspaceRoot: string): {
  threadId: string
  queuedMessageId: string
  queuedText: string
} {
  const projectId = 'e2e-queued-message-project'
  const threadId = 'e2e-queued-message-thread'
  const queuedMessageId = 'msg-user-queued'
  const queuedText = 'Then add unit tests for the parser.'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Queued message edit',
        status: 'running',
        messages: [
          {
            id: 'msg-user-first',
            role: 'user',
            content: 'Refactor the JSON parser.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-first',
            role: 'assistant',
            content: 'Working on the refactor now…',
            toolCalls: [],
            createdAt: now + 1,
          },
          {
            id: queuedMessageId,
            role: 'user',
            content: queuedText,
            toolCalls: [],
            createdAt: now + 2,
          },
        ],
        pendingMessages: [
          {
            messageId: queuedMessageId,
            payload: { content: queuedText, invokedSkills: [], priorTodos: [] },
            createdAt: now + 2,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 2,
      },
    ],
  })
  return { threadId, queuedMessageId, queuedText }
}

export function seedToolDisplayFixture(workspaceRoot: string): void {
  const projectId = 'e2e-tool-display-project'
  const threadId = 'e2e-tool-display-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    expandedProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Tool display test',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            content: 'Here is what I found in the repo.',
            toolCalls: [
              {
                id: 'tc-read-1',
                name: 'read_file',
                args: { path: 'README.md' },
                status: 'done',
                result: '# Copse\n',
              },
              {
                id: 'tc-list-1',
                name: 'list_dir',
                args: { path: 'src' },
                status: 'done',
                result: 'd main\nf index.ts',
              },
              {
                id: 'tc-read-2',
                name: 'read_file',
                args: { path: 'missing.txt' },
                status: 'error',
                result: 'Error: ENOENT',
              },
            ],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** Thread showing built-in browser tool cards (navigate/snapshot/screenshot/interact). */
export function seedBrowserToolsFixture(workspaceRoot: string): void {
  const projectId = 'e2e-browser-tools-project'
  const threadId = 'e2e-browser-tools-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Browser tools test',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-browser',
            role: 'user',
            content: 'Open the local dev server and check the heading renders.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-browser',
            role: 'assistant',
            content: 'Opened the page, read its accessibility snapshot, and captured a screenshot.',
            toolCalls: [
              {
                id: 'tc-browser-navigate',
                name: 'browser_navigate',
                args: { url: 'http://localhost:3000/' },
                status: 'done',
                result: 'Opened tab-1: Computer Use Demo\nhttp://localhost:3000/',
              },
              {
                id: 'tc-browser-snapshot',
                name: 'browser_snapshot',
                args: {},
                status: 'done',
                result:
                  'page: "Computer Use Demo"\nurl: http://localhost:3000/\n\n- heading "Welcome"\n- link "Docs" [ref=e1]\n- textbox "Search" [ref=e2]',
              },
              {
                id: 'tc-browser-screenshot',
                name: 'browser_screenshot',
                args: {},
                status: 'done',
                result: 'Saved screenshot of tab-1 to /tmp/browser-screenshots/tab-1.png',
              },
            ],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

export interface FooterBranchSeedIds {
  projectId: string
  matchThreadId: string
  mismatchThreadId: string
  currentBranch: string
  mismatchBranch: string
}

/**
 * Active blank thread plus two past threads to `@`-reference (#644). The picker
 * excludes the active thread and offers the other two.
 */
export function seedThreadReferenceFixture(workspaceRoot: string): {
  projectId: string
  activeThreadId: string
  refTitles: [string, string]
} {
  const projectId = 'e2e-thread-ref-project'
  const activeThreadId = 'e2e-thread-ref-active'
  const refTitles: [string, string] = ['Auth refactor plan', 'Docs cleanup']
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId,
    [`threads:${projectId}`]: [
      {
        id: activeThreadId,
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now + 2,
        updatedAt: now + 2,
      },
      {
        id: 'e2e-thread-ref-auth',
        title: refTitles[0],
        status: 'idle',
        messages: [
          {
            id: 'msg-ref-auth',
            role: 'user',
            content: 'How should we refactor the auth layer?',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now + 1,
        updatedAt: now + 1,
      },
      {
        id: 'e2e-thread-ref-docs',
        title: refTitles[1],
        status: 'idle',
        messages: [
          {
            id: 'msg-ref-docs',
            role: 'user',
            content: 'Clean up the README and docs index.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      },
    ],
  })
  return { projectId, activeThreadId, refTitles }
}

/** Two threads bound to different branches for footer branch / mismatch screenshots. */
export function seedFooterBranchFixture(workspaceRoot: string): FooterBranchSeedIds {
  const projectId = 'e2e-footer-branch-project'
  const matchThreadId = 'e2e-footer-branch-match'
  const mismatchThreadId = 'e2e-footer-branch-mismatch'
  const currentBranch = e2eGitBranch()
  const mismatchBranch = currentBranch === 'main' ? 'feature-branch' : 'main'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: matchThreadId,
        title: 'Matching branch',
        status: 'idle',
        gitBranch: currentBranch,
        messages: [
          {
            id: 'msg-user-match',
            role: 'user',
            content: 'Thread on the checked-out branch.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 1200, outputTokens: 400 },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: mismatchThreadId,
        title: 'Other branch',
        status: 'idle',
        gitBranch: mismatchBranch,
        messages: [
          {
            id: 'msg-user-mismatch',
            role: 'user',
            content: 'Thread started on a different branch.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 800, outputTokens: 200 },
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeThreadId: matchThreadId,
  })

  return {
    projectId,
    matchThreadId,
    mismatchThreadId,
    currentBranch,
    mismatchBranch,
  }
}

/** Blank new-thread composer for footer branch picker screenshots. */
export function seedFooterBranchPickerFixture(workspaceRoot: string): {
  projectId: string
  blankThreadId: string
  currentBranch: string
} {
  const projectId = 'e2e-footer-branch-picker-project'
  const blankThreadId = 'e2e-footer-branch-picker-blank'
  const currentBranch = e2eGitBranch()
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: blankThreadId,
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeThreadId: blankThreadId,
  })

  return { projectId, blankThreadId, currentBranch }
}

/** Single thread bound to a branch that differs from HEAD (mismatch footer screenshot). */
export function seedFooterBranchMismatchFixture(workspaceRoot: string): FooterBranchSeedIds {
  const projectId = 'e2e-footer-branch-project'
  const matchThreadId = 'e2e-footer-branch-match'
  const mismatchThreadId = 'e2e-footer-branch-mismatch'
  const currentBranch = e2eGitBranch()
  const mismatchBranch = currentBranch === 'main' ? 'feature-branch' : 'main'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: mismatchThreadId,
        title: 'Other branch',
        status: 'idle',
        gitBranch: mismatchBranch,
        messages: [
          {
            id: 'msg-user-mismatch',
            role: 'user',
            content: 'Thread started on a different branch.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 800, outputTokens: 200 },
        createdAt: now,
        updatedAt: now,
      },
    ],
  })

  return {
    projectId,
    matchThreadId,
    mismatchThreadId,
    currentBranch,
    mismatchBranch,
  }
}

export function seedComposerBranchWarningFixture(workspaceRoot: string): {
  projectId: string
  threadId: string
  mismatchBranch: string
} {
  const projectId = 'e2e-composer-branch-warning-project'
  const threadId = 'e2e-composer-branch-warning-thread'
  const mismatchBranch = 'feature/thread-branch'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Thread branch warning',
        status: 'idle',
        gitBranch: mismatchBranch,
        messages: [
          {
            id: 'msg-user-branch-warning',
            role: 'user',
            content: 'Continue this branch.',
            toolCalls: [],
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now,
      },
    ],
    activeThreadId: threadId,
  })

  return { projectId, threadId, mismatchBranch }
}

/** Table with glob paths in inline code + architecture list (Repo Core Files repro). */
export function seedMarkdownBoldGlobFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-bold-glob-project'
  const threadId = 'e2e-markdown-bold-glob-thread'
  const content = [
    '## Tests',
    '',
    '| Path | Role |',
    '| --- | --- |',
    '| **`src/**/*.test.ts`** | Unit tests (bundled by esbuild into `dist-test/`) |',
    '| **`tests/e2e/`** | WebdriverIO e2e tests (tool display, markdown rendering, etc.) |',
    '| **`tests/fixtures/`** | E2E test fixtures |',
    '',
    '## Key Supporting Files',
    '',
    '- **`README.md`** — Project overview, commands, layout',
    '- **`AGENTS.md`** — Detailed agent instructions: running headless, mock LLM, permission policy',
    '- **`vendor/`** — Bundled `gortex` binary (downloaded on `npm install`)',
    '',
    '## Architecture Notes',
    '',
    '- **No backend** — main process talks directly to LLM providers',
    '- **Persistence** via `electron-store` (JSON config under `~/Library/Application Support/copse-panel/` on macOS)',
    '- **LLM fallback**: `MockLLMProvider` when no API keys are set',
    '- **Shell permissions**: `src/main/services/permission-policy.ts` — macOS-only sandbox; other platforms use static analysis',
    '- **MCP host**: connects to MCP servers via `.cursor/mcp.json` or `~/.cursor/mcp.json`',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Repo core files overview',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-bold-glob',
            role: 'assistant',
            content,
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** PR-style draft table with narrow index/status columns and long branch names. */
export function seedMarkdownTableWrapFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-table-wrap-project'
  const threadId = 'e2e-markdown-table-wrap-thread'
  const content = [
    '### Draft (work in progress)',
    '',
    '| # | Title | Branch | Status |',
    '| --- | --- | --- | --- |',
    '| 296 | Screenshot validate: capture before/after tool-display grouping UI fix | `jkt/auto/queued-message-screenshot-eval-b2d1` | DRAFT |',
    '| 294 | Fix markdown table column wrapping in chat messages | `jkt/auto/markdown-table-wrapping-8760` | DRAFT |',
    '| 293 | Queued message composer badge polish | `jkt/auto/queued-message-badge` | DRAFT |',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Open draft PRs',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-table-wrap',
            role: 'assistant',
            content,
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/** 3-column table whose first column is a lone code span (e.g. a test name).
 * Regression for the first column shattering one character per line. */
export function seedMarkdownTableCodeFirstColumnFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-table-code-first-project'
  const threadId = 'e2e-markdown-table-code-first-thread'
  const content = [
    '### Remaining failures:',
    '',
    '| Test | Status | Reason |',
    '| --- | --- | --- |',
    '| `terminateProcessTree` | ❌ | Environment issue (process tree killing does not work in this test environment) |',
    '| `renderMarkdown` | ❌ | 3 subtests fail — the heading-level assertions in `renderer.test.ts` |',
    '| `sanitizeRenderedMarkdown` | ❌ | 1 subtest fails — the "is a no-op" test expects `<h2>` tags to survive sanitization |',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Remaining failures',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-table-code-first',
            role: 'assistant',
            content,
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/**
 * Two assistant turns on different primary-chat models. Labels must appear on
 * both bubbles (hidden when a thread stays on one model). Visual eval for
 * per-message model provenance in the transcript.
 */
export function seedMultiModelChatFixture(workspaceRoot: string): void {
  const projectId = 'e2e-multi-model-chat-project'
  const threadId = 'e2e-multi-model-chat-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: threadId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Multi-model chat',
        status: 'idle',
        model: 'lmstudio:qwen/qwen3.6-35b-a3b',
        messages: [
          {
            id: 'msg-user-1',
            role: 'user',
            content: 'Summarize the permission policy.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-1',
            role: 'assistant',
            content:
              'The shell permission gate auto-runs sandbox-contained commands on macOS and prompts for hard-external work.',
            model: 'claude-sonnet-4-6',
            toolCalls: [],
            createdAt: now + 1,
          },
          {
            id: 'msg-user-2',
            role: 'user',
            content: 'Now explain it more briefly.',
            toolCalls: [],
            createdAt: now + 2,
          },
          {
            id: 'msg-assistant-2',
            role: 'assistant',
            content: 'Sandbox-safe commands auto-run; anything that reaches outside prompts first.',
            model: 'lmstudio:qwen/qwen3.6-35b-a3b',
            toolCalls: [],
            createdAt: now + 3,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 3,
      },
    ],
  })
}

/**
 * C2 held-queue fixture: an idle thread with a **held** hook-originated pending
 * message (`autoDispatch: false`, decisions 5 & 16). The held state has no live
 * producer yet (async function hooks that emit `queueMessage` land in later
 * phases), so we seed the persisted queue shape directly — `pendingMessages`
 * round-trips through `meta.json` — to exercise the renderer's held badge +
 * Release affordance for a visual eval.
 */
export function seedHeldQueueFixture(workspaceRoot: string): void {
  const projectId = 'e2e-held-queue-project'
  const threadId = 'e2e-held-queue-thread'
  const heldMessageId = 'msg-held-hook'
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Held hook message',
        status: 'idle',
        currentEpoch: 'epoch-current',
        messages: [
          {
            id: 'msg-user-open',
            role: 'user',
            content: 'Refactor the auth module.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-reply',
            role: 'assistant',
            content: 'Done — the auth module is refactored.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: heldMessageId,
            role: 'user',
            content: 'You still have open todos — finish them before stopping.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        pendingMessages: [
          {
            messageId: heldMessageId,
            payload: { content: 'You still have open todos — finish them before stopping.' },
            createdAt: Date.now(),
            origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
            epoch: 'epoch-stale',
            autoDispatch: false,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

/**
 * Sidebar threads with open + merged GitHub PRs for the thread PR-status chip
 * eval. Relies on `COPSE_PANEL_MOCK_GH=1` fixtures (#42 open, #99 merged).
 */
export function seedThreadPrStatusFixture(workspaceRoot: string): {
  openThreadTitle: string
  mergedThreadTitle: string
  plainThreadTitle: string
} {
  const projectId = 'e2e-thread-pr-status-project'
  const openThreadTitle = 'Open PR thread'
  const mergedThreadTitle = 'Merged PR thread'
  const plainThreadTitle = 'No PR thread'
  const openPrUrl = 'https://github.com/copse-dev/copse-panel/pull/42'
  const mergedPrUrl = 'https://github.com/copse-dev/copse-panel/pull/99'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: 'e2e-pr-open-thread',
    [`threads:${projectId}`]: [
      {
        id: 'e2e-pr-open-thread',
        title: openThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-open-pr',
            role: 'assistant',
            content: `Opened [PR #42](${openPrUrl}) for review.`,
            createdAt: now,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'e2e-open-agent',
          prUrl: openPrUrl,
          repo: 'copse-dev/copse-panel',
          createdAt: now,
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'e2e-pr-merged-thread',
        title: mergedThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-merged-pr',
            role: 'assistant',
            content: `Landed [PR #99](${mergedPrUrl}).`,
            createdAt: now - 1000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        remoteAgentLink: {
          provider: 'cursor',
          agentId: 'e2e-merged-agent',
          prUrl: mergedPrUrl,
          repo: 'copse-dev/copse-panel',
          createdAt: now - 1000,
        },
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
      {
        id: 'e2e-pr-plain-thread',
        title: plainThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-plain',
            role: 'user',
            content: 'No pull request here.',
            createdAt: now - 2000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now - 2000,
        updatedAt: now - 2000,
      },
    ],
  })
  return { openThreadTitle, mergedThreadTitle, plainThreadTitle }
}

/**
 * Two idle threads for the running-status sidebar eval. A live mock turn flips
 * the selected thread to `running` — persisted `running` is cleared on load by
 * `resumePendingQueues`.
 */
export function seedThreadRunningStatusFixture(workspaceRoot: string): {
  runningThreadTitle: string
  idleThreadTitle: string
} {
  const projectId = 'e2e-thread-running-status-project'
  const runningThreadTitle = 'Agent working'
  const idleThreadTitle = 'Idle thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    activeThreadId: 'e2e-running-thread',
    [`threads:${projectId}`]: [
      {
        id: 'e2e-running-thread',
        title: runningThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-run',
            role: 'user',
            content: 'Keep working on the refactor.',
            toolCalls: [],
            createdAt: now,
          },
          {
            id: 'msg-assistant-run',
            role: 'assistant',
            content: 'Working on it…',
            toolCalls: [],
            createdAt: now + 1,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        updatedAt: now + 1,
      },
      {
        id: 'e2e-idle-thread',
        title: idleThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-idle',
            role: 'user',
            content: 'Earlier finished turn.',
            toolCalls: [],
            createdAt: now - 1000,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now - 1000,
        updatedAt: now - 1000,
      },
    ],
  })
  writeSettings({ model: 'claude-sonnet-4-6' })
  return { runningThreadTitle, idleThreadTitle }
}
