import type { McpServerOrigin, McpServerStatus } from '@shared/types/mcp.ts'
import {
  type ToolPermissionCatalog,
  type ToolPermissionCatalogGroup,
  type ToolPermissionCatalogTool,
  type ToolPermissionPolicy,
  type ToolPermissionReset,
  type ToolPermissionUpdate,
} from '@shared/types/tool-permissions.ts'
import { CUSTOM_TOOL_PREFIX } from '../mcp/custom-tools-config.ts'
import { customToolRequiresApproval } from '../mcp/custom-tools-registry.ts'
import { MCP_TOOL_PREFIX, mcpToolName } from '../mcp/mcp-config.ts'
import type { ToolRegistry } from '../tool-registry.ts'
import { getSetting, updateSetting } from '../storage/settings.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { parseStringList } from '../storage/storage-schema.ts'

const TOOL_PERMISSION_OVERRIDES_SETTING = 'toolPermissionOverrides'
const LEGACY_MCP_GRANTS_STORAGE_KEY = 'mcp-remembered-grants'
const EMPTY_OVERRIDES: Record<string, ToolPermissionPolicy> = {}

const ALWAYS_ASK_TOOLS = new Set([
  'browser_navigate',
  'fetch_url',
  'parallel_search',
  'prepare_worktree',
  'run_background',
  'run_shell',
  'web_search',
  'gh_pr_approve',
  'gh_pr_create',
  'gh_pr_enable_auto_merge',
  'gh_pr_mark_ready',
  'gh_pr_rerun_failed_ci',
  'launch_gui_app',
])

const UNCONDITIONALLY_ASK_TOOLS = new Map<string, string>([
  [
    'prepare_worktree',
    'Worktree preparation must show its exact install and setup plan for every invocation.',
  ],
  ['gh_pr_approve', 'This action changes pull request state and must be approved each time.'],
  ['gh_pr_create', 'Creating a pull request changes remote state and must be approved each time.'],
  [
    'gh_pr_enable_auto_merge',
    'This action changes pull request state and must be approved each time.',
  ],
  ['gh_pr_mark_ready', 'This action changes pull request state and must be approved each time.'],
  ['gh_pr_rerun_failed_ci', 'This action changes remote CI state and must be approved each time.'],
  ['launch_gui_app', 'Launching a host GUI app leaves the sandbox and must be approved each time.'],
])

export interface McpPermissionTarget {
  serverName: string
  toolName: string
  origin: McpServerOrigin
  source?: string
  originDetail?: string
}

interface RegisteredPermissionTarget {
  id: string
  target: McpPermissionTarget
}

// MCP execution names use a historical delimiter format and can collide when a
// server or tool itself contains "__". Retain every candidate; a collision is
// deliberately unresolved so an override can never authorize the wrong tool.
const mcpTargetsByExecutionName = new Map<string, Map<string, RegisteredPermissionTarget>>()

function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value)
}

export function copseToolPermissionId(toolName: string): string {
  return `copse:${encodeIdentityPart(toolName)}`
}

export function mcpToolPermissionId(target: McpPermissionTarget): string {
  const source = target.source ?? target.originDetail ?? ''
  return [
    'mcp',
    target.origin,
    encodeIdentityPart(source),
    encodeIdentityPart(target.serverName),
    encodeIdentityPart(target.toolName),
  ].join(':')
}

export function registerMcpToolPermissionTarget(target: McpPermissionTarget): string {
  const executionName = mcpToolName(target.serverName, target.toolName)
  const id = mcpToolPermissionId(target)
  const candidates =
    mcpTargetsByExecutionName.get(executionName) ?? new Map<string, RegisteredPermissionTarget>()
  candidates.set(id, { id, target })
  mcpTargetsByExecutionName.set(executionName, candidates)
  return id
}

export function clearMcpToolPermissionTargets(): void {
  mcpTargetsByExecutionName.clear()
}

function registeredTarget(executionName: string): RegisteredPermissionTarget | null {
  const candidates = mcpTargetsByExecutionName.get(executionName)
  if (!candidates || candidates.size !== 1) return null
  return candidates.values().next().value ?? null
}

