// Gathers the live Copse setup state and turns it into a checkup report. This is
// the Electron/service-touching half; the check logic and formatting live in the
// pure `checkup-report.ts` so they can be unit-tested from a plain snapshot.

import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  hasApiKey,
  isApiKeyEncrypted,
  isApiKeyReadable,
  isProviderAvailable,
  getSetting,
} from '../storage/settings.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isWorkspaceTrusted } from '../security/workspace-trust.ts'
import { isGitAvailable } from '../tool-availability.ts'
import { getCurrentBranchName, isInsideGitWorkTree } from '../github/git-service.ts'
import { getResolvedExtraProviders } from '../providers/extra-providers-store.ts'
import { evaluateChatDefaultContext } from '../providers/chat-default-context.ts'
import { getMcpServerStatuses } from '../mcp/mcp-registry.ts'
import { listSkills } from '../skills/skills-registry.ts'
import { getCustomToolStatuses } from '../mcp/custom-tools-registry.ts'
import {
  getSemanticBackend,
  isSemanticBackendBundled,
  isSemanticSearchAvailable,
} from '../search/semantic-index.ts'
import { TRUSTED_COMMANDS_SETTING, sanitizeTrustedCommands } from '@shared/command-routing.ts'
import {
  buildCheckupReport,
  formatCheckupReport,
  type CheckupReport,
  type CheckupSnapshot,
  type ProviderSnapshot,
} from './checkup-report.ts'
import { getElectronAppVersion, isElectronAppPackaged } from '../electron-app-runtime.ts'
import { unrepairableOpenFileFault } from '../acp/acp-resource-fault.ts'

export type { CheckupReport } from './checkup-report.ts'

/** Cloud providers we always report on (so "none configured" and per-key at-rest state surface). */
const FIXED_CLOUD_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'cursor', label: 'Cursor' },
]

function providerSnapshot(id: string, label: string): ProviderSnapshot {
  const stored = hasApiKey(id)
  const available = isProviderAvailable(id)
  return {
    id,
    label,
    local: false,
    configured: available,
    source: stored ? 'stored' : available ? 'env' : null,
    encrypted: stored ? isApiKeyEncrypted(id) : null,
    readable: stored ? isApiKeyReadable(id) : null,
  }
}

function gatherProviders(): ProviderSnapshot[] {
  const providers = FIXED_CLOUD_PROVIDERS.map((p) => providerSnapshot(p.id, p.label))
  const seen = new Set(providers.map((p) => p.id))
  // Extra OpenAI-compatible presets/customs — include only the cloud ones that
  // are actually configured (a key or env var). Local servers are usable without
  // a key and their real availability is reflected in the context-window check,
  // so listing every idle local preset here would just be noise.
  for (const extra of getResolvedExtraProviders()) {
    if (extra.local || seen.has(extra.id)) continue
    if (!hasApiKey(extra.id) && !isProviderAvailable(extra.id)) continue
    providers.push(providerSnapshot(extra.id, extra.label))
    seen.add(extra.id)
  }
  return providers
}

/** Walk a small prebuilds tree for a file named `spawn-helper`. */
function findSpawnHelper(root: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const entry of entries) {
    const path = join(root, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const nested = findSpawnHelper(path)
      if (nested) return nested
    } else if (entry === 'spawn-helper') {
      return path
    }
  }
  return null
}

/**
 * Whether node-pty's spawn-helper is executable. `false` = present but missing the
 * execute bit (terminal will fail to launch), `true` = ok, `null` = could not be
 * located (Windows has no spawn-helper; a packaging layout we don't recognise).
 *
 * node-pty ships with Copse, not with the project the user opened, so we resolve
 * the helper relative to the app — never `process.cwd()` in a packaged build,
 * which can be an arbitrary (or broken) unrelated directory the app was launched
 * from. In dev, resolve via Node's package resolution (works with pnpm isolated).
 */
function spawnHelperExecutable(): boolean | null {
  if (process.platform === 'win32') return null
  let prebuildsRoot: string | null
  if (isElectronAppPackaged()) {
    prebuildsRoot = process.resourcesPath
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
      : null
  } else {
    try {
      const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
      prebuildsRoot = join(dirname(requireFromApp.resolve('node-pty/package.json')), 'prebuilds')
    } catch {
      prebuildsRoot = null
    }
  }
  if (!prebuildsRoot) return null
  const helper = findSpawnHelper(prebuildsRoot)
  if (!helper) return null
  try {
    accessSync(helper, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Run every diagnostic and assemble the report. Each source fails soft to a safe default. */
/**
 * An external agent left stuck against the descriptor ceiling — recorded by the
 * session pool only once replacing the process failed to clear it, so it is a
 * standing condition rather than a blip.
 */
function agentOpenFilesSnapshot(): CheckupSnapshot['agentOpenFiles'] {
  const stuck = unrepairableOpenFileFault()
  if (!stuck) return null
  return { command: stuck.command, code: stuck.fault.code, limit: stuck.fault.limitLabel }
}

export async function runCheckup(): Promise<CheckupReport> {
  const root = getWorkspaceRoot()

  const gitAvailable = isGitAvailable() && (await isInsideGitWorkTree().catch(() => false))
  const branch = gitAvailable ? await getCurrentBranchName().catch(() => null) : null

  const context = await evaluateChatDefaultContext().catch(() => ({
    hasDecentChatDefault: true,
    minimum: 0,
    bestAvailableContext: null,
  }))

  const skills = listSkills()
  const bySource: Record<string, number> = {}
  for (const s of skills) bySource[s.source] = (bySource[s.source] ?? 0) + 1

  const trustedCommandCount = sanitizeTrustedCommands(
    getSetting<unknown>(TRUSTED_COMMANDS_SETTING, []),
  ).length

  const snapshot: CheckupSnapshot = {
    version: getElectronAppVersion(),
    platform: process.platform,
    mockLlm: process.env['COPSE_PANEL_MOCK_LLM'] === '1',
    workspace: { root, trusted: isWorkspaceTrusted(root) },
    git: { available: gitAvailable, branch },
    providers: gatherProviders(),
    context,
    mcp: getMcpServerStatuses().map((m) => ({
      name: m.name,
      state: m.state,
      toolCount: m.toolCount,
      ...(m.error !== undefined ? { error: m.error } : {}),
    })),
    skills: { total: skills.length, bySource },
    customTools: getCustomToolStatuses().map((t) => ({
      name: t.name,
      source: t.source,
      registered: t.registered,
      ...(t.error !== undefined ? { error: t.error } : {}),
    })),
    semantic: {
      available: isSemanticSearchAvailable(),
      backend: getSemanticBackend(),
      bundled: isSemanticBackendBundled(),
    },
    permissions: {
      autoRun: getSetting<boolean>('autoRunSandboxCommands', true),
      mcpAutoAllowReadOnly: getSetting<boolean>('mcpAutoAllowReadOnly', false),
      trustedCommandCount,
    },
    spawnHelperExecutable: spawnHelperExecutable(),
    agentOpenFiles: agentOpenFilesSnapshot(),
  }

  return buildCheckupReport(snapshot)
}

/** Run the checkup and render it as the plain-text block a tool returns. */
export async function runCheckupText(): Promise<string> {
  return formatCheckupReport(await runCheckup())
}
