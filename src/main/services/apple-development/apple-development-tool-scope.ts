import { APPLE_DEVELOPMENT_TOOL_NAMES } from '@copse/agent/plugins/apple-development-plugin.ts'
import {
  isAppleDevelopmentProjectEnrolled,
  isAppleDevelopmentProjectSupported,
} from './apple-development-service.ts'
import { isXcodeBuildMcpToolName } from './xcodebuildmcp.ts'

const NATIVE_APPLE_TOOL_NAMES: ReadonlySet<string> = new Set(APPLE_DEVELOPMENT_TOOL_NAMES)

/**
 * Tools that only make sense for an Apple project: the plugin's own native
 * tools (the Simulator bridge) and everything served by the bundled
 * XcodeBuildMCP server.
 */
export function isAppleDevelopmentToolName(toolName: string): boolean {
  return NATIVE_APPLE_TOOL_NAMES.has(toolName) || isXcodeBuildMcpToolName(toolName)
}

/**
 * The tool registry is process-wide, so enabling the Apple plugin registers its
 * tools for every thread. Tool lists offered to a model are scoped per turn
 * instead: Apple tools reach only a project that is enrolled and runs on a
 * local macOS host. Every other tool passes through unchanged.
 */
export function isAppleDevelopmentToolOffered(
  toolName: string,
  projectId: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isAppleDevelopmentToolName(toolName)) return true
  return (
    projectId !== undefined &&
    isAppleDevelopmentProjectEnrolled(projectId) &&
    isAppleDevelopmentProjectSupported(projectId, platform)
  )
}
