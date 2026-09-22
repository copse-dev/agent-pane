import { z } from 'zod'
import { defineTool } from '@shared/types'
import { GUI_APP_LAUNCH_TOOL_NAME, launchGuiApp } from '../services/exec/gui-app-launch.ts'

/**
 * Approval-gated host GUI-app launch.
 *
 * `run_shell` / `open` from the agent seatbelt cannot reach the macOS window
 * server (Mach-port rendezvous / LaunchServices helper fail with
 * `kLSUnknownErr` / bootstrap_check_in Permission denied). This tool asks the
 * user once, then launches through the same unsandboxed `/usr/bin/open` path
 * Copse uses for Xcode / Android Studio setup — so the approval is real and
 * the launch actually works.
 *
 * Prefer an isolated profile (`env.COPSE_PANEL_USER_DATA`,
 * `env.COPSE_WORKSPACE_DIR`) when launching another Copse instance so it does
 * not contend with the live session over SingletonLock.
 */
export const launchGuiAppTool = defineTool({
  name: GUI_APP_LAUNCH_TOOL_NAME,
  description:
    'Launch a macOS GUI application through Launch Services (`/usr/bin/open`) from the host process. ' +
    'Use this instead of `run_shell` / `make run` / `open` when the agent needs a real desktop app to appear — ' +
    'Electron, Xcode, browsers, or a branch build of Copse itself. Always requires user approval. ' +
    'Supports isolated profiles via `env` (e.g. COPSE_PANEL_USER_DATA, COPSE_WORKSPACE_DIR) and app argv via `args`. ' +
    'macOS only; not available on remote (SSH) workspaces.',
  parameters: z.object({
    target: z
      .string()
      .min(1)
      .describe(
        'Absolute path to a .app bundle (preferred), a path relative to the workspace, ' +
          'or an Application name for `open -a` (e.g. "Safari"). For a branch Copse build, ' +
          'pass the path to node_modules/.pnpm/electron@…/node_modules/electron/dist/Copse.app.',
      ),
    args: z
      .array(z.string())
      .optional()
      .describe(
        'Arguments forwarded to the app after `--args` (not to `open` itself). ' +
          'For Electron, typically the path to dist/main/index.js.',
      ),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Environment variables Launch Services injects into the app. ' +
          'Use COPSE_PANEL_USER_DATA and COPSE_WORKSPACE_DIR for an isolated Copse profile.',
      ),
    new_instance: z
      .boolean()
      .optional()
      .default(true)
      .describe('Open a new instance even if one is already running (open -n). Defaults to true.'),
  }),
  async execute({ target, args, env, new_instance }, signal) {
    const result = await launchGuiApp(
      {
        target,
        ...(args !== undefined ? { args } : {}),
        ...(env !== undefined ? { env } : {}),
        newInstance: new_instance,
      },
      signal,
    )
    if (!result.ok) throw new Error(result.error)
    return result.message
  },
})
