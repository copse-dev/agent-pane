import { createRequire } from 'node:module'
import { join } from 'node:path'
import { isElectronAppPackaged } from '../electron-app-runtime.ts'
import type { McpServerConfig } from '@shared/types/mcp.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { getActiveProjectId, getProjectRoot } from '../workspace.ts'
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

/** Built-in server config for the currently active, explicitly enrolled project. */
export function getXcodeBuildMcpConfig(): McpServerConfig | null {
  const projectId = getActiveProjectId()
  if (
    !projectId ||
    process.platform !== 'darwin' ||
    !getDefaultPluginRegistry().isEnabled(APPLE_DEVELOPMENT_PLUGIN_ID) ||
    !isAppleDevelopmentProjectEnrolled(projectId) ||
    !isAppleDevelopmentProjectSupported(projectId)
  ) {
    return null
  }
  const root = getProjectRoot(projectId)
  if (!root) return null
  return createXcodeBuildMcpConfig({
    root,
    entryPath: resolveXcodeBuildMcpEntry(),
    execPath: process.execPath,
  })
}