function permissionIdForExecution(executionName: string): string | null {
  if (!executionName.startsWith(MCP_TOOL_PREFIX)) return copseToolPermissionId(executionName)
  return registeredTarget(executionName)?.id ?? null
}

function permissionOverrides(): Record<string, ToolPermissionPolicy> {
  return getSetting(TOOL_PERMISSION_OVERRIDES_SETTING, EMPTY_OVERRIDES)
}

/**
 * Resolve an explicit override synchronously at the execution boundary.
 * null means the existing permission system must retain full authority.
 */
export function resolveToolPermission(
  executionName: string,
): { id: string; policy: ToolPermissionPolicy } | null {
  const id = permissionIdForExecution(executionName)
  if (id === null) return null
  const policy = permissionOverrides()[id]
  if (policy === undefined) return null
  return {
    id,
    policy:
      policy === 'allow' && unconditionalAskReason(executionName) !== undefined ? 'ask' : policy,
  }
}

export async function setToolPermissionForExecution(
  executionName: string,
  policy: ToolPermissionPolicy,
): Promise<boolean> {
  const id = permissionIdForExecution(executionName)
  if (id === null || (policy === 'allow' && unconditionalAskReason(executionName) !== undefined)) {
    return false
  }
  await updateSetting(TOOL_PERMISSION_OVERRIDES_SETTING, EMPTY_OVERRIDES, (current) => ({
    ...current,
    [id]: policy,
  }))
  return true
}

