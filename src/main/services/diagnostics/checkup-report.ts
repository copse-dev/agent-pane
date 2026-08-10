// Pure report model for the Copse checkup ("doctor"). Kept free of Electron and
// service imports so the check logic and formatting are unit-testable from a
// plain snapshot. The Electron-touching gatherer lives in `checkup.ts`.

export type CheckupStatus = 'ok' | 'warn' | 'error'

/** One diagnosed aspect of the setup. */
export interface CheckupCheck {
  /** Stable id (also used to dedupe / test). */
  id: string
  /** Grouping label, e.g. "Models", "MCP". */
  category: string
  /** Short human label for the row. */
  label: string
  status: CheckupStatus
  /** What was found. */
  detail: string
  /** Suggested remediation, present on warn/error rows the user can act on. */
  fix?: string
}

export interface CheckupReport {
  checks: CheckupCheck[]
  counts: { ok: number; warn: number; error: number }
}

/** A single configured (or configurable) model provider. */
export interface ProviderSnapshot {
  id: string
  label: string
  /** Whether a usable key/config is present (env var, stored key, or local server). */
  configured: boolean
  /** How the key was found; null when not configured or not key-based (local). */
  source: 'env' | 'stored' | null
  /** true = OS-encrypted at rest, false = base64 plaintext, null = no stored key. */
  encrypted: boolean | null
  /**
   * Whether the stored key decrypts on this machine. `false` means ciphertext
   * sealed by another OS user's keychain — the usual cause is a profile restored
   * on a new machine. null when no key is stored.
   */
  readable: boolean | null
  /** Local server (LM Studio / Ollama / …) that needs no API key. */
  local: boolean
}

export interface ChatContextSnapshot {
  hasDecentChatDefault: boolean
  minimum: number
  bestAvailableContext: number | null
}

export interface McpSnapshot {
  name: string
  state: string
  toolCount: number
  error?: string
}

export interface CustomToolSnapshot {
  name: string
  source: string
  registered: boolean
  error?: string
}

/** Everything the pure report is built from. Gathered by `checkup.ts`. */
export interface CheckupSnapshot {
  version: string
  platform: string
  mockLlm: boolean
  workspace: { root: string | null; trusted: boolean }
  git: { available: boolean; branch: string | null }
  providers: ProviderSnapshot[]
  context: ChatContextSnapshot
  mcp: McpSnapshot[]
  skills: { total: number; bySource: Record<string, number> }
  customTools: CustomToolSnapshot[]
  semantic: { available: boolean; backend: string | null; bundled: boolean }
  permissions: { autoRun: boolean; mcpAutoAllowReadOnly: boolean; trustedCommandCount: number }
  /** Terminal helper: false = present but not executable, true = ok, null = indeterminate. */
  spawnHelperExecutable: boolean | null
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000).toString()}K`
  return n.toString()
}

function bySourceSummary(bySource: Record<string, number>): string {
  const parts = Object.entries(bySource)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${count.toString()} ${source}`)
  return parts.join(', ')
}

/**
 * Turn a gathered snapshot into an ordered list of checks. Pure: the same
 * snapshot always yields the same report, so the logic is fully unit-testable.
 */
