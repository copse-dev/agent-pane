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
 * Launch another Copse instance with an isolated `env.COPSE_DIR` so it does not
 * share stores with, or lose the SingletonLock to, the live session. See
 * docs/agent-development.md#launching-copse-from-a-copse-agent-session.
 */
export const launchGuiAppTool = defineTool({
  name: GUI_APP_LAUNCH_TOOL_NAME,
  description:
    'Launch a macOS GUI application through Launch Services (`/usr/bin/open`) from the host process. ' +
    'Use this instead of `run_shell` / `make run` / `open` when the agent needs a real desktop app to appear — ' +
    'Electron, Xcode, browsers, or a branch build of Copse itself. Always requires user approval. ' +
    'The app starts in `/`, so paths in `args` must be absolute. ' +
    'For a Copse branch build, run `make build` first and always set `env.COPSE_DIR` to a fresh directory. ' +
    'macOS only; not available on remote (SSH) workspaces.',
  parameters: z.object({
    target: z
      .string()
      .min(1)
      .describe(
        'Absolute path to a .app bundle (preferred), a path relative to the workspace, ' +
          'or an Application name for `open -a` (e.g. "Safari"). For a branch Copse build, ' +
          'pass the output of `realpath node_modules/electron/dist/Copse.app`.',
      ),
    args: z
      .array(z.string())
      .optional()
      .describe(
        'Arguments forwarded to the app after `--args` (not to `open` itself). ' +
          'Use absolute paths. For Electron, typically the absolute path to dist/main/index.js.',
      ),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Environment variables Launch Services injects into the app. ' +
          'For a Copse instance, set COPSE_DIR to a fresh directory so every store is isolated.',
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