function humanizeToolName(name: string): string {
  return name
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

function defaultPolicy(executionName: string): ToolPermissionPolicy {
  return executionName.startsWith(MCP_TOOL_PREFIX) ||
    executionName.startsWith(CUSTOM_TOOL_PREFIX) ||
    ALWAYS_ASK_TOOLS.has(executionName)
    ? 'ask'
    : 'allow'
}

function unconditionalAskReason(executionName: string): string | undefined {
  const fixedReason = UNCONDITIONALLY_ASK_TOOLS.get(executionName)
  if (fixedReason !== undefined) return fixedReason
  return customToolRequiresApproval(executionName)
    ? 'This custom tool requires approval for every invocation.'
    : undefined
}

function catalogTool(
  id: string,
  executionName: string,
  name: string,
  description: string,
  overrides: Readonly<Record<string, ToolPermissionPolicy>>,
): ToolPermissionCatalogTool {
  const inherited = defaultPolicy(executionName)
  const disabledReason = unconditionalAskReason(executionName)
  const storedOverride = overrides[id]
  const override =
    storedOverride === 'allow' && disabledReason !== undefined ? 'ask' : storedOverride
  return {
    id,
    executionName,
    name,
    description,
    policy: override ?? inherited,
    defaultPolicy: inherited,
    overridden: override !== undefined,
    ...(disabledReason
      ? { disabledPolicies: ['allow'] as ToolPermissionPolicy[], disabledReason }
      : {}),
  }
}

function serverTarget(status: McpServerStatus, toolName: string): McpPermissionTarget {
  return {
    serverName: status.name,
    toolName,
    origin: status.origin,
    ...(status.source === undefined ? {} : { source: status.source }),
    ...(status.originDetail === undefined ? {} : { originDetail: status.originDetail }),
  }
}

function descriptionWithoutMcpPrefix(description: string, serverName: string): string {
  const prefix = `[MCP:${serverName}]`
  return description.startsWith(prefix) ? description.slice(prefix.length).trim() : description
}

export function listToolPermissionCatalog(
  registry: ToolRegistry,
  statuses: readonly McpServerStatus[],
): ToolPermissionCatalog {
  const overrides = permissionOverrides()
  const descriptors = registry.catalogTools()
  const byExecutionName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]))
  const nativeTools = descriptors
    .filter(({ name }) => !name.startsWith(MCP_TOOL_PREFIX))
    .map(({ name, description }) =>
      catalogTool(
        copseToolPermissionId(name),
        name,
        humanizeToolName(name),
        description,
        overrides,
      ),
    )
    .sort((left, right) => left.name.localeCompare(right.name))

  const groups: ToolPermissionCatalogGroup[] = []
  if (nativeTools.length > 0) {
    groups.push({ id: 'copse', name: 'Copse tools', kind: 'copse', tools: nativeTools })
  }

  for (const status of statuses) {
    const tools = status.tools
      .map((toolName) => {
        const target = serverTarget(status, toolName)
        const executionName = mcpToolName(status.name, toolName)
        const descriptor = byExecutionName.get(executionName)
        return catalogTool(
          mcpToolPermissionId(target),
          executionName,
          humanizeToolName(toolName),
          descriptor ? descriptionWithoutMcpPrefix(descriptor.description, status.name) : '',
          overrides,
        )
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    groups.push({
      id: `mcp-group:${mcpToolPermissionId(serverTarget(status, ''))}`,
      name: status.name,
      kind: 'mcp',
      origin: status.origin,
      ...(status.originDetail === undefined ? {} : { originDetail: status.originDetail }),
      status: status.state,
      tools,
    })
  }
  return { groups }
}

function selectedIds(
  catalog: ToolPermissionCatalog,
  requested: readonly string[],
  policy?: ToolPermissionPolicy,
): string[] {
  const tools = new Map(
    catalog.groups.flatMap((group) => group.tools.map((tool) => [tool.id, tool] as const)),
  )
  return [...new Set(requested)].filter((id) => {
    const tool = tools.get(id)
    return tool !== undefined && (policy === undefined || !tool.disabledPolicies?.includes(policy))
  })
}

export async function updateToolPermissions(
  registry: ToolRegistry,
  statuses: readonly McpServerStatus[],
  update: ToolPermissionUpdate,
): Promise<ToolPermissionCatalog> {
  const catalog = listToolPermissionCatalog(registry, statuses)
  const ids = selectedIds(catalog, update.toolIds, update.policy)
  if (ids.length > 0) {
    await updateSetting(TOOL_PERMISSION_OVERRIDES_SETTING, EMPTY_OVERRIDES, (current) => {
      const next = { ...current }
      for (const id of ids) next[id] = update.policy
      return next
    })
  }
  return listToolPermissionCatalog(registry, statuses)
}

export async function resetToolPermissions(
  registry: ToolRegistry,
  statuses: readonly McpServerStatus[],
  reset: ToolPermissionReset,
): Promise<ToolPermissionCatalog> {
  const catalog = listToolPermissionCatalog(registry, statuses)
  const ids = selectedIds(catalog, reset.toolIds)
  if (ids.length > 0) {
    const selected = new Set(ids)
    await updateSetting(TOOL_PERMISSION_OVERRIDES_SETTING, EMPTY_OVERRIDES, (current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !selected.has(id))),
    )
  }
  return listToolPermissionCatalog(registry, statuses)
}

/**
 * Move legacy MCP grants into source-scoped identities after a full server load.
 * A delimiter collision leaves multiple candidates and is intentionally kept
 * unmigrated; it must never authorize whichever registration happened last.
 */
export async function migrateLegacyMcpToolGrants(): Promise<void> {
  const legacy = parseStringList(storageGet(LEGACY_MCP_GRANTS_STORAGE_KEY))
  if (legacy.length === 0) return
  const migrations = new Map<string, string>()
  for (const executionName of legacy) {
    const target = registeredTarget(executionName)
    if (target) migrations.set(executionName, target.id)
  }
  if (migrations.size === 0) return
  await updateSetting(TOOL_PERMISSION_OVERRIDES_SETTING, EMPTY_OVERRIDES, (current) => {
    const next = { ...current }
    for (const id of migrations.values()) next[id] ??= 'allow'
    return next
  })
  await storageUpdate(LEGACY_MCP_GRANTS_STORAGE_KEY, (raw) =>
    parseStringList(raw).filter((executionName) => !migrations.has(executionName)),
  )
}
