import { access, constants as fsConstants } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { runAppProcess } from '../app-run/app-run-process.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'

/**
 * Launch a macOS GUI app through Launch Services (`/usr/bin/open`) from the
 * host process — not as a child of the agent's sandboxed seatbelt.
 *
 * A sandboxed or seatbelt-spawned Electron/`open` call cannot reach the window
 * server (Mach-port rendezvous / LaunchServices helper). This path is the one
 * Copse's own app-run setup uses for Xcode / Android Studio: unsandboxed
 * `runAppProcess` of `/usr/bin/open`, with env vars and `--args` forwarded so
 * the agent can isolate a branch instance via `COPSE_PANEL_USER_DATA`.
 *
 * Approval is the caller's job (see `launch_gui_app` tool). This module only
 * validates the target and performs the launch once authorized.
 */

export const GUI_APP_LAUNCH_TOOL_NAME = 'launch_gui_app'

export interface GuiAppLaunchRequest {
  /** Absolute path to a .app bundle, or an Application name for `open -a`. */
  target: string
  /** Optional argv after `--args` (passed to the app, not to `open`). */
  args?: readonly string[]
  /** Optional environment variables Launch Services injects into the app. */
  env?: Readonly<Record<string, string>>
  /** Open a new instance even if one is already running (`open -n`). */
  newInstance?: boolean
}

export type GuiAppLaunchResult = { ok: true; message: string } | { ok: false; error: string }

const MAX_ENV_ENTRIES = 32
const MAX_ENV_KEY_CHARS = 128
const MAX_ENV_VALUE_CHARS = 4_096
const MAX_ARG_CHARS = 4_096
const MAX_ARGS = 64

function isSafeEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length <= MAX_ENV_KEY_CHARS
}

function isSafeEnvValue(value: string): boolean {
  // Reject NULs and control characters other than tab; Launch Services env is
  // not a shell, but we still refuse anything that would look like injection.
  return value.length <= MAX_ENV_VALUE_CHARS && !/[\0-\x08\x0a-\x1f\x7f]/.test(value)
}

/**
 * Build the `/usr/bin/open` argv for a validated request. Exported for tests so
 * the shape of the Launch Services call is asserted without spawning.
 */
export function buildOpenArgv(request: GuiAppLaunchRequest): string[] {
  const argv: string[] = []
  if (request.newInstance !== false) argv.push('-n')
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!isSafeEnvKey(key) || !isSafeEnvValue(value)) {
      throw new Error(`Refusing unsafe environment entry: ${key}`)
    }
    argv.push('--env', `${key}=${value}`)
  }
  const target = request.target.trim()
  if (!target) throw new Error('A target app path or name is required.')
  if (target.includes('\0')) throw new Error('Target must not contain NUL bytes.')
  if (target.endsWith('.app') || target.includes('/')) {
    // Bundle path (or any path): pass as a positional argument to `open`.
    argv.push(target)
  } else {
    // Bare Application name: `open -a Name`.
    argv.push('-a', target)
  }
  const appArgs = request.args ?? []
  if (appArgs.length > MAX_ARGS) {
    throw new Error(`At most ${String(MAX_ARGS)} app arguments are allowed.`)
  }
  if (appArgs.length > 0) {
    argv.push('--args')
    for (const arg of appArgs) {
      if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\0')) {
        throw new Error('App arguments must be plain strings without NUL bytes.')
      }
      argv.push(arg)
    }
  }
  return argv
}

async function resolveTargetPath(target: string, cwd: string): Promise<string> {
  const trimmed = target.trim()
  if (!trimmed) throw new Error('A target app path or name is required.')
  // Bare Application names (`Safari`, `Copse`) are resolved by Launch Services.
  if (!trimmed.includes('/') && !trimmed.endsWith('.app')) return trimmed
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
  try {
    await access(absolute, fsConstants.R_OK)
  } catch {
    throw new Error(`App not found or not readable: ${absolute}`)
  }
  return absolute
}

/**
 * Validate and launch. Returns a structured result so the tool can report
 * platform / remote / missing-target errors without throwing past the gate.
 */
export async function launchGuiApp(
  request: GuiAppLaunchRequest,
  signal: AbortSignal,
): Promise<GuiAppLaunchResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error:
        'launch_gui_app is only available on macOS (Launch Services). ' +
        'On other platforms, ask the user to open the app themselves.',
    }
  }
  if (isActiveSshWorkspace()) {
    return {
      ok: false,
      error:
        'launch_gui_app cannot open a GUI app on a remote (SSH) workspace. ' +
        'Open the app on the remote host yourself, or switch to a local workspace.',
    }
  }
  const cwd = getAgentExecutionRoot()
  if (!cwd) return { ok: false, error: 'No workspace open.' }

  const envEntries = Object.entries(request.env ?? {})
  if (envEntries.length > MAX_ENV_ENTRIES) {
    return {
      ok: false,
      error: `At most ${String(MAX_ENV_ENTRIES)} environment variables are allowed.`,
    }
  }
  for (const [key, value] of envEntries) {
    if (!isSafeEnvKey(key) || typeof value !== 'string' || !isSafeEnvValue(value)) {
      return { ok: false, error: `Refusing unsafe environment entry: ${key}` }
    }
  }

  let resolvedTarget: string
  try {
    resolvedTarget = await resolveTargetPath(request.target, cwd)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  let argv: string[]
  try {
    argv = buildOpenArgv({ ...request, target: resolvedTarget })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    // Unsandboxed: Launch Services must talk to the window server. The same
    // path app-run uses for opening Xcode / Android Studio from setup IPC.
    await runAppProcess('/usr/bin/open', argv, cwd, signal, { timeoutMs: 30_000 })
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const instance = request.newInstance === false ? '' : ' (new instance)'
  return {
    ok: true,
    message: `Launched ${resolvedTarget}${instance} via Launch Services.`,
  }
}