export function buildCheckupReport(s: CheckupSnapshot): CheckupReport {
  const checks: CheckupCheck[] = []
  const add = (c: CheckupCheck): void => {
    checks.push(c)
  }

  // Copse itself.
  add({
    id: 'version',
    category: 'Copse',
    label: 'Version',
    status: 'ok',
    detail: `Copse ${s.version} on ${s.platform}`,
  })

  // Workspace + git.
  if (!s.workspace.root) {
    add({
      id: 'workspace',
      category: 'Workspace',
      label: 'Project folder',
      status: 'warn',
      detail: 'No folder is open.',
      fix: 'Open a project folder so the file, search, and git tools have a workspace to act on.',
    })
  } else {
    const trust = s.workspace.trusted ? 'trusted' : 'not trusted'
    let gitPart: string
    if (!s.git.available) gitPart = 'not a git repo'
    else if (s.git.branch) gitPart = `git branch ${s.git.branch}`
    else gitPart = 'git repo (detached HEAD)'
    add({
      id: 'workspace',
      category: 'Workspace',
      label: 'Project folder',
      status: 'ok',
      detail: `${s.workspace.root} — ${trust}, ${gitPart}`,
    })
  }

  // Models / providers.
  const configured = s.providers.filter((p) => p.configured)
  if (s.mockLlm) {
    add({
      id: 'providers',
      category: 'Models',
      label: 'LLM provider',
      status: 'ok',
      detail: 'Running with the built-in mock LLM (COPSE_PANEL_MOCK_LLM=1).',
    })
  } else if (configured.length === 0 && s.context.bestAvailableContext === null) {
    add({
      id: 'providers',
      category: 'Models',
      label: 'LLM provider',
      status: 'error',
      detail: 'No LLM provider is configured; the app will fall back to the mock model.',
      fix: 'Add an API key in Settings → API Keys (Anthropic, OpenAI, OpenRouter, …) or configure a local provider.',
    })
  } else {
    const names = configured
      .map((p) => {
        if (p.local) return `${p.label} (local)`
        return p.source ? `${p.label} (${p.source})` : p.label
      })
      .join(', ')
    add({
      id: 'providers',
      category: 'Models',
      label: 'LLM provider',
      status: 'ok',
      detail: `Configured: ${names || 'local models'}.`,
    })
  }

  // Ciphertext this machine holds no key for. `hasApiKey` still reports the key
  // as present, so without this the setup looks configured and every request
  // fails — the standard symptom of a profile restored on a new machine.
  for (const p of s.providers) {
    if (p.readable === false) {
      add({
        id: `key-unreadable-${p.id}`,
        category: 'Models',
        label: `${p.label} key at rest`,
        status: 'error',
        detail: `The stored ${p.label} API key cannot be decrypted on this machine. Keys are sealed with the OS keychain of the user that saved them, not with the Copse profile, so they do not survive a move to another machine or OS user.`,
        fix: `Re-enter the ${p.label} key in Settings → Providers, or provide it via its environment variable instead.`,
      })
    }
  }

  // Keys stored unencrypted (no OS keyring) — a real at-rest risk worth flagging.
  for (const p of s.providers) {
    if (p.encrypted === false) {
      add({
        id: `key-plaintext-${p.id}`,
        category: 'Models',
        label: `${p.label} key at rest`,
        status: 'warn',
        detail: `The stored ${p.label} API key is saved as base64 plaintext because no OS keyring is available.`,
        fix: 'Install and unlock a system keyring (e.g. gnome-keyring with libsecret on Linux), then re-save the key — or provide it via its environment variable instead of storing it.',
      })
    }
  }

  // Context window — only meaningful when a real (non-mock) model is reachable.
  if (!s.mockLlm && s.context.bestAvailableContext !== null && !s.context.hasDecentChatDefault) {
    add({
      id: 'context',
      category: 'Models',
      label: 'Context window',
      status: 'warn',
      detail: `The largest available model context is ${formatTokens(
        s.context.bestAvailableContext,
      )} tokens, below the recommended ${formatTokens(s.context.minimum)}.`,
      fix: 'Raise your local server’s context length (see docs/lm-studio-context-persistence.md) or add a larger-context provider.',
    })
  }

  // MCP servers.
  const mcpErrors = s.mcp.filter((m) => m.state === 'error')
  const mcpConnected = s.mcp.filter((m) => m.state === 'connected')
  // Project servers in an untrusted workspace are never spawned — they carry an
  // explanatory `error` but state 'untrusted', so treat them as their own warning
  // rather than letting them read as healthy (they didn't start).
  const mcpUntrusted = s.mcp.filter((m) => m.state === 'untrusted')
  if (s.mcp.length === 0) {
    add({
      id: 'mcp',
      category: 'MCP',
      label: 'MCP servers',
      status: 'ok',
      detail: 'No MCP servers configured.',
    })
  } else {
    for (const m of mcpErrors) {
      add({
        id: `mcp-${m.name}`,
        category: 'MCP',
        label: `MCP: ${m.name}`,
        status: 'error',
        detail: `Failed to connect: ${m.error ?? 'unknown error'}`,
        fix: 'Check the server command/URL and credentials in your mcp.json, then reload MCP servers in Settings → MCP servers.',
      })
    }
    for (const m of mcpUntrusted) {
      add({
        id: `mcp-${m.name}`,
        category: 'MCP',
        label: `MCP: ${m.name}`,
        status: 'warn',
        detail:
          m.error ??
          'Not started: this project-defined MCP server is blocked because the workspace is not trusted.',
        fix: 'Trust this workspace in Settings → MCP servers so its project servers can start (an untrusted, cloned repo cannot auto-run MCP servers).',
      })
    }
    const toolTotal = mcpConnected.reduce((sum, m) => sum + m.toolCount, 0)
    const parts = [`${mcpConnected.length.toString()} connected (${toolTotal.toString()} tools)`]
    if (mcpErrors.length > 0) parts.push(`${mcpErrors.length.toString()} failed`)
    if (mcpUntrusted.length > 0) parts.push(`${mcpUntrusted.length.toString()} blocked (untrusted)`)
    const problems = mcpErrors.length + mcpUntrusted.length
    add({
      id: 'mcp-summary',
      category: 'MCP',
      label: 'MCP servers',
      // Only "healthy" when nothing is broken, or at least something connected.
      status: problems === 0 || mcpConnected.length > 0 ? 'ok' : 'warn',
      detail: `${parts.join(', ')}.`,
    })
  }

  // Skills.
  add({
    id: 'skills',
    category: 'Skills',
    label: 'Skills',
    status: 'ok',
    detail:
      s.skills.total === 0
        ? 'No skills discovered.'
        : `${s.skills.total.toString()} discovered (${bySourceSummary(s.skills.bySource)}).`,
  })

  // Custom tools.
  const badTools = s.customTools.filter((t) => !t.registered || t.error)
  if (badTools.length > 0) {
    for (const t of badTools) {
      add({
        id: `custom-tool-${t.name}`,
        category: 'Custom tools',
        label: `Custom tool: ${t.name}`,
        status: 'warn',
        detail: `Failed to load from ${t.source}: ${t.error ?? 'unknown error'}`,
        fix: 'Fix the module so it default-exports a valid tool object (see docs/custom-tools.md), then reload.',
      })
    }
  } else if (s.customTools.length > 0) {
    add({
      id: 'custom-tools',
      category: 'Custom tools',
      label: 'Custom tools',
      status: 'ok',
      detail: `${s.customTools.length.toString()} loaded.`,
    })
  }

  // Semantic search.
  if (s.semantic.available) {
    const backend = s.semantic.backend ?? 'unknown'
    add({
      id: 'semantic',
      category: 'Search',
      label: 'Semantic search',
      status: 'ok',
      detail: `Available via ${backend}${s.semantic.bundled ? ' (bundled)' : ''}.`,
    })
  } else {
    add({
      id: 'semantic',
      category: 'Search',
      label: 'Semantic search',
      status: 'warn',
      detail: 'No semantic search backend is available; the agent falls back to text search.',
      fix: 'Reinstall to fetch the bundled gortex binary, or put a `gortex`/`vera` binary on your PATH.',
    })
  }

  // Permissions.
  add({
    id: 'permissions',
    category: 'Permissions',
    label: 'Command permissions',
    status: 'ok',
    detail: `Auto-run ${s.permissions.autoRun ? 'on' : 'off'}, ${s.permissions.trustedCommandCount.toString()} trusted command(s), MCP read-only auto-allow ${
      s.permissions.mcpAutoAllowReadOnly ? 'on' : 'off'
    }.`,
  })

  // Terminal (node-pty spawn-helper). Only flagged when we could positively
  // determine the helper is present but not executable.
  if (s.spawnHelperExecutable === false) {
    add({
      id: 'terminal',
      category: 'Terminal',
      label: 'Terminal helper',
      status: 'error',
      detail:
        "node-pty's spawn-helper is not executable; the integrated terminal will fail to launch.",
      fix: 'Run `SKIP_ELECTRON_REBUILD=1 node scripts/postinstall-native.mts` (or reinstall without ignore-scripts) to restore the execute bit.',
    })
  }

  const counts = { ok: 0, warn: 0, error: 0 }
  for (const c of checks) counts[c.status]++
  return { checks, counts }
}

const STATUS_MARK: Record<CheckupStatus, string> = { ok: '✓', warn: '!', error: '✗' }

/** Render a report as a compact, structured plain-text block for the agent to relay. */
export function formatCheckupReport(report: CheckupReport): string {
  const { counts } = report
  const summary = `Copse checkup — ${counts.error.toString()} error(s), ${counts.warn.toString()} warning(s), ${counts.ok.toString()} healthy`

  const sections: Array<{ title: string; status: CheckupStatus }> = [
    { title: 'ERRORS', status: 'error' },
    { title: 'WARNINGS', status: 'warn' },
    { title: 'HEALTHY', status: 'ok' },
  ]

  const lines: string[] = [summary]
  for (const { title, status } of sections) {
    const rows = report.checks.filter((c) => c.status === status)
    if (rows.length === 0) continue
    lines.push('', title)
    for (const c of rows) {
      lines.push(`${STATUS_MARK[c.status]} ${c.label}: ${c.detail}`)
      if (c.fix && status !== 'ok') lines.push(`  Fix: ${c.fix}`)
    }
  }
  return lines.join('\n')
}
