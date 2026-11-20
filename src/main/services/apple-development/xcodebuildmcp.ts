import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isElectronAppPackaged } from '../electron-app-runtime.ts'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { getActiveProjectId, getProjectRoot, getWorkspaceRoot } from '../workspace.ts'
import { storageGet } from '../storage/storage.ts'
import {
  isAppleDevelopmentProjectEnrolled,
  isAppleDevelopmentProjectSupported,
} from './apple-development-service.ts'

export const XCODEBUILD_MCP_SERVER_NAME = 'xcodebuildmcp'
export const XCODEBUILD_MCP_TOOL_PREFIX = `mcp__${XCODEBUILD_MCP_SERVER_NAME}__`

/**
 * Enable every workflow shipped by the pinned XcodeBuildMCP version. Unknown
 * workflow ids are ignored by older compatible releases, which keeps this list
 * forward-readable while package.json remains the reproducibility boundary.
 */
export const XCODEBUILD_MCP_WORKFLOWS = [
  'coverage',
  'debugging',
  'device',
  'doctor',
  'macos',
  'project-discovery',
  'project-scaffolding',
  'session-management',
  'simulator',
  'simulator-management',
  'swift-package',
  'ui-automation',
  'utilities',
  'workflow-discovery',
  'xcode-ide',
] as const

const PROVISIONING_TOOL_NAMES = new Set([
  'build_device',
  'build_run_device',
  'test_device',
  'build_macos',
  'build_run_macos',
  'test_macos',
  'build_sim',
  'build_run_sim',
  'test_sim',
])

/** Cold Xcode builds/tests legitimately exceed the MCP SDK's 60-second default. */
export function xcodeBuildMcpToolTimeoutMs(toolName: string): number | undefined {
  if (PROVISIONING_TOOL_NAMES.has(toolName)) return 20 * 60_000
  if (toolName === 'boot_sim') return 4 * 60_000
  return undefined
}

const ALLOW_PROVISIONING_UPDATES = '-allowProvisioningUpdates'

export function isXcodeBuildMcpToolName(toolName: string): boolean {
  return toolName.startsWith(XCODEBUILD_MCP_TOOL_PREFIX)
}

/**
 * The user approved automatic signing updates for Apple builds. Apply that
 * approval narrowly to XcodeBuildMCP tools which invoke xcodebuild, preserving
 * any caller-supplied extraArgs and avoiding duplicate flags.
 */
export function prepareXcodeBuildMcpArguments(toolName: string, args: unknown): unknown {
  if (!PROVISIONING_TOOL_NAMES.has(toolName) || !isRecord(args)) return args
  const rawExtraArgs = args['extraArgs']
  const extraArgs = Array.isArray(rawExtraArgs)
    ? rawExtraArgs.filter((value) => typeof value === 'string')
    : []
  if (extraArgs.includes(ALLOW_PROVISIONING_UPDATES)) return args
  return { ...args, extraArgs: [...extraArgs, ALLOW_PROVISIONING_UPDATES] }
}

interface XcodeBuildMcpConfigInput {
  root: string
  entryPath: string
  execPath: string
}

export function createXcodeBuildMcpConfig(input: XcodeBuildMcpConfigInput): McpServerConfig {
  return {
    name: XCODEBUILD_MCP_SERVER_NAME,
    transport: 'stdio',
    command: input.execPath,
    args: [input.entryPath, 'mcp'],
    cwd: input.root,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      XCODEBUILDMCP_ENABLED_WORKFLOWS: XCODEBUILD_MCP_WORKFLOWS.join(','),
      XCODEBUILDMCP_SENTRY_DISABLED: 'true',
    },
  }
}

function resolveXcodeBuildMcpEntry(): string {
  if (isElectronAppPackaged() && process.resourcesPath) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'xcodebuildmcp',
      'build',
      'cli.js',
    )
  }
  const requireFromApp = createRequire(join(process.cwd(), 'package.json'))
  return requireFromApp.resolve('xcodebuildmcp')
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root)
  } catch {
    return resolve(root)
  }
}

function matchingProject(workspace: string, requestedProjectId?: string): string | null {
  const expected = canonicalRoot(workspace)
  const matches = (id: string): boolean => {
    const root = getProjectRoot(id)
    return root !== null && canonicalRoot(root) === expected
  }
  // An admitted owner may never borrow a different project's enrollment.
  if (requestedProjectId !== undefined)
    return matches(requestedProjectId) ? requestedProjectId : null
  const active = getActiveProjectId()
  if (active && matches(active)) return active
  // Workspace selection and persisted navigation are separate IPC operations.
  // Resolve a unique matching registered project while that write catches up.
  const projects: unknown = storageGet('projects')
  if (!Array.isArray(projects)) return null
  const ids = new Set<string>()
  for (const project of projects) {
    if (
      isRecord(project) &&
      typeof project['id'] === 'string' &&
      project['id'].length > 0 &&
      typeof project['path'] === 'string' &&
      !(typeof project['sshHost'] === 'string' && project['sshHost'] !== '') &&
      canonicalRoot(project['path']) === expected
    )
      ids.add(project['id'])
  }
  return ids.size === 1 ? (ids.values().next().value ?? null) : null
}

/** Built-in server config for the requested workspace's explicitly enrolled owner. */
export function getXcodeBuildMcpConfig(
  workspace = getWorkspaceRoot(),
  requestedProjectId?: string,
): McpServerConfig | null {
  if (
    !workspace ||
    process.platform !== 'darwin' ||
    !getDefaultPluginRegistry().isEnabled(APPLE_DEVELOPMENT_PLUGIN_ID)
  )
    return null
  const projectId = matchingProject(workspace, requestedProjectId)
  if (
    !projectId ||
    !isAppleDevelopmentProjectEnrolled(projectId) ||
    !isAppleDevelopmentProjectSupported(projectId)
  ) {
    return null
  }
  const root = getProjectRoot(projectId)
  if (!root || canonicalRoot(root) !== canonicalRoot(workspace)) return null
  return createXcodeBuildMcpConfig({
    root,
    entryPath: resolveXcodeBuildMcpEntry(),
    execPath: process.execPath,
  })
}
